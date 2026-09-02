import { getSupabaseAdmin } from "./supabase-admin";

export type SolJumpTrailBitfinexState = {
  id: number;
  enabled: boolean;
  mode: "FLAT" | "LONG" | "SHORT";
  sol_quantity: number | null;
  entry_price: number | null;
  entry_time: string | null;
  usd_balance: number;
  extreme_price: number | null;
  stop_price: number | null;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
  lock_owner: string | null;
  lock_heartbeat: string | null;
};

export async function getSolJumpTrailBitfinexState(): Promise<SolJumpTrailBitfinexState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_jump_trail_bitfinex_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolJumpTrailBitfinexState: ${error.message}`);
  return data as SolJumpTrailBitfinexState;
}

export async function updateSolJumpTrailBitfinexState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_jump_trail_bitfinex_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolJumpTrailBitfinexState: ${error.message}`);
}

export async function recordSolJumpTrailBitfinexTrade(params: {
  direction: "LONG" | "SHORT";
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
    .from("sol_jump_trail_bitfinex_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolJumpTrailBitfinexTrade: ${error.message}`);

  const state = await getSolJumpTrailBitfinexState();
  await updateSolJumpTrailBitfinexState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logSolJumpTrailBitfinexRun(data: object) {
  await getSupabaseAdmin()
    .from("sol_jump_trail_bitfinex_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
