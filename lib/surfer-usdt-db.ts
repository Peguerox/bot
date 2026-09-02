import { getSupabaseAdmin } from "./supabase-admin";

export type SurferUsdtState = {
  id: number;
  enabled: boolean;
  mode: "USDT" | "SOL";
  status: "idle" | "chasing_buy" | "chasing_sell";
  armed_for_sol: boolean;
  last_candle_ts: number;
  sol_quantity: number | null;
  entry_price: number | null;
  entry_usdt: number | null;
  entry_time: string | null;
  chase_order_id: number | null;
  chase_price: number | null;
  usdt_balance: number;
  best_pct: number;
  realized_pnl_usdt: number;
  total_trades: number;
  total_wins: number;
};

export async function getSurferUsdtState(): Promise<SurferUsdtState> {
  const { data, error } = await getSupabaseAdmin()
    .from("surfer_usdt_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSurferUsdtState: ${error.message}`);
  return data as SurferUsdtState;
}

export async function updateSurferUsdtState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("surfer_usdt_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSurferUsdtState: ${error.message}`);
}

export async function recordSurferUsdtTrade(params: {
  entry_price: number;
  exit_price: number;
  sol_quantity: number;
  usdt_in: number;
  usdt_out: number;
  pnl_usdt: number;
  pnl_pct: number;
  entry_time: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("surfer_usdt_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSurferUsdtTrade: ${error.message}`);

  const state = await getSurferUsdtState();
  await updateSurferUsdtState({
    realized_pnl_usdt: (state.realized_pnl_usdt ?? 0) + params.pnl_usdt,
    total_trades:      (state.total_trades ?? 0) + 1,
    total_wins:        (state.total_wins ?? 0) + (params.pnl_usdt > 0 ? 1 : 0),
  });
}

export async function logSurferUsdtRun(data: object) {
  await getSupabaseAdmin()
    .from("surfer_usdt_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
