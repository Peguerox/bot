import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Manual exit levers for Worker 1 only (lighter_btc_initial_state) -- same mechanism as the hedge's
// lighter-hedge-settings, one row instead of two. The worker reads these every tick
// (schema_has_exit_overrides), so a change applies at once, including to an open position.
//
// Bounds are sanity rails against typos on real money. Trail may be 0 here, unlike the hedge:
// Worker 1's profit lock has always run with zero give-back (exit on the first tick down).
const LIMITS = {
  sl: { min: 0.01, max: 0.5, label: "stop-loss" },
  trigger: { min: 0.01, max: 1.0, label: "profit-lock trigger" },
  trail: { min: 0, max: 0.5, label: "profit-lock trail" },
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

  const sb = getSupabaseAdmin();
  // The trail must sit below the trigger or the profit lock fires the instant it arms. Checked
  // against the value that will actually be live, so changing only one of the two is validated too.
  const { data: cur, error: readError } = await sb
    .from("lighter_btc_initial_state")
    .select("override_profit_lock_trigger, override_profit_lock_trail")
    .eq("id", 1)
    .single();
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  const trig = out["override_profit_lock_trigger"] ?? cur?.override_profit_lock_trigger;
  const trail = out["override_profit_lock_trail"] ?? cur?.override_profit_lock_trail;
  if (trig != null && trail != null && trail >= trig) {
    return NextResponse.json(
      { error: `Trail (${trail}%) must be smaller than the trigger (${trig}%).` },
      { status: 400 }
    );
  }

  const { error } = await sb.from("lighter_btc_initial_state").update(out).eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, applied: out });
}
