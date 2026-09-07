import { getSupabaseAdmin } from "./supabase-admin";

export type MarketTickRow = {
  symbol: string;
  ts: string; // ISO
  mid_price: number;
  features: Record<string, unknown>;
  labels: Record<string, unknown>;
};

export async function insertMarketTick(row: MarketTickRow): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("market_ticks").insert(row);
  if (error) console.error("insertMarketTick failed:", error.message);
}
