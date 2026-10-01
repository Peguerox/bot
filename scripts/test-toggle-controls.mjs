// Offline regression tests: no environment files, database connections, or exchange calls.
// Run with: node --test scripts/test-toggle-controls.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worker = "lighter_btc_initial_state";
const long = "lighter_btc_optimal_state";
const short = "lighter_stoch_dca_btc_state";

function loadRoute(route, readResult, writeResults = {}) {
  const writes = [];
  const sb = {
    from(table) {
      let patch;
      const query = {
        select() { return query; },
        eq() { return query; },
        update(value) { patch = value; writes.push({ table, patch }); return query; },
        async single() {
          return patch
            ? (writeResults[table] ?? { data: { enabled: patch.enabled }, error: null })
            : readResult;
        },
      };
      return query;
    },
  };
  const code = ts.transpileModule(readFileSync(resolve(root, route), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const sandbox = {
    exports: {},
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } };
      if (name === "@/lib/supabase-admin") return { getSupabaseAdmin: () => sb };
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  vm.runInNewContext(code, sandbox);
  return { post: () => sandbox.exports.POST({ json: async () => ({ table: worker }) }), writes };
}

for (const [name, route, tables] of [
  ["worker", "app/api/lighter-btc-toggle/route.ts", [worker]],
  ["hedge", "app/api/lighter-hedge-toggle/route.ts", [long, short]],
]) {
  for (const [label, readResult] of [
    ["database read fails", { data: null, error: { message: "unavailable" } }],
    ["state row is missing", { data: null, error: null }],
    ["enabled is unknown", { data: { enabled: null }, error: null }],
  ]) {
    test(`${name}: ${label} never issues a write`, async () => {
      const harness = loadRoute(route, readResult);
      assert.equal((await harness.post()).status, 500);
      assert.equal(harness.writes.length, 0);
    });
  }
  for (const enabled of [true, false]) {
    test(`${name}: a confirmed ${enabled ? "OFF" : "ON"} change succeeds`, async () => {
      const harness = loadRoute(route, { data: { enabled }, error: null });
      const response = await harness.post();
      assert.equal(response.status, 200);
      assert.equal(response.body.enabled, !enabled);
      assert.deepEqual(harness.writes.map((w) => w.table), tables);
      assert.ok(harness.writes.every((w) => w.patch.enabled === !enabled));
      if (name === "worker" && !enabled) {
        assert.equal(harness.writes[0].patch.real_trading_locked, true);
        assert.equal(harness.writes[0].patch.paper_consecutive_tps, 0);
      }
    });
  }
  for (const table of tables) {
    for (const [label, result] of [
      ["write error", { data: null, error: { message: "write failed" } }],
      ["no matching row", { data: null, error: null }],
      ["wrong returned state", { data: { enabled: true }, error: null }],
    ]) {
      test(`${name}: ${table} ${label} cannot report success`, async () => {
        const harness = loadRoute(route, { data: { enabled: true }, error: null }, { [table]: result });
        const response = await harness.post();
        assert.equal(response.status, 500);
        if (name === "hedge") assert.match(response.body.error, /One leg may have changed/);
      });
    }
  }
}

// Execute the actual button handlers with a fake browser and fetch, including transport errors.
const page = ts.createSourceFile("page.tsx", readFileSync(resolve(root, "app/page.tsx"), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "handleToggle") handlers.push(node.getText(page));
  ts.forEachChild(node, visit);
}
visit(page);
assert.equal(handlers.length, 2);
handlers.forEach((source, index) => {
  for (const mode of ["success", "server error", "network error", "refresh error"]) {
    test(`button ${index + 1}: ${mode} releases the busy state`, async () => {
      const busy = [], alerts = [];
      let refreshes = 0;
      const sandbox = {
        enabled: true, title: "Test bot", table: worker,
        confirm: () => true,
        alert: (message) => alerts.push(message),
        setToggling: (value) => busy.push(value),
        fetch: async () => {
          if (mode === "network error") throw new Error("offline");
          return { ok: mode !== "server error", json: async () => ({ error: "Database unavailable" }) };
        },
        onToggled: async () => {
          refreshes++;
          if (mode === "refresh error") throw new Error("refresh failed");
        },
      };
      vm.runInNewContext(ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2020 },
      }).outputText, sandbox);
      await sandbox.handleToggle();
      assert.deepEqual(busy, [true, false]);
      assert.equal(alerts.length, mode === "success" ? 0 : 1);
      assert.equal(refreshes, mode === "network error" ? 0 : 1);
      if (mode === "server error") assert.equal(alerts[0], "Database unavailable");
    });
  }
});
