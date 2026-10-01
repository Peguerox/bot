// Offline regression tests; no database credentials or network calls.
// Run: node --test scripts/test-hedge-reset.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const long = "lighter_btc_optimal_state", short = "lighter_stoch_dca_btc_state";
const flat = { side: null, enabled: false, close_requested: false, seed_usd: 10, realized_pnl_usd: 0, history_reset_at: null };
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function resetHarness({ states = {}, readErrors = {}, writeErrors = {}, beforeWrite, failRead = false, serializeBalance = v => v } = {}) {
  const rows = { [long]: { ...flat, ...states[long] }, [short]: { ...flat, ...states[short] } };
  const writes = [];
  const sandbox = {
    exports: {},
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } };
      if (name !== "@/lib/supabase-admin") throw new Error(`Unexpected import: ${name}`);
      return { getSupabaseAdmin: () => ({
        from(table) {
          assert.ok(table === long || table === short, "Reset must never touch a trade table");
          let patch;
          const filters = [];
          const query = {
            select() { return query; },
            eq(key, value) { if (key !== "id") filters.push([key, value]); return query; },
            is(key, value) { filters.push([key, value]); return query; },
            gte(key, value) { filters.push([key, value, "gte"]); return query; },
            lte(key, value) { filters.push([key, value, "lte"]); return query; },
            update(value) { patch = value; return query; },
            async single() {
              if (!patch) {
                if (failRead) throw new Error("network down");
                const data = structuredClone(rows[table]);
                for (const key of ["seed_usd", "realized_pnl_usd"]) data[key] = serializeBalance(data[key]);
                return { data: readErrors[table] ? null : data, error: readErrors[table] ?? null };
              }
              writes.push({ table, patch, filters });
              beforeWrite?.(table, rows);
              if (writeErrors[table] === "network") throw new Error("network down");
              if (writeErrors[table]) return { data: null, error: { message: "write failed" } };
              if (!filters.every(([key, value, op]) => op === "gte" ? rows[table][key] >= value
                  : op === "lte" ? rows[table][key] <= value
                  : rows[table][key] === value)) return { data: null, error: { message: "No matching row" } };
              Object.assign(rows[table], patch);
              return { data: structuredClone(rows[table]), error: null };
            },
          };
          return query;
        },
      }) };
    },
  };
  vm.runInNewContext(compile(readFileSync(resolve(root, "app/api/lighter-hedge-reset/route.ts"), "utf8")), sandbox);
  return { post: sandbox.exports.POST, rows, writes };
}

test("reset preserves equity, never touches trades, and stamps the same cutoff on both legs", async () => {
  const h = resetHarness({ states: { [long]: { realized_pnl_usd: 1.25 }, [short]: { realized_pnl_usd: -0.5 } } });
  const r = await h.post();
  assert.equal(r.status, 200);
  assert.equal(h.rows[long].seed_usd, 11.25);
  assert.equal(h.rows[short].seed_usd, 9.5);
  for (const row of Object.values(h.rows)) {
    assert.equal(row.realized_pnl_usd, 0);
    assert.equal(row.enabled, false);
    assert.equal(row.history_reset_at, r.body.historyResetAt);
  }
  assert.equal(h.writes.length, 2);
  const again = await h.post();
  assert.equal(again.status, 200);
  assert.equal(h.rows[long].seed_usd, 11.25, "A repeated reset must not count PnL twice");
  assert.equal(h.rows[short].seed_usd, 9.5);
});

