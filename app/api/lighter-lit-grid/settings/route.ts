import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Every knob from the 2026-10-17/18 research: spacing, asymmetric up/down active window (the
// "5 up / 15 down to save money" case the user asked about), drawdown depth (sizes the order
// only -- see drawdown_pct below), capital, order type, compounding.
// Bounds are sanity rails, not opinions -- same convention as lighter-hedge-settings.
const LIMITS = {
  spacingPct: { min: 0.01, max: 5, label: "grid spacing" },
  levelsUp: { min: 1, max: 500, label: "levels up" },
  levelsDown: { min: 1, max: 500, label: "levels down" },
  // Direct correction (2026-10-18): this used to be the levelsDown count, which crammed all the
  // capital into a shallow depth (15 levels = ~1.9% at 0.125% spacing) since levelsDown also
  // doubled as the small active-tracking window. drawdownPct is now its own field: it sizes the
  // order so the capital would last through that whole decline, without the bot ever actually
  // building/tracking that many levels -- it just keeps recreating the next line as price moves.
  drawdownPct: { min: 0.1, max: 95, label: "drawdown coverage" },
  capitalUsd: { min: 1, max: 10_000_000, label: "capital" },
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const out: Record<string, number | string | boolean | { buys: never[]; sells: never[] }> = {};

  for (const [key, col] of [
    ["spacingPct", "spacing_pct"],
    ["levelsUp", "levels_up"],
    ["levelsDown", "levels_down"],
    ["drawdownPct", "drawdown_pct"],
    ["capitalUsd", "capital_usd"],
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
        { error: `${lim.label} must be between ${lim.min} and ${lim.max} (got ${v}).` },
        { status: 400 }
      );
    }
    out[col] = v;
  }

  if (body.orderType !== undefined) {
    if (body.orderType !== "limit" && body.orderType !== "market") {
      return NextResponse.json({ error: `orderType must be "limit" or "market" (got "${body.orderType}").` }, { status: 400 });
    }
    out["order_type"] = body.orderType;
  }

  if (body.compoundingEnabled !== undefined) {
    if (typeof body.compoundingEnabled !== "boolean") {
      return NextResponse.json({ error: "compoundingEnabled must be true or false." }, { status: 400 });
    }
    out["compounding_enabled"] = body.compoundingEnabled;
  }

  // Changing the capital while holding a position doesn't have a clean meaning (what would the
  // held LIT's cost basis even become?) -- resetting to a fresh 100% cash start at the new
  // capital is the only sane behavior, same idea as every other bot's reset-on-settings-change
  // guards. Matches clear-history's reset.
  if (out["capital_usd"] !== undefined) {
    out["usdc_balance"] = out["capital_usd"];
    out["lit_balance"] = 0;
    out["bot_profit_usd"] = 0;
    out["open_positions_json"] = { buys: [], sells: [] };
  }

  if (Object.keys(out).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  const { error } = await getSupabaseAdmin().from("lighter_lit_grid_state").update(out).eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, applied: out });
}
