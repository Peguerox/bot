import { getSupabaseAdmin } from "./supabase-admin";

export type SolTrailState = {
  id: number;
  enabled: boolean;
  mode: "USD" | "SOL";
  sol_quantity: number | null;
  entry_price: number | null;
  entry_time: string | null;
  usd_balance: number;
  buy_order_id: number | null;
  stop_order_id: number | null;
  peak_price: number | null;
  stop_price: number | null;
  sl_chase_attempts: number;
  last_candle_ts: number;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
};

export async function getSolTrailState(): Promise<SolTrailState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_trail_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolTrailState: ${error.message}`);
  return data as SolTrailState;
}

export async function updateSolTrailState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_trail_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolTrailState: ${error.message}`);
}

export async function recordSolTrailTrade(params: {
  entry_price: number;
  exit_price: number;
  sol_quantity: number;
  usd_in: number;
  usd_out: number;
  pnl_usd: number;
  pnl_pct: number;
  entry_time: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("sol_trail_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolTrailTrade: ${error.message}`);

  const state = await getSolTrailState();
  await updateSolTrailState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

// Used to gate re-entry with a cooldown after a stop-loss exit — no schema change needed since
// exit_time is already recorded on every trade.
export async function getLastTrailExitTime(): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_trail_trades")
    .select("exit_time")
    .order("exit_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLastTrailExitTime: ${error.message}`);
  return data?.exit_time ?? null;
}

export async function logSolTrailRun(data: object) {
  await getSupabaseAdmin()
    .from("sol_trail_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
