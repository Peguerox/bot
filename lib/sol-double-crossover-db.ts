import { getSupabaseAdmin } from "./supabase-admin";

export type SolDoubleCrossoverState = {
  id: number;
  enabled: boolean;
  cash: number;
  sol_qty: number;
  avg_cost: number | null;
  pending_target: number | null;
  pending_since: string | null;
  ema_360: number | null;
  ema_4320: number | null;
  ema_1440: number | null;
  ema_10080: number | null;
  r_bar: number | null;
  seeded: boolean;
  last_minute_ts: string | null;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
  lock_owner: string | null;
  lock_heartbeat: string | null;
};

export async function getSolDoubleCrossoverState(): Promise<SolDoubleCrossoverState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_double_crossover_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolDoubleCrossoverState: ${error.message}`);
  return data as SolDoubleCrossoverState;
}

export async function updateSolDoubleCrossoverState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_double_crossover_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolDoubleCrossoverState: ${error.message}`);
}

export async function recordSolDoubleCrossoverTrade(params: {
  side: "buy" | "sell";
  price: number;
  qty: number;
  usd_amount: number;
  pnl_usd: number | null;
}) {
  const { error } = await getSupabaseAdmin()
    .from("sol_double_crossover_trades")
    .insert({ ...params, trade_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolDoubleCrossoverTrade: ${error.message}`);

  if (params.side === "sell" && params.pnl_usd !== null) {
    const state = await getSolDoubleCrossoverState();
    await updateSolDoubleCrossoverState({
      realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
      total_trades: (state.total_trades ?? 0) + 1,
      total_wins: (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
    });
  } else {
    const state = await getSolDoubleCrossoverState();
    await updateSolDoubleCrossoverState({ total_trades: (state.total_trades ?? 0) + 1 });
  }
}

export async function logSolDoubleCrossoverRun(payload: { actions: Record<string, unknown>[] }) {
  const { error } = await getSupabaseAdmin()
    .from("sol_double_crossover_runs")
    .insert({ run_at: new Date().toISOString(), data: payload });
  if (error) throw new Error(`logSolDoubleCrossoverRun: ${error.message}`);
}
