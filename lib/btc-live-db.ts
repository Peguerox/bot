import { getSupabaseAdmin } from "./supabase-admin";

export async function getBtcPosition() {
  const { data } = await getSupabaseAdmin()
    .from("btc_live_positions")
    .select("*")
    .in("status", ["pending_entry", "open", "chasing"])
    .single();
  return data;
}

export async function openBtcPendingEntry(params: {
  symbol:         string;
  entry_order_id: number;
  quantity:       number;
  z_score:        number;
}) {
  await getSupabaseAdmin().from("btc_live_positions").insert({
    ...params,
    status:     "pending_entry",
    hold_count: 0,
    entry_time: new Date().toISOString(),
  });
}

export async function setBtcEntryFilled(id: string, params: {
  entry_price: number;
  quantity:    number;
  tp:          number;
  sl:          number;
  tp_order_id: number;
  sl_order_id: number;
}) {
  await getSupabaseAdmin()
    .from("btc_live_positions")
    .update({ status: "open", ...params })
    .eq("id", id);
}

export async function incrementBtcHold(id: string, currentHold: number) {
  await getSupabaseAdmin()
    .from("btc_live_positions")
    .update({ hold_count: currentHold + 1 })
    .eq("id", id);
}

export async function setBtcChasing(id: string, chaseFloor: number, slOrderId: number) {
  await getSupabaseAdmin()
    .from("btc_live_positions")
    .update({ status: "chasing", chase_price: chaseFloor, sl_order_id: slOrderId, tp_order_id: null })
    .eq("id", id);
}

export async function updateBtcChaseFloor(id: string, chaseFloor: number, slOrderId: number) {
  await getSupabaseAdmin()
    .from("btc_live_positions")
    .update({ chase_price: chaseFloor, sl_order_id: slOrderId })
    .eq("id", id);
}

export async function closeBtcPosition(id: string, params: {
  exit_price: number;
  pnl:        number;
  result:     string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("btc_live_positions")
    .update({
      status:    "closed",
      exit_time: new Date().toISOString(),
      ...params,
    })
    .eq("id", id);
  if (error) throw new Error(`closeBtcPosition failed: ${error.message}`);
}

export async function logBtcRun(data: object) {
  await getSupabaseAdmin().from("btc_live_runs").insert({
    run_at: new Date().toISOString(),
    data,
  });
}

export async function getBtcSettings() {
  const { data } = await getSupabaseAdmin()
    .from("btc_live_settings")
    .select("*")
    .single();
  return data as { id: string; enabled: boolean; pending_sell: boolean; baseline_usdt: number; usdt_balance: number; total_usdt: number } | null;
}

export async function setBtcBaseline(baseline: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("btc_live_settings").select("id").single();
  if (data) await sb.from("btc_live_settings").update({ baseline_usdt: baseline }).eq("id", data.id);
}

export async function updateBtcBalance(usdtBalance: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("btc_live_settings").select("id").single();
  if (data) await sb.from("btc_live_settings").update({ usdt_balance: usdtBalance }).eq("id", data.id);
}

export async function updateBtcTotal(totalUsdt: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("btc_live_settings").select("id").single();
  if (data) await sb.from("btc_live_settings").update({ total_usdt: totalUsdt }).eq("id", data.id);
}

export async function setBtcPendingSell(val: boolean) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("btc_live_settings").select("id").single();
  if (data) await sb.from("btc_live_settings").update({ pending_sell: val }).eq("id", data.id);
}

export async function addBtcPnl(pnl: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("btc_live_settings").select("id, usdt_balance").single();
  if (data) {
    const newBalance = Math.max(0, (data.usdt_balance ?? 0) + pnl);
    await sb.from("btc_live_settings").update({ usdt_balance: newBalance }).eq("id", data.id);
  }
}

export async function setBtcEnabled(enabled: boolean) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("btc_live_settings").select("id").single();
  await sb.from("btc_live_settings")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", data!.id);
}
