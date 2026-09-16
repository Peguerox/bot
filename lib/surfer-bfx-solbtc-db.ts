import { getSupabaseAdmin } from "./supabase-admin";

export type SurferBfxSolbtcState = {
  id: number;
  enabled: boolean;
  mode: "BTC" | "SOL";
  sol_quantity: number | null;
  entry_price: number | null;
  entry_btc: number | null;
  entry_time: string | null;
  anchor: number | null;
  peak: number | null;
  last_candle_ts: number | null;
  realized_pnl_btc: number;
  total_trades: number;
  total_wins: number;
  lock_owner: string | null;
  lock_heartbeat: string | null;
};

export async function getSurferBfxSolbtcState(): Promise<SurferBfxSolbtcState> {
  const { data, error } = await getSupabaseAdmin()
    .from("surfer_bfx_solbtc_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSurferBfxSolbtcState: ${error.message}`);
  return data as SurferBfxSolbtcState;
}

export async function updateSurferBfxSolbtcState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("surfer_bfx_solbtc_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSurferBfxSolbtcState: ${error.message}`);
}

export async function recordSurferBfxSolbtcTrade(params: {
  buy_price: number;
  sell_price: number;
  sol_quantity: number;
  btc_in: number;
  btc_out: number;
  pnl_btc: number;
  pnl_pct: number;
  entry_time: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("surfer_bfx_solbtc_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSurferBfxSolbtcTrade: ${error.message}`);

  const state = await getSurferBfxSolbtcState();
  await updateSurferBfxSolbtcState({
    realized_pnl_btc: (state.realized_pnl_btc ?? 0) + params.pnl_btc,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_btc > 0 ? 1 : 0),
  });
}

export async function logSurferBfxSolbtcRun(data: object) {
  await getSupabaseAdmin()
    .from("surfer_bfx_solbtc_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
