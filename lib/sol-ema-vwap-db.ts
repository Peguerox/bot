import { getSupabaseAdmin } from "./supabase-admin";

export type SolEmaVwapState = {
  id: number;
  enabled: boolean;
  position_state: "FLAT" | "ARMED" | "FULL" | "HALF";
  armed_since_ts: number | null;
  entry_price: number | null;
  entry_time: string | null;
  full_qty: number | null;
  remaining_qty: number | null;
  sl_price: number | null;
  tp_price: number | null;
  usd_balance: number;
  realized_pnl_usd: number;
  total_trades: number;
  total_wins: number;
  last_5m_candle_ts: number;
};

export async function getSolEmaVwapState(): Promise<SolEmaVwapState> {
  const { data, error } = await getSupabaseAdmin()
    .from("sol_ema_vwap_state")
    .select("*")
    .eq("id", 1)
    .single();
  if (error) throw new Error(`getSolEmaVwapState: ${error.message}`);
  return data as SolEmaVwapState;
}

export async function updateSolEmaVwapState(patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("sol_ema_vwap_state")
    .update(patch)
    .eq("id", 1);
  if (error) throw new Error(`updateSolEmaVwapState: ${error.message}`);
}

export async function recordSolEmaVwapTrade(params: {
  entry_price: number;
  exit_price: number;
  qty: number;
  usd_in: number;
  usd_out: number;
  pnl_usd: number;
  pnl_pct: number;
  exit_reason: "TP_PARTIAL" | "BREAKEVEN" | "SL";
  entry_time: string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("sol_ema_vwap_trades")
    .insert({ ...params, exit_time: new Date().toISOString() });
  if (error) throw new Error(`recordSolEmaVwapTrade: ${error.message}`);

  const state = await getSolEmaVwapState();
  await updateSolEmaVwapState({
    realized_pnl_usd: (state.realized_pnl_usd ?? 0) + params.pnl_usd,
    total_trades:     (state.total_trades ?? 0) + 1,
    total_wins:       (state.total_wins ?? 0) + (params.pnl_usd > 0 ? 1 : 0),
  });
}

export async function logSolEmaVwapRun(data: object) {
  await getSupabaseAdmin()
    .from("sol_ema_vwap_runs")
    .insert({ run_at: new Date().toISOString(), data });
}
