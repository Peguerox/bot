// All database operations for the trading bot
import { getSupabaseAdmin } from "./supabase-admin";

export const PAIRS = [
  { symbol: "BNBUSDT",  name: "BNB",  allocation: 1000 },
  { symbol: "ATOMUSDT", name: "ATOM", allocation: 1000 },
];

export async function getOpenPosition(pair: string) {
  const { data } = await getSupabaseAdmin()
    .from("positions")
    .select("*")
    .eq("pair", pair)
    .in("status", ["open", "chasing"])
    .single();
  return data;
}

export async function startChasing(id: string, chasePrice: number) {
  await getSupabaseAdmin()
    .from("positions")
    .update({ status: "chasing", chase_price: chasePrice })
    .eq("id", id);
}

export async function updateChasePrice(id: string, chasePrice: number) {
  await getSupabaseAdmin()
    .from("positions")
    .update({ chase_price: chasePrice })
    .eq("id", id);
}

export async function openPosition(pair: string, signal: {
  entry: number; sl: number; tp: number; qty: number; z: number;
}) {
  await getSupabaseAdmin().from("positions").insert({
    pair,
    entry_price: signal.entry,
    sl:          signal.sl,
    tp:          signal.tp,
    quantity:    signal.qty,
    z_score:     signal.z,
    hold_count:  0,
    status:      "open",
    entry_time:  new Date().toISOString(),
  });
}

export async function incrementHold(id: string) {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("positions")
    .select("hold_count")
    .eq("id", id)
    .single();
  await sb
    .from("positions")
    .update({ hold_count: (data?.hold_count ?? 0) + 1 })
    .eq("id", id);
}

export async function closePosition(id: string, exit: {
  exit_price: number; pnl: number; result: string;
}) {
  await getSupabaseAdmin().from("positions").update({
    status:     "closed",
    exit_price: exit.exit_price,
    pnl:        exit.pnl,
    result:     exit.result,
    exit_time:  new Date().toISOString(),
  }).eq("id", id);
}

export async function getStats() {
  const sb = getSupabaseAdmin();
  const { data: trades } = await sb
    .from("positions")
    .select("pnl, result, pair, entry_time, exit_time, entry_price, exit_price, quantity")
    .eq("status", "closed")
    .order("exit_time", { ascending: false });

  const { data: open } = await sb
    .from("positions")
    .select("*")
    .in("status", ["open", "chasing"]);

  return { trades: trades ?? [], openPositions: open ?? [] };
}

export async function logRun(data: object) {
  await getSupabaseAdmin().from("bot_runs").insert({
    run_at: new Date().toISOString(),
    data,
  });
}
