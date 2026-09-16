import { getSupabaseAdmin } from "./supabase-admin";

export type SolbtcParticipationState = {
  id: number;
  enabled: boolean;
  side: "BTC" | "SOL";
  btc_balance: number;
  sol_qty: number;
  pending: "BTC" | "SOL" | null;
  virtual_side: "BTC" | "SOL";
  virtual_pending: "BTC" | "SOL" | null;
  base: "BTC" | "SOL";
  v: number;
  s_up: number;
  s_down: number;
  d: number;
  score_v: number;
  m: number;
  score_t: number;
  orientation: number;
  fast_ewma: number | null;
  slow_ewma: number | null;
  trend_variance: number;
  trend: number;
  price_ok: number;
  fast_mode: number;
  last_log_price: number | null;
  last_candle_ts: number | null;
  realized_pnl_btc: number;
  total_trades: number;
  total_wins: number;
  lock_owner: string | null;
  lock_heartbeat: string | null;
};

export async function getSolbtcParticipationState(): Promise<SolbtcParticipationState> {
  const { data, error } = await getSupabaseAdmin()
    .from("solbtc_participation_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolbtcParticipationState: ${error.message}`);
  return data as SolbtcParticipationState;
}

export async function updateSolbtcParticipationState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("solbtc_participation_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolbtcParticipationState: ${error.message}`);
}

export async function recordSolbtcParticipationTrade(params: {
  side_after: "BTC" | "SOL";
  fill_price: number;
  btc_before: number;
  sol_before: number;
  btc_after: number;
  sol_after: number;
  pnl_btc: number | null;
}) {
  const { error } = await getSupabaseAdmin()
    .from("solbtc_participation_trades")
    .insert({ ...params, fill_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolbtcParticipationTrade: ${error.message}`);

  if (params.pnl_btc !== null) {
    const state = await getSolbtcParticipationState();
    await updateSolbtcParticipationState({
      realized_pnl_btc: (state.realized_pnl_btc ?? 0) + params.pnl_btc,
      total_trades: (state.total_trades ?? 0) + 1,
      total_wins: (state.total_wins ?? 0) + (params.pnl_btc > 0 ? 1 : 0),
    });
  }
}

export async function logSolbtcParticipationRun(data: object) {
  await getSupabaseAdmin()
    .from("solbtc_participation_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
