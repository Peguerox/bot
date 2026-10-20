import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { investmentShortfallError } from "@/lib/lit-grid-live-balance";
import { checkLitGridLiveAuth } from "@/lib/lit-grid-live-auth";

// REAL MONEY. Same bounds-checking convention as lighter-lit-grid/settings (the paper version)
// and lighter-hedge-settings. A capital change only changes the SIZING going forward -- unlike
// the paper bot, this never resets real usdc_balance/lit_balance (those are read from the real
// exchange, not derived from capital_usd) and never touches open_positions_json (there is none;
// holdings are reconstructed live from the order ledger, see lit_grid_live.py).
const LIMITS = {
  spacingPct: { min: 0.01, max: 5, label: "grid spacing" },
  levelsUp: { min: 1, max: 50, label: "levels up" },
  levelsDown: { min: 1, max: 50, label: "levels down" },
  drawdownPct: { min: 0.1, max: 95, label: "drawdown coverage" },
  capitalUsd: { min: 1, max: 1_000_000, label: "capital" },
  // Code-enforced cap on new buy placement (2026-10-18, audit finding: there was no actual
  // code-level limit for the single-order live-fire test, only a manual-settings convention).
  maxOpenBuys: { min: 1, max: 50, label: "max open buys" },
};

// Profit allocation feature (2026-10-18, direct request): selects which bucket NEW realized
// profit is credited to going forward. Switching modes never moves money already sitting in a
// bucket -- see lit_grid_live.py's module docstring for the full design.
const PROFIT_MODES = ["rest", "cover_drop", "compound"] as const;

export async function POST(req: NextRequest) {
  const authError = checkLitGridLiveAuth(req);
  if (authError) return authError;
  const body = await req.json();
  const out: Record<string, number | string | boolean | null> = {};

  // maxOpenBuys: 0 explicitly means "no cap" (continuous production mode) -- previously there
  // was no way to CLEAR the cap back to null once set, since undefined/null/"" were all treated
  // as "leave unchanged" (2026-10-18 audit finding).
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

  // Rest cap (2026-10-20): in rest mode, once Rest reaches the cap new profit goes to the
  // overflow bucket. 0 clears the cap.
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

  // Dynamic drawdown toggle (2026-10-19). Switching it either way, or "reset high", clears the
  // high/tier/size so the worker re-sizes from the live price on its next tick.
  if (body.dynamicDrawdown === true || body.dynamicDrawdown === false) {
    out["dynamic_dd_enabled"] = body.dynamicDrawdown;
    out["dynamic_dd_high"] = null;
    out["dynamic_dd_tier"] = null;
    out["order_size_lit"] = null;
  }
  if (body.resetDynamicHigh === true) {
    out["dynamic_dd_high"] = null;
    out["dynamic_dd_tier"] = null;
    out["order_size_lit"] = null;
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

  // Changing spacing or capital recomputes order_size_lit -- the running worker does the real
  // math (it needs the live price, which this route doesn't have); clearing it here just marks
  // "needs recompute" so the worker never trades on a stale size after a settings change.
  if (out["spacing_pct"] !== undefined || out["capital_usd"] !== undefined || out["drawdown_pct"] !== undefined) {
    out["order_size_lit"] = null;
  }

  if (out["capital_usd"] !== undefined) {
    const shortfall = await investmentShortfallError(getSupabaseAdmin(), Number(out["capital_usd"]));
    if (shortfall) return NextResponse.json({ error: shortfall }, { status: 400 });
  }

  // "Withdrew $": adds to rest_withdrawn_usd so Rest drops and can refill under the cap.
  if (body.restWithdrawUsd !== undefined && body.restWithdrawUsd !== null && body.restWithdrawUsd !== "") {
    const v = Number(body.restWithdrawUsd);
    const { data: cur, error: readErr } = await getSupabaseAdmin()
      .from("lighter_lit_grid_live_state").select("*").eq("id", 1).single();
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

  const { error } = await getSupabaseAdmin().from("lighter_lit_grid_live_state").update(out).eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, applied: out });
}
