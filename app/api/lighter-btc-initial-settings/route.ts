import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Manual exit levers for Worker 1 only (lighter_btc_initial_state) -- same mechanism as the hedge's
// lighter-hedge-settings, one row instead of two. The worker reads these every tick
// (schema_has_exit_overrides), so a change applies at once, including to an open position.
//
// Bounds are sanity rails against typos on real money. Trail may be 0 or equal to the trigger
// here. Worker 1 ran zero give-back (exit on the first tick down) until 2026-10-02, when a
// real trade peaked at +0.04% and gave it all back to the SL -- trigger/trail moved to 0.03/0.03.
//
// bandLo/bandHi (2026-10-02, direct request) override the stochastic's own 25/75 K band -- ONE
// shared pair applied to both the entry signal and the reversal exit together, not independently.
const LIMITS = {
  sl: { min: 0.01, max: 0.5, label: "stop-loss" },
  trigger: { min: 0.01, max: 1.0, label: "profit-lock trigger" },
  trail: { min: 0, max: 0.5, label: "profit-lock trail" },
  volThreshold: { min: 0, max: 100, label: "volume switch threshold" },
  bandLo: { min: 0, max: 49, label: "stochastic band low (K)" },
  bandHi: { min: 51, max: 100, label: "stochastic band high (K)" },
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const out: Record<string, number | boolean> = {};

  for (const [key, col] of [
    ["sl", "override_sl_pct"],
    ["trigger", "override_profit_lock_trigger"],
    ["trail", "override_profit_lock_trail"],
    ["volThreshold", "override_volume_switch_threshold"],
    ["bandLo", "override_stoch_band_lo"],
    ["bandHi", "override_stoch_band_hi"],
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

  // Signal on/off toggles -- booleans, sent only when actually changed (the panel tracks this
  // client-side), so `undefined` here means "leave it alone", not "turn it off".
  for (const [key, col] of [
    ["stochastic", "override_stochastic_enabled"],
    ["zebra", "override_zebra_enabled"],
    ["flip", "override_flip_enabled"],
  ] as const) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "boolean") {
      return NextResponse.json({ error: `${key} must be true or false.` }, { status: 400 });
    }
    out[col] = raw;
  }

  if (Object.keys(out).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  // The trail must sit below the trigger or the profit lock fires the instant it arms. Checked
  // against the value that will actually be live, so changing only one of the two is validated too.
  const { data: cur, error: readError } = await sb
    .from("lighter_btc_initial_state")
    .select("override_profit_lock_trigger, override_profit_lock_trail, override_stoch_band_lo, override_stoch_band_hi")
    .eq("id", 1)
    .single();
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  const trig = (out["override_profit_lock_trigger"] as number | undefined) ?? cur?.override_profit_lock_trigger;
  const trail = (out["override_profit_lock_trail"] as number | undefined) ?? cur?.override_profit_lock_trail;
  // trail == trigger is valid (2026-10-02, direct request: trigger 0.03 / trail 0.03) -- once
  // armed at the trigger level, the exit only fires after giving back a further `trail`, which
  // is well-defined even when the two numbers match (nothing fires on the arming tick itself).
  // Only trail > trigger is rejected, not trail == trigger.
  if (trig != null && trail != null && trail > trig) {
    return NextResponse.json(
      { error: `Trail (${trail}%) must not be larger than the trigger (${trig}%).` },
      { status: 400 }
    );
  }
  const bandLo = (out["override_stoch_band_lo"] as number | undefined) ?? cur?.override_stoch_band_lo;
  const bandHi = (out["override_stoch_band_hi"] as number | undefined) ?? cur?.override_stoch_band_hi;
  if (bandLo != null && bandHi != null && bandLo >= bandHi) {
    return NextResponse.json(
      { error: `Band low (${bandLo}) must be less than band high (${bandHi}).` },
      { status: 400 }
    );
  }

  const { error } = await sb.from("lighter_btc_initial_state").update(out).eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, applied: out });
}
