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
//
// jumpRatio/jumpPause/clearVolumeJump (2026-10-03, "build the same guard for worker 2") --
// same mechanism as lighter-btc-initial-settings, both legs always carry IDENTICAL guard
// settings for the same reason the exits do: each leg reads its own state row independently
// (StochBot._update_volume_jump_guard), so a mismatched override would let one leg's cycle
// gate disagree with its partner's.
const LIMITS = {
  sl: { min: 0.01, max: 0.5, label: "stop-loss" },
  trigger: { min: 0.01, max: 1.0, label: "profit-lock trigger" },
  trail: { min: 0.005, max: 0.5, label: "profit-lock trail" },
  tp: { min: 0.01, max: 1.0, label: "take-profit" },
  dwell: { min: 0, max: 300, label: "dwell (seconds)" },
  jumpRatio: { min: 1.1, max: 20, label: "volume-jump ratio" },
  jumpPause: { min: 0, max: 1800, label: "volume-jump pause (seconds)" },
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const out: Record<string, number | string | null> = {};

  for (const [key, col] of [
    ["sl", "override_sl_pct"],
    ["trigger", "override_profit_lock_trigger"],
    ["trail", "override_profit_lock_trail"],
    ["tp", "override_tp_pct"],
    ["dwell", "override_dwell_seconds"],
    ["jumpRatio", "override_volume_jump_ratio"],
    ["jumpPause", "override_volume_jump_pause_seconds"],
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

  // Manual "clear pause" button -- writes a marker timestamp, not a literal flag; see
  // override_volume_jump_cleared_at's docstring (StochBot._update_volume_jump_guard) for why
  // this forgives only the pause already in progress, not future spikes.
  if (body.clearVolumeJump === true) {
    out["override_volume_jump_cleared_at"] = new Date().toISOString();
  }

  // Release-arm selector -- see lighter-btc-initial-settings for the full reasoning. "off"
  // writes null (compiled default is already off); both legs get the same mode, same reason
  // as every other override here.
  if (body.releaseMode !== undefined) {
    const rm = body.releaseMode;
    if (rm !== "off" && rm !== "volume" && rm !== "wiggle" && rm !== "rate") {
      return NextResponse.json({ error: `releaseMode must be off/volume/wiggle/rate (got "${rm}").` }, { status: 400 });
    }
    out["override_volume_jump_release_mode"] = rm === "off" ? null : rm;
  }

  // Exit-style selector (2026-10-03, direct request after WORKER_2_HANDOFF.md research: "a
  // panel where i can change between trail and TP so i can test multiple strategies"). "trail"
  // is the default/current behavior; "tp" is the research-recommended controlled comparison
  // (literal TP at override_tp_pct, trail suppressed). SL is never touched by this -- see
  // StochBot._exit_params's docstring for the full reasoning.
  if (body.exitMode !== undefined) {
    const em = body.exitMode;
    if (em !== "trail" && em !== "tp") {
      return NextResponse.json({ error: `exitMode must be trail/tp (got "${em}").` }, { status: 400 });
    }
    out["override_exit_mode"] = em;
  }

  if (Object.keys(out).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  // The trail must sit below the trigger or the profit-lock can never arm before it fires.
  const trig = out["override_profit_lock_trigger"] as number | undefined;
  const trail = out["override_profit_lock_trail"] as number | undefined;
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
