import { getSupabaseAdmin } from "./supabase-admin";

export type SurferBfxSolusdState = {
  id: number;
  enabled: boolean;
  mode: "USD" | "SOL";
  sol_quantity: number | null;
  entry_price: number | null;
  entry_usd: number | null;
  entry_time: string | null;
  armed_for_sol: boolean;
  best_pct: number;
  last_candle_ts: number | null;
  usd_balance: number;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
  lock_owner: string | null;
  lock_heartbeat: string | null;
};

export async function getSurferBfxSolusdState(): Promise<SurferBfxSolusdState> {
  const { data, error } = await getSupabaseAdmin()
    .from("surfer_bfx_solusd_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSurferBfxSolusdState: ${error.message}`);
  return data as SurferBfxSolusdState;
}

export async function updateSurferBfxSolusdState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("surfer_bfx_solusd_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSurferBfxSolusdState: ${error.message}`);
}

export async function recordSurferBfxSolusdTrade(params: {
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
    .from("surfer_bfx_solusd_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSurferBfxSolusdTrade: ${error.message}`);

  const state = await getSurferBfxSolusdState();
  await updateSurferBfxSolusdState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logSurferBfxSolusdRun(data: object) {
  await getSupabaseAdmin()
    .from("surfer_bfx_solusd_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
