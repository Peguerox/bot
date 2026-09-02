import { getSupabaseAdmin } from "./supabase-admin";

export type Sol1MinState = {
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
  exit_reason_pending: "SL" | "TIME" | null;
  chase_attempts: number;
  cycle_started_at: string | null;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
};

export async function getSol1MinState(): Promise<Sol1MinState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_1min_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSol1MinState: ${error.message}`);
  return data as Sol1MinState;
}

export async function updateSol1MinState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_1min_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSol1MinState: ${error.message}`);
}

export async function recordSol1MinTrade(params: {
  entry_price: number;
  exit_price: number;
  sol_quantity: number;
  usd_in: number;
  usd_out: number;
  pnl_usd: number;
  pnl_pct: number;
  exit_reason: "TP" | "SL" | "TIME";
  entry_time: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("sol_1min_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSol1MinTrade: ${error.message}`);

  const state = await getSol1MinState();
  await updateSol1MinState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logSol1MinRun(data: object) {
  await getSupabaseAdmin()
    .from("sol_1min_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
