import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";

// Flip martingale panel settings (owner, 2026-11-04). Writes override_params on the bot's state row; the bot applies them
// from the NEXT sequence (an open sequence keeps its own). Bounds must match EDITABLE in server/lit_flip_live.py.
export const FLIP_BOUNDS: Record<string, [string, number, number]> = {
  tpPct: ["tp_pct", 0.2, 10], slPct: ["sl_pct", 0.1, 5], firstPct: ["first_pct", 0.5, 50], mult: ["mult", 1.05, 3], levCap: ["lev_cap", 0.2, 5],
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
  const { data: cur, error: readError } = await sb.from(table).select("override_params").eq("id", 1).single();
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
  const tp = next.tp_pct ?? 2, sl = next.sl_pct ?? 0.5;
  if (tp <= sl) return NextResponse.json({ error: "Target must be bigger than the stop." }, { status: 400 });
  const { error } = await sb.from(table).update({ override_params: next }).eq("id", 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, override_params: next });
}
