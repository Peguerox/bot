import { getSupabaseAdmin } from "./supabase-admin";

export type TvBotState = {
  id:           number;
  enabled:      boolean;
  mode:         "paper" | "live";
  exchange:     string;
  symbol:       string;
  timeframe:    string;
  buy_on:       "buy" | "strong";
  sell_on:      "sell" | "strong";
  capital:      number;
  pos:          "flat" | "long";
  usdt:         number;
  sol_qty:      number;
  entry_price:  number;
  entry_signal: string;
  round_trips:  number;
  wins:         number;
  peak:         number;
  max_dd:       number;
  status:       "idle" | "chasing_buy" | "chasing_sell";
  order_id:     number | null;
  order_price:  number | null;
};

export async function getTvBotState(id: number): Promise<TvBotState> {
  const { data, error } = await getSupabaseAdmin()
    .from("tv_bot_state")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(`getTvBotState(${id}): ${error.message}`);
  return data as TvBotState;
}

export async function updateTvBotState(id: number, patch: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("tv_bot_state")
    .update(patch)
    .eq("id", id);
  if (error) throw new Error(`updateTvBotState(${id}): ${error.message}`);
}

export async function recordTvBotTrade(params: {
  bot_id:  number;
  side:    "BUY" | "SELL";
  price:   number;
  qty:     number;
  signal:  string;
  pnl_pct?: number;
}) {
  const { error } = await getSupabaseAdmin()
    .from("tv_bot_trades")
    .insert({ ...params, created_at: new Date().toISOString() });
  if (error) throw new Error(`recordTvBotTrade: ${error.message}`);
}

export async function logTvBotRun(bot_id: number, data: object) {
  await getSupabaseAdmin()
    .from("tv_bot_runs")
    .insert({ bot_id, run_at: new Date().toISOString(), data });
}
