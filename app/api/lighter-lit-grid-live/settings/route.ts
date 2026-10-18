import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

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
};

export async function POST(req: NextRequest) {
  const body = await req.json();
  const out: Record<string, number> = {};

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

  if (Object.keys(out).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  // Changing spacing or capital recomputes order_size_lit -- the running worker does the real
  // math (it needs the live price, which this route doesn't have); clearing it here just marks
  // "needs recompute" so the worker never trades on a stale size after a settings change.
  if (out["spacing_pct"] !== undefined || out["capital_usd"] !== undefined || out["drawdown_pct"] !== undefined) {
    (out as Record<string, number | null>)["order_size_lit"] = null;
  }

  const { error } = await getSupabaseAdmin().from("lighter_lit_grid_live_state").update(out).eq("id", 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, applied: out });
}
