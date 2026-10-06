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
// bandLo/bandHi and reversalLo/reversalHi (2026-10-02, direct request) override the
// stochastic's own 25/75 K band -- entry and reversal independently, not a shared pair
// (first version tied them together; revised same day on direct follow-up request).
const LIMITS = {
  // max raised 0.5 -> 100 (2026-10-04, direct request: "test a no stop loss strategy... just
  // the reversal to come out") -- there's no literal "off" switch for SL, so a very large
  // number (e.g. 100) is the practical equivalent: it will never realistically be reached,
  // leaving the reversal exit as the only thing that can close a losing position.
  sl: { min: 0.01, max: 100, label: "stop-loss" },
  trigger: { min: 0.01, max: 1.0, label: "profit-lock trigger" },
  trail: { min: 0, max: 0.5, label: "profit-lock trail" },
  volThreshold: { min: 0, max: 100, label: "volume switch threshold" },
  bandLo: { min: 0, max: 49, label: "entry band low (K)" },
  bandHi: { min: 51, max: 100, label: "entry band high (K)" },
  reversalLo: { min: 0, max: 49, label: "reversal band low (K)" },
  reversalHi: { min: 51, max: 100, label: "reversal band high (K)" },
  jumpRatio: { min: 1.1, max: 20, label: "volume-jump ratio" },
  jumpPause: { min: 0, max: 1800, label: "volume-jump pause (seconds)" },
  tp: { min: 0.01, max: 1.0, label: "take-profit" },
  dwell: { min: 0, max: 300, label: "dwell (seconds)" },
  wiggleLock: { min: 0.01, max: 50, label: "volume/wiggle lock threshold" },
  // 2026-10-04, direct request: "change the window of stochastic for worker 1". Integer candle
  // count; governs both the entry and reversal bands (see StochBot._stoch_window_control).
  stochWindow: { min: 2, max: 50, label: "stochastic window" },
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const out: Record<string, number | boolean | string | null> = {};

  for (const [key, col] of [
    ["sl", "override_sl_pct"],
    ["trigger", "override_profit_lock_trigger"],
    ["trail", "override_profit_lock_trail"],
    ["volThreshold", "override_volume_switch_threshold"],
    ["bandLo", "override_stoch_band_lo"],
    ["bandHi", "override_stoch_band_hi"],
    ["reversalLo", "override_stoch_reversal_lo"],
    ["reversalHi", "override_stoch_reversal_hi"],
    ["jumpRatio", "override_volume_jump_ratio"],
    ["jumpPause", "override_volume_jump_pause_seconds"],
    ["tp", "override_tp_pct"],
    ["dwell", "override_dwell_seconds"],
    ["wiggleLock", "override_volume_wiggle_lock_threshold"],
    ["stochWindow", "override_stoch_window"],
  ] as const) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") continue;
    let v = Number(raw);
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
    // Candle count, not a percentage -- the worker casts with int() regardless, round here so
    // the dashboard's "now X" readout matches what actually ends up live.
    if (key === "stochWindow") v = Math.round(v);
    out[col] = v;
  }

  // Signal on/off toggles -- booleans, sent only when actually changed (the panel tracks this
  // client-side), so `undefined` here means "leave it alone", not "turn it off".
  for (const [key, col] of [
    ["stochastic", "override_stochastic_enabled"],
    ["zebra", "override_zebra_enabled"],
    ["flip", "override_flip_enabled"],
    ["wiggleLockEnabled", "override_volume_wiggle_lock_enabled"],
    ["jumpGuardEnabled", "override_volume_jump_enabled"],
  ] as const) {
    const raw = body[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "boolean") {
      return NextResponse.json({ error: `${key} must be true or false.` }, { status: 400 });
    }
    out[col] = raw;
  }

  // Manual "clear pause" button (2026-10-03, direct request) -- writes a timestamp, not the
  // literal `true` sent by the client; see override_volume_jump_cleared_at's docstring
  // (StochBot._update_volume_jump_guard) for why this is a marker compared against the spike
  // time, not just blanking the pause out directly.
  if (body.clearVolumeJump === true) {
    out["override_volume_jump_cleared_at"] = new Date().toISOString();
  }

  // Release-arm selector (2026-10-03, direct request: "build them both... which one is
  // controlling?"): exactly one of volume/wiggle/rate can drive an EARLY release, or "off" for
  // the plain fixed-timer pause (the only behavior that existed before this). "off" writes null,
  // not the string "off" -- _update_volume_jump_guard treats a falsy override as "use the
  // compiled default", and the compiled default is already None/off.
  if (body.releaseMode !== undefined) {
    const rm = body.releaseMode;
    if (rm !== "off" && rm !== "volume" && rm !== "wiggle" && rm !== "rate") {
      return NextResponse.json({ error: `releaseMode must be off/volume/wiggle/rate (got "${rm}").` }, { status: 400 });
    }
    out["override_volume_jump_release_mode"] = rm === "off" ? null : rm;
  }

  // Exit-style selector (2026-10-03, direct request: "build the same thing for worker 1" --
  // mirrors the hedge's trail/TP switch). "trail" is the default/current behavior; "tp" makes
  // a literal TP (at override_tp_pct) the only winner exit and suppresses the profit-lock
  // trail. SL is never touched -- see StochBot._exit_params's docstring.
  if (body.exitMode !== undefined) {
    const em = body.exitMode;
    if (em !== "trail" && em !== "tp") {
      return NextResponse.json({ error: `exitMode must be trail/tp (got "${em}").` }, { status: 400 });
    }
    out["override_exit_mode"] = em;
  }

  // Escalated/leveled SL (2026-10-06, direct request after digging into real trade data --
  // see StochBot/BotConfig.escalated_sl_enabled's docstring in stoch_bot_core.py). When on,
  // REPLACES the plain SL entirely with the 3-tier check. Off by default.
  if (body.escalatedSlEnabled !== undefined) {
    if (typeof body.escalatedSlEnabled !== "boolean") {
      return NextResponse.json({ error: "escalatedSlEnabled must be true or false." }, { status: 400 });
    }
    out["override_escalated_sl_enabled"] = body.escalatedSlEnabled;
  }

  if (Object.keys(out).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  // The trail must sit below the trigger or the profit lock fires the instant it arms. Checked
  // against the value that will actually be live, so changing only one of the two is validated too.
  // select("*") rather than naming columns: a column this route knows about but whose
  // migration hasn't run yet (e.g. override_stoch_reversal_lo/hi before
  // lighter_btc_initial_stoch_reversal_band_override.sql) must never break every OTHER
  // control on this same panel -- naming it explicitly made PostgREST error the whole
  // request on a missing column; "*" just omits it from the result (reads as undefined,
  // same as null for every `??` below) until the migration runs.
  const { data: cur, error: readError } = await sb
    .from("lighter_btc_initial_state")
    .select("*")
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
      { error: `Entry band low (${bandLo}) must be less than entry band high (${bandHi}).` },
      { status: 400 }
    );
  }
  const reversalLo = (out["override_stoch_reversal_lo"] as number | undefined) ?? cur?.override_stoch_reversal_lo;
  const reversalHi = (out["override_stoch_reversal_hi"] as number | undefined) ?? cur?.override_stoch_reversal_hi;
  if (reversalLo != null && reversalHi != null && reversalLo >= reversalHi) {
    return NextResponse.json(
      { error: `Reversal band low (${reversalLo}) must be less than reversal band high (${reversalHi}).` },
      { status: 400 }
    );
  }

  const { error } = await sb.from("lighter_btc_initial_state").update(out).eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, applied: out });
}
