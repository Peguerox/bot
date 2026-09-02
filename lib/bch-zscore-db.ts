import { getSupabaseAdmin } from "./supabase-admin";

export type BchZscoreState = {
  id: number;
  enabled: boolean;
  mode: "USD" | "BCH";
  bch_quantity: number | null;
  entry_price: number | null;
  entry_time: string | null;
  usd_balance: number;
  last_candle_ts: number;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
};

export async function getBchZscoreState(): Promise<BchZscoreState> {
  const { data, error } = await getSupabaseAdmin()
    .from("bch_zscore_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getBchZscoreState: ${error.message}`);
  return data as BchZscoreState;
}

export async function updateBchZscoreState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("bch_zscore_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateBchZscoreState: ${error.message}`);
}

export async function recordBchZscoreTrade(params: {
  entry_price: number;
  exit_price: number;
  bch_quantity: number;
  usd_in: number;
  usd_out: number;
  pnl_usd: number;
  pnl_pct: number;
  exit_reason: "TP" | "SL";
  entry_time: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("bch_zscore_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordBchZscoreTrade: ${error.message}`);

  const state = await getBchZscoreState();
  await updateBchZscoreState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logBchZscoreRun(data: object) {
  await getSupabaseAdmin()
    .from("bch_zscore_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
