import { getSupabaseAdmin } from "./supabase-admin";

export type SolEverybarState = {
  id: number;
  enabled: boolean;
  mode: "USD" | "SOL";
  sol_quantity: number | null;
  entry_price: number | null;
  entry_time: string | null;
  usd_balance: number;
  last_candle_ts: number;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
};

export async function getSolEverybarState(): Promise<SolEverybarState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_everybar_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolEverybarState: ${error.message}`);
  return data as SolEverybarState;
}

export async function updateSolEverybarState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_everybar_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolEverybarState: ${error.message}`);
}

export async function recordSolEverybarTrade(params: {
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
    .from("sol_everybar_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolEverybarTrade: ${error.message}`);

  const state = await getSolEverybarState();
  await updateSolEverybarState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logSolEverybarRun(data: object) {
  await getSupabaseAdmin()
    .from("sol_everybar_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
