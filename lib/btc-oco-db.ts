import { getSupabaseAdmin } from "./supabase-admin";

export type BtcOcoState = {
  id: number;
  enabled: boolean;
  mode: "USD" | "BTC";
  btc_quantity: number | null;
  entry_price: number | null;
  entry_time: string | null;
  usd_balance: number;
  buy_order_id: number | null;
  oco_order_list_id: number | null;
  oco_tp_order_id: number | null;
  oco_sl_order_id: number | null;
  last_candle_ts: number;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
};

export async function getBtcOcoState(): Promise<BtcOcoState> {
  const { data, error } = await getSupabaseAdmin()
    .from("btc_oco_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getBtcOcoState: ${error.message}`);
  return data as BtcOcoState;
}

export async function updateBtcOcoState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("btc_oco_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateBtcOcoState: ${error.message}`);
}

export async function recordBtcOcoTrade(params: {
  entry_price: number;
  exit_price: number;
  btc_quantity: number;
  usd_in: number;
  usd_out: number;
  pnl_usd: number;
  pnl_pct: number;
  exit_reason: "TP" | "SL";
  entry_time: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("btc_oco_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordBtcOcoTrade: ${error.message}`);

  const state = await getBtcOcoState();
  await updateBtcOcoState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logBtcOcoRun(data: object) {
  await getSupabaseAdmin()
    .from("btc_oco_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
