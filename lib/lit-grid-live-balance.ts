import type { SupabaseClient } from "@supabase/supabase-js";

// The investment (capital_usd) can never be more than the money actually in the account.
// Real balances come from the running worker, which re-reads them from the exchange every ~10s
// and stamps updated_at each tick; if it hasn't reported recently we can't verify, so refuse.
export async function investmentShortfallError(sb: SupabaseClient, capitalUsd: number): Promise<string | null> {
  const { data, error } = await sb
    .from("lighter_lit_grid_live_state")
    .select("usdc_balance,lit_balance,live_price,updated_at")
    .eq("id", 1)
    .single();
  if (error || !data) return `Can't read the real balance: ${error?.message ?? "no state row"}.`;
  const ageMs = data.updated_at ? Date.now() - new Date(data.updated_at).getTime() : Infinity;
  if (!(ageMs < 60_000) || data.usdc_balance == null || data.lit_balance == null || data.live_price == null) {
    return "Can't verify your real balance: the bot hasn't reported in the last minute. Try again shortly.";
  }
  const usdc = Number(data.usdc_balance);
  const lit = Number(data.lit_balance);
  const total = usdc + lit * Number(data.live_price);
  if (capitalUsd > total + 0.005) {
    const max = Math.floor(total * 100) / 100;
    return `Investment $${capitalUsd.toFixed(2)} is more than you have: $${total.toFixed(2)} ` +
      `($${usdc.toFixed(2)} USDC + ${lit.toFixed(2)} LIT). Set the investment to $${max.toFixed(2)} or less, or deposit more.`;
  }
  return null;
}
