import { getSupabaseAdmin } from "./supabase-admin";

export async function recordBookVolume(price: number, bidVolume: number, askVolume: number) {
  const imbalance = (bidVolume - askVolume) / (bidVolume + askVolume);
  const { error } = await getSupabaseAdmin()
    .from("sol_book_volume_log")
    .insert({ logged_at: new Date().toISOString(), price, bid_volume: bidVolume, ask_volume: askVolume, imbalance });
  if (error) throw new Error(`recordBookVolume: ${error.message}`);
}
