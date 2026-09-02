import { getSupabaseAdmin } from "./supabase-admin";

export type SolVwapScalpState = {
  id: number;
  enabled: boolean;
  mode: "USD" | "SOL";
  sol_quantity: number | null;
  entry_price: number | null;
  entry_time: string | null;
  usd_balance: number;
  last_candle_ts: number;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
};

export async function getSolVwapScalpState(): Promise<SolVwapScalpState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_vwap_scalp_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolVwapScalpState: ${error.message}`);
  return data as SolVwapScalpState;
}

export async function updateSolVwapScalpState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_vwap_scalp_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolVwapScalpState: ${error.message}`);
}

export async function recordSolVwapScalpTrade(params: {
  entry_price: number;
  exit_price: number;
  sol_quantity: number;
  usd_in: number;
  usd_out: number;
  pnl_usd: number;
  pnl_pct: number;
  exit_reason: "TP" | "SL";
  entry_time: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("sol_vwap_scalp_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolVwapScalpTrade: ${error.message}`);

  const state = await getSolVwapScalpState();
  await updateSolVwapScalpState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logSolVwapScalpRun(data: object) {
  await getSupabaseAdmin()
    .from("sol_vwap_scalp_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
