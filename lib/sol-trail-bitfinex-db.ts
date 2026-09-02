import { getSupabaseAdmin } from "./supabase-admin";

export type SolTrailBitfinexState = {
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

export async function getSolTrailBitfinexState(): Promise<SolTrailBitfinexState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_trail_bitfinex_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolTrailBitfinexState: ${error.message}`);
  return data as SolTrailBitfinexState;
}

export async function updateSolTrailBitfinexState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_trail_bitfinex_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolTrailBitfinexState: ${error.message}`);
}

export async function recordSolTrailBitfinexTrade(params: {
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
    .from("sol_trail_bitfinex_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolTrailBitfinexTrade: ${error.message}`);

  const state = await getSolTrailBitfinexState();
  await updateSolTrailBitfinexState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logSolTrailBitfinexRun(data: object) {
  await getSupabaseAdmin()
    .from("sol_trail_bitfinex_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
