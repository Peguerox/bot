import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Master schedule panel (2026-10-04, direct request: "a third panel that can control both...
// by hour... if this volume do this, if this wiggle and volume do this"). One shared row
// (bot_schedule_rules, id=1) drives StochBot._apply_schedule_rules on Worker 1 and both hedge
// legs -- see that method's docstring in server/stoch_bot_core.py for the full read-side
// contract. This route is write-only; the panel reads the row directly via the anon key, same
// as every other bot's state.
//
// Bounds are a generous union of every lever's own route (Worker 1's SL now allows up to 100%
// for the no-SL experiment, the hedge's trail allows 0) -- this one row's settings objects feed
// BOTH bots, so the limits here can't be tighter than either bot's own panel already allows.
const PCT_FIELDS = ["sl_pct", "trigger_pct", "trail_pct", "tp_pct"] as const;
const PCT_LIMITS = { min: 0, max: 100 };
const DWELL_LIMITS = { min: 0, max: 300 };
const BAND_LIMITS = { min: 0, max: 100 };
const WINDOW_LIMITS = { min: 2, max: 50 };

function validateSettings(obj: unknown, label: string, worker1: boolean): string | null {
  if (obj === undefined || obj === null) return null;
  if (typeof obj !== "object") return `${label} must be an object.`;
  const o = obj as Record<string, unknown>;
  for (const key of PCT_FIELDS) {
    const v = o[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return `${label}.${key} must be a number.`;
    if (v < PCT_LIMITS.min || v > PCT_LIMITS.max) return `${label}.${key} must be between ${PCT_LIMITS.min} and ${PCT_LIMITS.max}.`;
  }
  if (o.dwell_seconds !== undefined && o.dwell_seconds !== null) {
    const v = o.dwell_seconds;
    if (typeof v !== "number" || v < DWELL_LIMITS.min || v > DWELL_LIMITS.max) {
      return `${label}.dwell_seconds must be between ${DWELL_LIMITS.min} and ${DWELL_LIMITS.max}.`;
    }
  }
  const trig = o.trigger_pct as number | undefined;
  const trail = o.trail_pct as number | undefined;
  if (typeof trig === "number" && typeof trail === "number" && trail > trig) {
    return `${label}: trail (${trail}) must not be larger than trigger (${trig}).`;
  }
  if (worker1) {
    for (const key of ["band_lo", "band_hi", "reversal_lo", "reversal_hi"]) {
      const v = o[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== "number" || v < BAND_LIMITS.min || v > BAND_LIMITS.max) {
        return `${label}.${key} must be between ${BAND_LIMITS.min} and ${BAND_LIMITS.max}.`;
      }
    }
    const lo = o.band_lo as number | undefined, hi = o.band_hi as number | undefined;
    if (typeof lo === "number" && typeof hi === "number" && lo >= hi) {
      return `${label}: band_lo must be less than band_hi.`;
    }
    const rlo = o.reversal_lo as number | undefined, rhi = o.reversal_hi as number | undefined;
    if (typeof rlo === "number" && typeof rhi === "number" && rlo >= rhi) {
      return `${label}: reversal_lo must be less than reversal_hi.`;
    }
    if (o.window !== undefined && o.window !== null) {
      const v = o.window;
      if (typeof v !== "number" || v < WINDOW_LIMITS.min || v > WINDOW_LIMITS.max) {
        return `${label}.window must be between ${WINDOW_LIMITS.min} and ${WINDOW_LIMITS.max}.`;
      }
    }
    // 2026-10-06, direct request: "the automation panel needs this option too" -- tri-state,
    // null means leave it alone, true/false sets it. Worker 1 only (StochBot.escalated_sl_enabled
    // doesn't exist as a compiled flag on the hedge).
    if (o.escalated_sl_enabled !== undefined && o.escalated_sl_enabled !== null
        && typeof o.escalated_sl_enabled !== "boolean") {
      return `${label}.escalated_sl_enabled must be true, false, or null.`;
    }
  }
  return null;
}

const CONDITION_PAIRS = [
  ["er_min", "er_max"], ["volume_min", "volume_max"],
  ["wiggle_min", "wiggle_max"], ["rate_min", "rate_max"],
  ["vol_wiggle_ratio_min", "vol_wiggle_ratio_max"],
  ["vol_wiggle_product_min", "vol_wiggle_product_max"],
  ["zebra_min", "zebra_max"], ["color_balance_min", "color_balance_max"],
] as const;

function validateRule(rule: unknown, idx: number): string | null {
  if (typeof rule !== "object" || rule === null) return `Rule ${idx + 1} must be an object.`;
  const r = rule as Record<string, unknown>;
  // hour_start/hour_end are Miami local time (America/New_York, DST-aware) -- direct request,
  // "you have to convert it not me". See StochBot._schedule_current_hour.
  const hs = r.hour_start, he = r.hour_end;
  for (const [key, v] of [["hour_start", hs], ["hour_end", he]] as const) {
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 23) {
      return `Rule ${idx + 1}: ${key} must be an integer 0-23.`;
    }
  }
  for (const [loKey, hiKey] of CONDITION_PAIRS) {
    const lo = r[loKey], hi = r[hiKey];
    for (const [key, v] of [[loKey, lo], [hiKey, hi]] as const) {
      if (v === undefined || v === null) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) return `Rule ${idx + 1}: ${key} must be a number.`;
    }
    if (typeof lo === "number" && typeof hi === "number" && lo > hi) {
      return `Rule ${idx + 1}: ${loKey} must not exceed ${hiKey}.`;
    }
  }
  // Per-bot ON/OFF switch, independent of that bot having a settings object on the same rule --
  // direct request: "maybe with this rule I want 1 on and the other off... I need a little
  // switch". Default true (both run) when absent.
  for (const key of ["worker1_enabled", "hedge_enabled"] as const) {
    const v = r[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "boolean") return `Rule ${idx + 1}: ${key} must be true or false.`;
  }
  const err1 = validateSettings(r.worker1, `Rule ${idx + 1}.worker1`, true);
  if (err1) return err1;
  const err2 = validateSettings(r.hedge, `Rule ${idx + 1}.hedge`, false);
  if (err2) return err2;
  return null;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const out: Record<string, unknown> = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false." }, { status: 400 });
    }
    out.enabled = body.enabled;
  }

  if (body.rules !== undefined) {
    if (!Array.isArray(body.rules)) {
      return NextResponse.json({ error: "rules must be an array." }, { status: 400 });
    }
    for (let i = 0; i < body.rules.length; i++) {
      const err = validateRule(body.rules[i], i);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }
    out.rules = body.rules;
  }

  // 2026-10-05, direct request: "it needs to stay there for so amount of seconds in order to
  // apply the rule" (seconds, not minutes -- revised same day) -- one hold time for the whole
  // rule set, not per rule. 0 = old instant-switch behaviour. See StochBot._apply_schedule_rules.
  if (body.min_hold_seconds !== undefined) {
    const v = body.min_hold_seconds;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10800) {
      return NextResponse.json({ error: "min_hold_seconds must be a number between 0 and 10800." }, { status: 400 });
    }
    out.min_hold_seconds = v;
  }

  if (Object.keys(out).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  const { error } = await sb.from("bot_schedule_rules").update(out).eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, applied: out });
}
