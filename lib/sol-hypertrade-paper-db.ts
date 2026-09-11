import { getSupabaseAdmin } from "./supabase-admin";

export type HypertradePosition = { price: number; usd_size: number; sol_qty: number };

export type SolHypertradePaperState = {
  id: number;
  enabled: boolean;
  positions: HypertradePosition[];
  total_cost: number;
  level: number;
  last_entry_price: number | null;
  tp_target: number | null;
  cycle_start_time: string | null;
  realized_pnl_usd: number;
  total_cycles: number;
  total_wins: number;
  max_level_ever: number;
  max_cost_ever: number;
  lock_owner: string | null;
  lock_heartbeat: string | null;
};

export async function getSolHypertradePaperState(): Promise<SolHypertradePaperState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_hypertrade_paper_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolHypertradePaperState: ${error.message}`);
  return data as SolHypertradePaperState;
}

export async function updateSolHypertradePaperState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_hypertrade_paper_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolHypertradePaperState: ${error.message}`);
}

export async function recordSolHypertradePaperTrade(params: {
  levels: number;
  total_cost: number;
  proceeds: number;
  pnl_usd: number;
  pnl_pct: number;
  entry_time: string;
  bars_held_ms: number;
}) {
  const { error } = await getSupabaseAdmin()
    .from("sol_hypertrade_paper_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolHypertradePaperTrade: ${error.message}`);

  const state = await getSolHypertradePaperState();
  await updateSolHypertradePaperState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_cycles: (state.total_cycles ?? 0) + 1,
    total_wins: (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logSolHypertradePaperRun(payload: { actions: Record<string, unknown>[] }) {
  const { error } = await getSupabaseAdmin()
    .from("sol_hypertrade_paper_runs")
    .insert({ run_at: new Date().toISOString(), data: payload });
  if (error) throw new Error(`logSolHypertradePaperRun: ${error.message}`);
}
