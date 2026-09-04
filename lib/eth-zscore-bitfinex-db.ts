import { getSupabaseAdmin } from "./supabase-admin";

export type EthZscoreBitfinexState = {
  id: number;
  enabled: boolean;
  mode: "FLAT" | "LONG";
  eth_quantity: number | null;
  entry_price: number | null;
  entry_time: string | null;
  usd_balance: number;
  extreme_price: number | null;
  stop_price: number | null;
  entry_spread_pct: number | null;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
  lock_owner: string | null;
  lock_heartbeat: string | null;
};

export async function getEthZscoreBitfinexState(): Promise<EthZscoreBitfinexState> {
  const { data, error } = await getSupabaseAdmin()
    .from("eth_zscore_bitfinex_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getEthZscoreBitfinexState: ${error.message}`);
  return data as EthZscoreBitfinexState;
}

export async function updateEthZscoreBitfinexState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("eth_zscore_bitfinex_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateEthZscoreBitfinexState: ${error.message}`);
}

export async function recordEthZscoreBitfinexTrade(params: {
  entry_price: number;
  exit_price: number;
  eth_quantity: number;
  usd_in: number;
  usd_out: number;
  pnl_usd: number;
  pnl_pct: number;
  zscore_at_entry: number;
  entry_spread_pct: number | null;
  exit_spread_pct: number | null;
  entry_time: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("eth_zscore_bitfinex_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordEthZscoreBitfinexTrade: ${error.message}`);

  const state = await getEthZscoreBitfinexState();
  await updateEthZscoreBitfinexState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logEthZscoreBitfinexRun(data: object) {
  await getSupabaseAdmin()
    .from("eth_zscore_bitfinex_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
