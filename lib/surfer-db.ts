import { getSupabaseAdmin } from "./supabase-admin";

export type SurferState = {
  id: number;
  enabled: boolean;
  mode: "BTC" | "SOL";
  status: "idle" | "chasing_buy" | "chasing_sell";
  armed_for_sol: boolean;
  armed_for_btc: boolean;
  last_candle_ts: number;
  sol_quantity: number | null;
  entry_price: number | null;
  entry_btc: number | null;
  entry_time: string | null;
  chase_order_id: number | null;
  chase_price: number | null;
  best_pct: number;
  realized_pnl_btc: number;
  total_trades: number;
  total_wins: number;
  anchor: number | null;
  peak: number | null;
};

export async function getSurferState(): Promise<SurferState> {
  const { data, error } = await getSupabaseAdmin()
    .from("surfer_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSurferState: ${error.message}`);
  return data as SurferState;
}

export async function updateSurferState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("surfer_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSurferState: ${error.message}`);
}

export async function recordSurferTrade(params: {
  buy_price: number;
  sell_price: number;
  sol_quantity: number;
  btc_in: number;
  btc_out: number;
  pnl_btc: number;
  pnl_pct: number;
  entry_time: string;
  result: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("surfer_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSurferTrade: ${error.message}`);

  const state = await getSurferState();
  await updateSurferState({
    realized_pnl_btc: (state.realized_pnl_btc ?? 0) + params.pnl_btc,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_btc > 0 ? 1 : 0),
  });
}

export async function logSurferRun(data: object) {
  await getSupabaseAdmin()
    .from("surfer_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
