// Offline tests of the actual tooltip formatter in app/page.tsx.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const page = ts.createSourceFile("page.tsx", readFileSync(resolve(root, "app/page.tsx"), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let formatter;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(page) === "entryFeaturesLine") formatter = node.initializer.getText(page);
  ts.forEachChild(node, visit);
}
visit(page);
assert.ok(formatter);
const context = {};
vm.runInNewContext(ts.transpileModule(`globalThis.format = ${formatter};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText, context);

test("shows all four saved numeric readings, including zero", () => {
  const text = context.format({ long: { entry_k: 0, entry_balance_index: 95.1, entry_vol_pct: 0.071, entry_dispersion: 21.3 } });
  assert.match(text, /K 0\.00/);
  assert.match(text, /balance-idx 95\.1/);
  assert.match(text, /vol 0\.07%/);
  assert.match(text, /dispersion 21\.3\$/);
  assert.doesNotMatch(text, /no entry snapshot/);
});
test("uses short-leg readings when the long snapshot is empty", () => {
  assert.match(context.format({ long: { entry_k: null }, short: { entry_k: 81.2, entry_dispersion: 15 } }), /K 81\.2.*dispersion 15\.0\$/);
});
test("fills individually missing readings from the other leg", () => {
  const text = context.format({ long: { entry_k: 20 }, short: { entry_k: 80, entry_vol_pct: 0.08 } });
  assert.match(text, /K 20\.0.*vol 0\.08%/);
});
test("old trades explicitly show missing readings rather than hiding the line", () => {
  const text = context.format({ long: {}, short: {} });
  assert.match(text, /K —.*balance-idx —.*vol —.*dispersion —.*no entry snapshot saved/);
});
test("malformed values never crash the tooltip or masquerade as K", () => {
  const text = context.format({ long: { entry_k: "short", entry_balance_index: NaN, entry_vol_pct: Infinity }, short: { entry_k: 75 } });
  assert.match(text, /K 75\.0.*balance-idx —.*vol —/);
});
