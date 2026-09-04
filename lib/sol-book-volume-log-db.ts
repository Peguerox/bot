import { getSupabaseAdmin } from "./supabase-admin";

export async function recordBookVolume(params: {
  price: number;
  bidVolume250: number;
  askVolume250: number;
  bidVolume100: number;
  askVolume100: number;
  bidVolume25: number;
  askVolume25: number;
  binanceBid: number | null;
  binanceAsk: number | null;
}) {
  const ratio = (bid: number, ask: number) => (bid - ask) / (bid + ask);
  const { error } = await getSupabaseAdmin()
    .from("sol_book_volume_log")
    .insert({
      logged_at: new Date().toISOString(),
      price: params.price,
      bid_volume: params.bidVolume250,
      ask_volume: params.askVolume250,
      imbalance: ratio(params.bidVolume250, params.askVolume250),
      imbalance_100: ratio(params.bidVolume100, params.askVolume100),
      imbalance_25: ratio(params.bidVolume25, params.askVolume25),
      binance_bid: params.binanceBid,
      binance_ask: params.binanceAsk,
    });
  if (error) throw new Error(`recordBookVolume: ${error.message}`);
}
