import { getSupabaseAdmin } from "./supabase-admin";

export type SolVwapLiveState = {
  id: number;
  enabled: boolean;
  mode: "USD" | "SOL";
  sol_quantity: number | null;
  entry_price: number | null;
  entry_time: string | null;
  usd_balance: number;
  buy_order_id: number | null;
  oco_order_list_id: number | null;
  oco_tp_order_id: number | null;
  oco_sl_order_id: number | null;
  exit_order_id: number | null;
  chase_attempts: number;
  last_candle_ts: number;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
};

export async function getSolVwapLiveState(): Promise<SolVwapLiveState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_vwap_live_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolVwapLiveState: ${error.message}`);
  return data as SolVwapLiveState;
}

export async function updateSolVwapLiveState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_vwap_live_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolVwapLiveState: ${error.message}`);
}

export async function recordSolVwapLiveTrade(params: {
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
    .from("sol_vwap_live_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolVwapLiveTrade: ${error.message}`);

  const state = await getSolVwapLiveState();
  await updateSolVwapLiveState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logSolVwapLiveRun(data: object) {
  await getSupabaseAdmin()
    .from("sol_vwap_live_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
