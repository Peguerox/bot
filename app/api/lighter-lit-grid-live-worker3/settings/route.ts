import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { investmentShortfallError } from "@/lib/lit-grid-live-balance";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";

// REAL MONEY. Worker 3 twin of /api/lighter-lit-grid-live/settings (2026-10-21) -- identical
// bounds-checking, pointed at lighter_lit_grid_live_worker3_state. See that route for the
// reasoning behind each field; kept in lockstep deliberately rather than sharing a generic
// handler, same per-bot-route convention as every other live bot in this codebase.
const TABLE = "lighter_lit_grid_live_worker3_state";

const LIMITS = {
  spacingPct: { min: 0.01, max: 5, label: "grid spacing" },
  levelsUp: { min: 1, max: 50, label: "levels up" },
  levelsDown: { min: 1, max: 50, label: "levels down" },
  drawdownPct: { min: 0.1, max: 95, label: "drawdown coverage" },
  capitalUsd: { min: 1, max: 1_000_000, label: "capital" },
  maxOpenBuys: { min: 1, max: 50, label: "max open buys" },
};

const PROFIT_MODES = ["rest", "cover_drop", "compound"] as const;

export async function POST(req: NextRequest) {
  const authError = checkLitGridLiveAuth(req);
  if (authError) return authError;
  const body = await req.json();
  const out: Record<string, number | string | boolean | null> = {};

  if (body.maxOpenBuys === 0 || body.maxOpenBuys === "0") {
    out["max_open_buys"] = null;
  }

  if (body.profitMode !== undefined && body.profitMode !== null && body.profitMode !== "") {
    if (!PROFIT_MODES.includes(body.profitMode)) {
      return NextResponse.json(
        { error: `profitMode must be one of: ${PROFIT_MODES.join(", ")}.` },
        { status: 400 }
      );
    }
    out["profit_mode"] = body.profitMode;
  }

  if (body.restCapUsd !== undefined && body.restCapUsd !== null && body.restCapUsd !== "") {
    const v = Number(body.restCapUsd);
    if (!Number.isFinite(v) || v < 0 || v > 1_000_000) {
      return NextResponse.json({ error: `Rest cap must be between 0 and 1,000,000 (got ${body.restCapUsd}).` }, { status: 400 });
    }
    out["rest_cap_usd"] = v === 0 ? null : v;
  }
  if (body.restOverflowTo !== undefined && body.restOverflowTo !== null && body.restOverflowTo !== "") {
    if (!["compound", "cover_drop"].includes(body.restOverflowTo)) {
      return NextResponse.json({ error: "When-full destination must be compound or cover_drop." }, { status: 400 });
    }
    out["rest_overflow_to"] = body.restOverflowTo;
  }

  if (body.dynamicDrawdown === true || body.dynamicDrawdown === false) {
    out["dynamic_dd_enabled"] = body.dynamicDrawdown;
    out["dynamic_dd_high"] = null;
    out["dynamic_dd_tier"] = null;
    out["order_size_lit"] = null;
    if (body.dynamicDrawdown) out["curve_enabled"] = false;
  }

  // Sizing mode (2026-10-25): exactly one of flat / dynamic (gates) / curve. Switching to curve
  // clears its top so the worker plans a fresh curve at the current price with the cash it has.
  if (body.sizingMode !== undefined) {
    if (!["flat", "dynamic", "curve"].includes(body.sizingMode)) {
      return NextResponse.json({ error: "sizingMode must be flat, dynamic or curve." }, { status: 400 });
    }
    out["dynamic_dd_enabled"] = body.sizingMode === "dynamic";
    out["curve_enabled"] = body.sizingMode === "curve";
    out["dynamic_dd_high"] = null;
    out["dynamic_dd_tier"] = null;
    out["order_size_lit"] = null;
    out["curve_top"] = null;
    out["curve_cash_usd"] = null;
    out["curve_profit_base_usd"] = null;
    out["curve_state"] = null;
  }
  for (const [key, col, lo, hi, label] of [
    ["curveN", "curve_n", 1, 30, "curve n"],
    ["curveFloorLit", "curve_floor_lit", 1, 100, "curve floor (LIT)"],
  ] as const) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < lo || v > hi) {
      return NextResponse.json({ error: `${label} must be between ${lo} and ${hi} (got ${raw}).` }, { status: 400 });
    }
    out[col] = v;
  }
  if (body.resetDynamicHigh === true) {
    out["dynamic_dd_high"] = null;
    out["dynamic_dd_tier"] = null;
    out["order_size_lit"] = null;
  }

  // Gate-dependent spacing growth (2026-10-21): spacing widens base x (1,2,3,4) across the four
  // dynamic-drawdown tiers instead of staying flat. Switching it clears order_size_lit so the
  // worker re-sizes against whichever effective spacing applies next tick.
  if (body.gateSpacingGrowth === true || body.gateSpacingGrowth === false) {
    out["gate_spacing_growth_enabled"] = body.gateSpacingGrowth;
    out["order_size_lit"] = null;
    // The stored multiplier was computed for whatever tier applied the last time growth was on.
    // Clearing it (and the tier) makes the worker recompute a fresh one for the current tier,
    // instead of re-anchoring to a stale spacing on the first tick (2026-10-22 audit).
    out["gate_spacing_multiplier_value"] = null;
    out["dynamic_dd_tier"] = null;
  }

  for (const [key, col] of [
    ["spacingPct", "spacing_pct"],
    ["levelsUp", "levels_up"],
    ["levelsDown", "levels_down"],
    ["drawdownPct", "drawdown_pct"],
    ["capitalUsd", "capital_usd"],
    ["maxOpenBuys", "max_open_buys"],
  ] as const) {
    if (col === "max_open_buys" && out["max_open_buys"] === null) continue;
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const v = Number(raw);
    const lim = LIMITS[key];
    if (!Number.isFinite(v)) {
      return NextResponse.json({ error: `${lim.label}: "${raw}" is not a number.` }, { status: 400 });
    }
    if (v < lim.min || v > lim.max) {
      return NextResponse.json(
        { error: `${lim.label} must be between ${lim.min} and ${lim.max} (got ${v}).` },
        { status: 400 }
      );
    }
    out[col] = v;
  }

  if (out["spacing_pct"] !== undefined || out["capital_usd"] !== undefined || out["drawdown_pct"] !== undefined) {
    out["order_size_lit"] = null;
  }

  if (out["capital_usd"] !== undefined) {
    const shortfall = await investmentShortfallError(getSupabaseAdmin(), Number(out["capital_usd"]), TABLE);
    if (shortfall) return NextResponse.json({ error: shortfall }, { status: 400 });
  }

  if (body.restWithdrawUsd !== undefined && body.restWithdrawUsd !== null && body.restWithdrawUsd !== "") {
    const v = Number(body.restWithdrawUsd);
    const { data: cur, error: readErr } = await getSupabaseAdmin()
      .from(TABLE).select("*").eq("id", 1).single();
    if (readErr || !cur) return NextResponse.json({ error: readErr?.message ?? "State not found." }, { status: 500 });
    const rest = Number(cur.profit_bucket_rest_usd ?? 0);
    if (!Number.isFinite(v) || v <= 0 || v > rest + 1e-6) {
      return NextResponse.json({ error: `Withdrawal must be more than 0 and at most the Rest bucket ($${rest.toFixed(2)}).` }, { status: 400 });
    }
    out["rest_withdrawn_usd"] = Number(cur.rest_withdrawn_usd ?? 0) + v;
  }

  if (Object.keys(out).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  const { error } = await getSupabaseAdmin().from(TABLE).update(out).eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, applied: out });
}
