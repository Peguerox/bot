import { getSupabaseAdmin } from "./supabase-admin";

export type DcaPosition = { price: number; usd_size: number; sol_qty: number };

export type SolDcaBitfinexState = {
  id: number;
  enabled: boolean;
  mode: "USD" | "SOL";
  positions: DcaPosition[];
  total_cost: number;
  dca_count: number;
  entry_price: number | null;
  entry_time: string | null;
  last_entry_price: number | null;
  max_price: number | null;
  tp_target: number | null;
  dca_triggered: boolean;
  last_candle_ts: number | null;
  balance: number;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
  lock_owner: string | null;
  lock_heartbeat: string | null;
};

export async function getSolDcaBitfinexState(): Promise<SolDcaBitfinexState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_trail_bitfinex_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolDcaBitfinexState: ${error.message}`);
  return data as SolDcaBitfinexState;
}

export async function updateSolDcaBitfinexState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_trail_bitfinex_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolDcaBitfinexState: ${error.message}`);
}

export async function recordSolDcaBitfinexTrade(params: {
  positions: DcaPosition[];
  dca_levels: number;
  entry_price: number;
  exit_price: number;
  sol_quantity: number;
  usd_in: number;
  usd_out: number;
  pnl_usd: number;
  pnl_pct: number;
  exit_reason: "TRAIL" | "DCA_TP";
  entry_time: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("sol_trail_bitfinex_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolDcaBitfinexTrade: ${error.message}`);

  const state = await getSolDcaBitfinexState();
  await updateSolDcaBitfinexState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logSolDcaBitfinexRun(data: object) {
  await getSupabaseAdmin()
    .from("sol_trail_bitfinex_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
