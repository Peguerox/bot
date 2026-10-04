// Offline API regression checks. No credentials, network, or database writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

function compile(path, imports = {}) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = { exports: {}, require: (name) => {
    if (!(name in imports)) throw Error(`Unexpected import ${name}`);
    return imports[name];
  } };
  vm.runInNewContext(code, context);
  return context.exports;
}
const config = compile("lib/hedge-entry-filters.ts");
function route(error = null) {
  const writes = [];
  const sb = { from(table) {
    let patch;
    const query = {
      update(value) { patch = value; writes.push({ table, patch }); return query; },
      eq() { return query; }, select() { return query; },
      single: async () => ({ data: patch, error }),
    };
    return query;
  } };
  return { writes, api: compile("app/api/lighter-hedge-settings/route.ts", {
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/lib/supabase-admin": { getSupabaseAdmin: () => sb },
    "@/lib/hedge-entry-filters": config,
  }) };
}
const defaults = () => ({ ...config.DEFAULT_HEDGE_ENTRY_FILTERS });
test("both disabled are explicit defaults", () => {
  assert.equal(defaults().stochasticEnabled, false);
  assert.equal(defaults().zscoreEnabled, false);
});
test("one atomic owner write saves both optional filters without touching exits", async () => {
  const { api, writes } = route();
  const filters = { ...defaults(), stochasticEnabled: true, zscoreEnabled: true, stochasticLow: 10, stochasticHigh: 90, zscoreLow: -1.5, zscoreHigh: 3 };
  const res = await api.POST({ json: async () => ({ entryFilters: filters }) });
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].table, "lighter_btc_optimal_state");
  assert.deepEqual(Object.keys(writes[0].patch), ["override_hedge_entry_filters"]);
  assert.equal(writes[0].patch.override_hedge_entry_filters.stochasticLow, 10);
});
for (const patch of [{ stochasticWindow: 1 }, { zscoreWindow: 51 }, { stochasticWindow: 2.5 },
  { stochasticLow: 90, stochasticHigh: 10 }, { stochasticLow: -1 }, { zscoreLow: 1 },
  { zscoreHigh: 0 }, { stochasticEnabled: "false" }, { zscoreWindow: "5" }, { zscoreHigh: Infinity }]) {
  test(`invalid controls do not write: ${JSON.stringify(patch)}`, async () => {
    const { api, writes } = route();
    const res = await api.POST({ json: async () => ({ entryFilters: { ...defaults(), ...patch } }) });
    assert.equal(res.status, 400);
    assert.equal(writes.length, 0);
  });
}
test("entry controls and exits cannot be accidentally combined", async () => {
  const { api, writes } = route();
  assert.equal((await api.POST({ json: async () => ({ entryFilters: defaults(), sl: .1 }) })).status, 400);
  assert.equal(writes.length, 0);
});
test("missing database column is reported as a save failure", async () => {
  const { api } = route({ message: "Entry filter column missing" });
  const response = await api.POST({ json: async () => ({ entryFilters: defaults() }) });
  assert.equal(response.status, 500);
  assert.equal(response.body.error, "Entry filter column missing");
});
