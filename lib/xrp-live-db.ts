import { getSupabaseAdmin } from "./supabase-admin";

export async function getXrpPosition() {
  const { data } = await getSupabaseAdmin()
    .from("xrp_live_positions")
    .select("*")
    .in("status", ["pending_entry", "open", "chasing"])
    .single();
  return data;
}

export async function openXrpPendingEntry(params: {
  symbol:         string;
  entry_order_id: number;
  quantity:       number;
  z_score:        number;
}) {
  await getSupabaseAdmin().from("xrp_live_positions").insert({
    ...params,
    status:     "pending_entry",
    hold_count: 0,
    entry_time: new Date().toISOString(),
  });
}

export async function setXrpEntryFilled(id: string, params: {
  entry_price: number;
  quantity:    number;
  tp:          number;
  sl:          number;
  tp_order_id: number;
  sl_order_id: number;
}) {
  await getSupabaseAdmin()
    .from("xrp_live_positions")
    .update({ status: "open", ...params })
    .eq("id", id);
}

export async function incrementXrpHold(id: string, currentHold: number) {
  await getSupabaseAdmin()
    .from("xrp_live_positions")
    .update({ hold_count: currentHold + 1 })
    .eq("id", id);
}

export async function setXrpChasing(id: string, chasePrice: number, slOrderId: number) {
  await getSupabaseAdmin()
    .from("xrp_live_positions")
    .update({ status: "chasing", chase_price: chasePrice, sl_order_id: slOrderId, tp_order_id: null })
    .eq("id", id);
}

export async function updateXrpChaseFloor(id: string, chasePrice: number, slOrderId: number) {
  await getSupabaseAdmin()
    .from("xrp_live_positions")
    .update({ chase_price: chasePrice, sl_order_id: slOrderId })
    .eq("id", id);
}

export async function closeXrpPosition(id: string, params: {
  exit_price: number;
  pnl:        number;
  result:     string;
}) {
  const { error } = await getSupabaseAdmin()
    .from("xrp_live_positions")
    .update({
      status:    "closed",
      exit_time: new Date().toISOString(),
      ...params,
    })
    .eq("id", id);
  if (error) throw new Error(`closeXrpPosition failed: ${error.message}`);
}

export async function logXrpRun(data: object) {
  await getSupabaseAdmin().from("xrp_live_runs").insert({
    run_at: new Date().toISOString(),
    data,
  });
}

export async function getXrpSettings() {
  const { data } = await getSupabaseAdmin()
    .from("xrp_live_settings")
    .select("*")
    .single();
  return data as { id: string; enabled: boolean; pending_sell: boolean; baseline_usdt: number; usdt_balance: number; total_usdt: number } | null;
}

export async function setXrpBaseline(baseline: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("xrp_live_settings").select("id").single();
  if (data) await sb.from("xrp_live_settings").update({ baseline_usdt: baseline }).eq("id", data.id);
}

export async function updateXrpBalance(usdtBalance: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("xrp_live_settings").select("id").single();
  if (data) await sb.from("xrp_live_settings").update({ usdt_balance: usdtBalance }).eq("id", data.id);
}

export async function updateXrpTotal(totalUsdt: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("xrp_live_settings").select("id").single();
  if (data) await sb.from("xrp_live_settings").update({ total_usdt: totalUsdt }).eq("id", data.id);
}

export async function setXrpPendingSell(val: boolean) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("xrp_live_settings").select("id").single();
  if (data) await sb.from("xrp_live_settings").update({ pending_sell: val }).eq("id", data.id);
}

export async function addXrpPnl(pnl: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("xrp_live_settings").select("id, usdt_balance").single();
  if (data) {
    const newBalance = Math.max(0, (data.usdt_balance ?? 0) + pnl);
    await sb.from("xrp_live_settings").update({ usdt_balance: newBalance }).eq("id", data.id);
  }
}

export async function setXrpEnabled(enabled: boolean) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("xrp_live_settings").select("id").single();
  await sb.from("xrp_live_settings")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", data!.id);
}