for (const table of [long, short]) {
  test(`${table}: unreadable state or missing migration prevents every write`, async () => {
    const h = resetHarness({ readErrors: { [table]: { message: "missing history_reset_at" } } });
    assert.equal((await h.post()).status, 500);
    assert.equal(h.writes.length, 0);
  });
  for (const [label, state] of [
    ["open", { side: "long" }], ["enabled", { enabled: true }],
    ["close pending", { close_requested: true }], ["unknown enabled", { enabled: null }],
    ["unknown side", { side: undefined }],
  ]) {
    test(`${table}: ${label} prevents every write`, async () => {
      const h = resetHarness({ states: { [table]: state } });
      assert.equal((await h.post()).status, 409);
      assert.equal(h.writes.length, 0);
    });
  }
  for (const value of [null, "10", NaN, Infinity]) {
    test(`${table}: invalid balance ${String(value)} prevents every write`, async () => {
      const h = resetHarness({ states: { [table]: { seed_usd: value } } });
      assert.equal((await h.post()).status, 500);
      assert.equal(h.writes.length, 0);
    });
  }
  for (const error of ["database", "network"]) {
    test(`${table}: ${error} write failure reports an incomplete reset`, async () => {
      const h = resetHarness({ writeErrors: { [table]: error } });
      const r = await h.post();
      assert.equal(r.status, 500);
      assert.match(r.body.error, /One leg may have reset/);
      assert.equal(h.rows[table].history_reset_at, null);
    });
  }
  for (const change of [{ enabled: true }, { side: "short" }, { seed_usd: 20 }, { realized_pnl_usd: 2 }, { close_requested: true }]) {
    test(`${table}: a state change between read and write is never overwritten`, async () => {
      const h = resetHarness({ beforeWrite: (name, rows) => { if (name === table) Object.assign(rows[name], change); } });
      assert.equal((await h.post()).status, 500);
      assert.equal(h.rows[table].history_reset_at, null);
      for (const [key, value] of Object.entries(change)) assert.equal(h.rows[table][key], value);
    });
  }
}
test("read transport errors produce an actionable failure and no writes", async () => {
  const h = resetHarness({ failRead: true });
  assert.equal((await h.post()).status, 500);
  assert.equal(h.writes.length, 0);
});

test("reset tolerates PostgreSQL float serialization rounding", async () => {
  const balance = 0.009301999999998127;
  const h = resetHarness({ states: { [long]: { realized_pnl_usd: balance } }, serializeBalance: v => Number(v.toPrecision(15)) });
  assert.notEqual(Number(balance.toPrecision(15)), balance);
  assert.equal((await h.post()).status, 200);
  const write = h.writes.find(w => w.table === long);
  assert.ok(write.filters.some(([key, value, op]) => key === "realized_pnl_usd" && op === "gte" && value <= balance));
  assert.equal(h.rows[long].realized_pnl_usd, 0);
});

test("reset rejects a balance change much smaller than a cent", async () => {
  const h = resetHarness({ beforeWrite: (table, rows) => { if (table === long) rows[long].realized_pnl_usd += 1e-10; } });
  assert.equal((await h.post()).status, 500);
  assert.equal(h.rows[long].history_reset_at, null);
});

const page = ts.createSourceFile("page.tsx", readFileSync(resolve(root, "app/page.tsx"), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const resets = [], filters = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "handleReset"
      && node.getText(page).includes("/api/lighter-hedge-reset")) resets.push(node.getText(page));
  if (ts.isArrowFunction(node) && node.getText(page).includes("Date.parse(t.closed_at)")) filters.push(node.getText(page));
  ts.forEachChild(node, visit);
}
visit(page);
assert.equal(resets.length, 1);
assert.equal(filters.length, 3);
for (const mode of ["success", "server error", "network error", "refresh error"]) {
  test(`reset button: ${mode} always clears its busy state`, async () => {
    const busy = [], alerts = [];
    const context = {
      confirm: () => true, setResetting: (value) => busy.push(value), alert: (message) => alerts.push(message),
      fetch: async () => {
        if (mode === "network error") throw new Error("offline");
        return { ok: mode !== "server error", json: async () => ({ error: "Reset failed" }) };
      },
      onToggled: async () => { if (mode === "refresh error") throw new Error("refresh failed"); },
    };
    vm.runInNewContext(compile(resets[0]), context);
    await context.handleReset();
    assert.deepEqual(busy, [true, false]);
    assert.equal(alerts.length, mode === "success" ? 0 : 1);
  });
}
filters.forEach((filter, index) => {
  test(`history filter ${index + 1}: timestamps respect the saved cutoff across timezone formats`, () => {
    const cutoff = "2026-10-01T12:00:00.000Z";
    const context = { optimalBtcState: { history_reset_at: cutoff }, dcaBtcState: { history_reset_at: cutoff },
      WORKER2_RESET_AT: cutoff, WORKER3_RESET_AT: cutoff };
    vm.runInNewContext(compile(`const include = ${filter}; globalThis.include = include;`), context);
    assert.equal(context.include({ closed_at: "2026-10-01T11:59:59+00:00" }), false);
    assert.equal(context.include({ closed_at: "2026-10-01T12:00:00+00:00" }), true);
    assert.equal(context.include({ closed_at: "2026-10-01T08:01:00-04:00" }), true);
    assert.equal(context.include({ closed_at: null }), false);
    context.optimalBtcState = context.dcaBtcState = { history_reset_at: null };
    assert.equal(context.include({ closed_at: "2026-10-01T12:01:00Z" }), true, "Legacy cutoff works before the first reset");
  });
});
