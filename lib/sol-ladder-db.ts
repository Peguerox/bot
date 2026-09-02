import { getSupabaseAdmin } from "./supabase-admin";

export type SolLadderState = {
  id: number;
  enabled: boolean;
  mode: "USD" | "SOL";
  sol_quantity: number | null;
  entry_price: number | null;
  entry_time: string | null;
  usd_balance: number;
  buy_order_id: number | null;
  oco_order_list_id: number | null;
  oco_tp_order_id: number | null;
  oco_sl_order_id: number | null;
  next_checkpoint_idx: number;
  sl_chase_attempts: number;
  last_candle_ts: number;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
};

export async function getSolLadderState(): Promise<SolLadderState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_ladder_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolLadderState: ${error.message}`);
  return data as SolLadderState;
}

export async function updateSolLadderState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_ladder_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolLadderState: ${error.message}`);
}

export async function recordSolLadderTrade(params: {
  entry_price: number;
  exit_price: number;
  sol_quantity: number;
  usd_in: number;
  usd_out: number;
  pnl_usd: number;
  pnl_pct: number;
  exit_reason: "TP" | "SL";
  entry_time: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("sol_ladder_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolLadderTrade: ${error.message}`);

  const state = await getSolLadderState();
  await updateSolLadderState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

// Used to gate re-entry with a cooldown after any exit (TP or SL) — same pattern as the Trail
// bot's getLastTrailExitTime, no schema change needed since exit_time is already recorded.
export async function getLastLadderExitTime(): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_ladder_trades")
    .select("exit_time")
    .order("exit_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLastLadderExitTime: ${error.message}`);
  return data?.exit_time ?? null;
}

export async function logSolLadderRun(data: object) {
  await getSupabaseAdmin()
    .from("sol_ladder_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
