import { getSupabaseAdmin } from "./supabase-admin";

export async function recordBookVolume(price: number, bidVolume: number, askVolume: number) {
  const imbalance = (bidVolume - askVolume) / (bidVolume + askVolume);
  await getSupabaseAdmin()
    .from("sol_book_volume_log")
    .insert({ logged_at: new Date().toISOString(), price, bid_volume: bidVolume, ask_volume: askVolume, imbalance });
}
