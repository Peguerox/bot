import { getSupabaseAdmin } from "./supabase-admin";

export type SolTrailChaseState = {
  id: number;
  enabled: boolean;
  mode: "USD" | "SOL";
  sol_quantity: number | null;
  entry_price: number | null;
  entry_time: string | null;
  usd_balance: number;
  peak_price: number | null;
  stop_price: number | null;
  last_candle_ts: number;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
};

export async function getSolTrailChaseState(): Promise<SolTrailChaseState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_trail_chase_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolTrailChaseState: ${error.message}`);
  return data as SolTrailChaseState;
}

export async function updateSolTrailChaseState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_trail_chase_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolTrailChaseState: ${error.message}`);
}

export async function recordSolTrailChaseTrade(params: {
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
    .from("sol_trail_chase_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolTrailChaseTrade: ${error.message}`);

  const state = await getSolTrailChaseState();
  await updateSolTrailChaseState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logSolTrailChaseRun(data: object) {
  await getSupabaseAdmin()
    .from("sol_trail_chase_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
