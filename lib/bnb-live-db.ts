import { getSupabaseAdmin } from "./supabase-admin";

export async function getBnbPosition() {
  const { data } = await getSupabaseAdmin()
    .from("bnb_live_positions")
    .select("*")
    .in("status", ["pending_entry", "open", "chasing"])
    .single();
  return data;
}

export async function openBnbPendingEntry(params: {
  symbol:         string;
  entry_order_id: number;
  quantity:       number;
}) {
  await getSupabaseAdmin().from("bnb_live_positions").insert({
    ...params,
    status:     "pending_entry",
    hold_count: 0,
    entry_time: new Date().toISOString(),
  });
}

export async function setBnbEntryFilled(id: string, params: {
  entry_price: number;
  quantity:    number;
  tp:          number;
  sl:          number;
  tp_order_id: number;
  sl_order_id: number;
}) {
  await getSupabaseAdmin()
    .from("bnb_live_positions")
    .update({ status: "open", ...params })
    .eq("id", id);
}

export async function incrementBnbHold(id: string, currentHold: number) {
  await getSupabaseAdmin()
    .from("bnb_live_positions")
    .update({ hold_count: currentHold + 1 })
    .eq("id", id);
}

export async function setBnbChasing(id: string, chaseFloor: number, slOrderId: number) {
  await getSupabaseAdmin()
    .from("bnb_live_positions")
    .update({ status: "chasing", chase_price: chaseFloor, sl_order_id: slOrderId, tp_order_id: null })
    .eq("id", id);
}

export async function updateBnbChaseFloor(id: string, chaseFloor: number, slOrderId: number) {
  await getSupabaseAdmin()
    .from("bnb_live_positions")
    .update({ chase_price: chaseFloor, sl_order_id: slOrderId })
    .eq("id", id);
}

export async function closeBnbPosition(id: string, params: {
  exit_price: number;
  pnl:        number;
  result:     string;
}) {
  await getSupabaseAdmin()
    .from("bnb_live_positions")
    .update({
      status:    "closed",
      exit_time: new Date().toISOString(),
      ...params,
    })
    .eq("id", id);
}

export async function logBnbRun(data: object) {
  await getSupabaseAdmin().from("bnb_live_runs").insert({
    run_at: new Date().toISOString(),
    data,
  });
}

export async function getBnbSettings() {
  const { data } = await getSupabaseAdmin()
    .from("bnb_live_settings")
    .select("*")
    .single();
  return data as { id: string; enabled: boolean; pending_sell: boolean; baseline_usdt: number; usdt_balance: number } | null;
}

export async function setBnbBaseline(baseline: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("bnb_live_settings").select("id").single();
  if (data) await sb.from("bnb_live_settings").update({ baseline_usdt: baseline }).eq("id", data.id);
}

export async function updateBnbBalance(usdtBalance: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("bnb_live_settings").select("id").single();
  if (data) await sb.from("bnb_live_settings").update({ usdt_balance: usdtBalance }).eq("id", data.id);
}

export async function setBnbPendingSell(val: boolean) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("bnb_live_settings").select("id").single();
  if (data) await sb.from("bnb_live_settings").update({ pending_sell: val }).eq("id", data.id);
}

export async function getBnbPnLSum(): Promise<number> {
  const { data } = await getSupabaseAdmin()
    .from("bnb_live_positions")
    .select("pnl")
    .eq("status", "closed");
  return (data ?? []).reduce((sum: number, p: any) => sum + (p.pnl ?? 0), 0);
}

export async function setBnbEnabled(enabled: boolean) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("bnb_live_settings").select("id").single();
  await sb.from("bnb_live_settings")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", data!.id);
}
