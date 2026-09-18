import { getSupabaseAdmin } from "./supabase-admin";

export type SolbtcSizeconfState = {
  id: number;
  enabled: boolean;
  side: "BTC" | "SOL";
  pending: "BTC" | "SOL" | null;
  queued_ts: number | null;
  last_fill_ts: number;
  btc_balance: number;
  sol_qty: number;
  u: number; w: number; ut: number; wt: number; last_tiny_ts: number;
  last_log_price: number | null;
  q_lag_prev: number;
  resp_num: number; resp_den: number;
  resp_buf: { ts: number; num: number; den: number }[];
  active: boolean;
  minute_buf: { movementBps: number; movementSigned: number; count: number }[];
  window_mv: number; window_sg: number; window_ct: number;
  prev_minute_close: number | null;
  er30: number;
  log_equity: number; peak_log_equity: number; tightened: boolean;
  peak_since_entry: number | null; entry_price: number | null;
  entry_fill_ts: number | null; entry_reached_10bps: boolean;
  pending_request_q: number | null;
  last_closed_minute: number | null;
  current_minute_count: number;
  current_minute_last_price: number | null;
  entry_btc: number | null;
  realized_pnl_btc: number;
  total_trades: number;
  total_wins: number;
  last_tick_at: string | null;
  lock_owner: string | null;
  lock_heartbeat: string | null;
};

export async function getSolbtcSizeconfState(): Promise<SolbtcSizeconfState> {
  const { data, error } = await getSupabaseAdmin()
    .from("solbtc_sizeconf_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolbtcSizeconfState: ${error.message}`);
  return data as SolbtcSizeconfState;
}

export async function updateSolbtcSizeconfState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("solbtc_sizeconf_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolbtcSizeconfState: ${error.message}`);
}

export async function recordSolbtcSizeconfTrade(params: {
  side_after: "BTC" | "SOL";
  fill_price: number;
  btc_before: number;
  sol_before: number;
  btc_after: number;
  sol_after: number;
  pnl_btc: number | null;
  cost_pct: number | null;
  signal_time: string;
  latency_s: number;
}) {
  const { error } = await getSupabaseAdmin()
    .from("solbtc_sizeconf_trades")
    .insert({ ...params, fill_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolbtcSizeconfTrade: ${error.message}`);

  if (params.pnl_btc !== null) {
    const state = await getSolbtcSizeconfState();
    await updateSolbtcSizeconfState({
      realized_pnl_btc: (state.realized_pnl_btc ?? 0) + params.pnl_btc,
      total_trades: (state.total_trades ?? 0) + 1,
      total_wins: (state.total_wins ?? 0) + (params.pnl_btc > 0 ? 1 : 0),
    });
  }
}

export async function logSolbtcSizeconfRun(data: object) {
  await getSupabaseAdmin()
    .from("solbtc_sizeconf_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
