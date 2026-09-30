import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Manual exit levers for the hedge. Writes sl / trigger / trail to BOTH leg rows in one call.
//
// Both legs must always carry IDENTICAL exits. Unequal exits break the breakeven floor -- a leg
// cut at a different level cannot be offset by its partner -- which is the same class of bug as
// the $15/$5 size tilt. There is deliberately no way to set one leg alone.
//
// Bounds are sanity rails, not opinions: they stop a typo (0.6 instead of 0.06) from placing a
// stop ten times wider than intended on real money.
const LIMITS = {
  sl: { min: 0.01, max: 0.5, label: "stop-loss" },
  trigger: { min: 0.01, max: 1.0, label: "profit-lock trigger" },
  trail: { min: 0.005, max: 0.5, label: "profit-lock trail" },
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const out: Record<string, number> = {};

  for (const [key, col] of [
    ["sl", "override_sl_pct"],
    ["trigger", "override_profit_lock_trigger"],
    ["trail", "override_profit_lock_trail"],
  ] as const) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const v = Number(raw);
    const lim = LIMITS[key];
    if (!Number.isFinite(v)) {
      return NextResponse.json({ error: `${lim.label}: "${raw}" is not a number.` }, { status: 400 });
    }
    if (v < lim.min || v > lim.max) {
      return NextResponse.json(
        { error: `${lim.label} must be between ${lim.min}% and ${lim.max}% (got ${v}).` },
        { status: 400 }
      );
    }
    out[col] = v;
  }

  if (Object.keys(out).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  // The trail must sit below the trigger or the profit-lock can never arm before it fires.
  const trig = out["override_profit_lock_trigger"];
  const trail = out["override_profit_lock_trail"];
  if (trig !== undefined && trail !== undefined && trail >= trig) {
    return NextResponse.json(
      { error: `Trail (${trail}%) must be smaller than the trigger (${trig}%).` },
      { status: 400 }
    );
  }

  const sb = getSupabaseAdmin();
  const results = await Promise.all([
    sb.from("lighter_btc_optimal_state").update(out).eq("id", 1),
    sb.from("lighter_stoch_dca_btc_state").update(out).eq("id", 1),
  ]);
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, applied: out });
}
