import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";

// Flip martingale panel settings (owner, 2026-11-04). Writes override_params on the bot's state row; the bot applies them
// from the NEXT sequence (an open sequence keeps its own). Bounds must match EDITABLE in server/lit_flip_live.py.
export const FLIP_BOUNDS: Record<string, [string, number, number]> = {
  tpPct: ["tp_pct", 0.2, 10], slPct: ["sl_pct", 0.1, 5], firstPct: ["first_pct", 0.5, 50], mult: ["mult", 1.05, 3], levCap: ["lev_cap", 0.2, 5],
  trailPct: ["trail_pct", 0, 3],
  lockFromStep: ["lock_from_step", 0, 11], lockProfitPct: ["lock_profit_pct", 0, 5], lockArmPct: ["lock_arm_pct", 0.05, 3],
  lockTrailPct: ["lock_trail_pct", 0, 3],
  addMode: ["add_mode", 0, 1],
};

export async function flipSettingsPost(req: NextRequest, table: string) {
  const authError = checkLitGridLiveAuth(req);
  if (authError) return authError;
  const body = await req.json().catch(() => ({}));
  const sb = getSupabaseAdmin();
  if (body.reset) {
    const { error } = await sb.from(table).update({ override_params: null }).eq("id", 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, override_params: null });
  }
  const { data: cur, error: readError } = await sb.from(table).select("override_params,equity").eq("id", 1).single();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  const next: Record<string, number> = { ...(cur?.override_params ?? {}) };
  for (const [k, [col, lo, hi]] of Object.entries(FLIP_BOUNDS)) {
    if (body[k] === undefined || body[k] === null || body[k] === "") continue;
    const v = Number(body[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) return NextResponse.json({ error: `${k} must be between ${lo} and ${hi}.` }, { status: 400 });
    next[col] = v;
  }
  // Compounding OFF = fixedBaseUsd > 0 (size from that amount); 0 = compounding ON (whole account).
  if (body.fixedBaseUsd !== undefined && body.fixedBaseUsd !== null && body.fixedBaseUsd !== "") {
    const fb = Number(body.fixedBaseUsd);
    if (!Number.isFinite(fb) || fb < 0 || fb > 10_000_000) return NextResponse.json({ error: "Fixed amount must be 0 or a positive dollar amount." }, { status: 400 });
    if (fb > 0 && fb < 200) return NextResponse.json({ error: "Fixed amount must be at least $200 (Lighter's $10 minimum on a 5% first trade)." }, { status: 400 });
    if (fb === 0) delete next.fixed_base_usd; else next.fixed_base_usd = fb;
  }
  // Stepped target (2026-11-04): stepN 0 = off; else stepN steps from stepStart, +stepInc each. Saving it restarts the
  // profit count from the current account (step_base_usd), so the bot starts at step 1.
  if (body.stepN !== undefined && body.stepN !== null && body.stepN !== "") {
    const n = Number(body.stepN);
    if (n === 0) { delete next.step_n; delete next.step_start; delete next.step_inc; delete next.step_base_usd; }
    else {
      const st0 = Number(body.stepStart ?? next.step_start), inc = Number(body.stepInc ?? next.step_inc);
      if (!Number.isInteger(n) || n < 2 || n > 10) return NextResponse.json({ error: "Steps must be 0 (off) or 2 to 10." }, { status: 400 });
      if (!(st0 >= 0.2 && st0 <= 10)) return NextResponse.json({ error: "Start % must be between 0.2 and 10." }, { status: 400 });
      if (!(inc >= 0.05 && inc <= 5)) return NextResponse.json({ error: "Step + % must be between 0.05 and 5." }, { status: 400 });
      if (st0 <= (next.sl_pct ?? 0.5)) return NextResponse.json({ error: "Start % must be bigger than the stop." }, { status: 400 });
      const changed = n !== next.step_n || st0 !== next.step_start || inc !== next.step_inc;
      next.step_n = n; next.step_start = st0; next.step_inc = inc;
      if (changed || !next.step_base_usd) next.step_base_usd = Number(cur?.equity ?? 0) || 0;
    }
  }
  if (next.trail_pct !== undefined && next.trail_pct > 0 && next.trail_pct < 0.05)
    return NextResponse.json({ error: "Trail must be 0 (off) or at least 0.05%." }, { status: 400 });
  const tp = next.tp_pct ?? 2, sl = next.sl_pct ?? 0.5;
  if (tp <= sl) return NextResponse.json({ error: "Target must be bigger than the stop." }, { status: 400 });
  const { error } = await sb.from(table).update({ override_params: next }).eq("id", 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, override_params: next });
}
