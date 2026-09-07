import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const SYMBOLS = ["tBTCUSD", "tETHUSD"];

export async function GET() {
  const sb = getSupabaseAdmin();

  const perSymbol = await Promise.all(
    SYMBOLS.map(async (symbol) => {
      const [{ count }, { data: latestRows }] = await Promise.all([
        sb.from("market_ticks").select("*", { count: "exact", head: true }).eq("symbol", symbol),
        sb.from("market_ticks").select("*").eq("symbol", symbol).order("ts", { ascending: false }).limit(1),
      ]);
      const latest = latestRows?.[0] ?? null;
      return {
        symbol,
        count: count ?? 0,
        latestTs: latest?.ts ?? null,
        ageMs: latest ? Date.now() - new Date(latest.ts).getTime() : null,
        midPrice: latest?.mid_price ?? null,
        features: latest?.features ?? null,
        labels: latest?.labels ?? null,
      };
    })
  );

  return NextResponse.json({ ok: true, symbols: perSymbol });
}
