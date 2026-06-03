import { getSupabaseAdmin } from "./supabase-admin";

export async function getLivePosition() {
  const { data } = await getSupabaseAdmin()
    .from("live_positions")
    .select("*")
    .in("status", ["pending", "open", "chasing"])
    .single();
  return data;
}

export async function openLivePosition(params: {
  symbol:          string;
  entry_price:     number;
  sl:              number;
  tp:              number;
  quantity:        number;
  z_score:         number;
  entry_order_id:  number;
}) {
  await getSupabaseAdmin().from("live_positions").insert({
    ...params,
    status:     "pending",
    hold_count: 0,
    entry_time: new Date().toISOString(),
  });
}

export async function setLivePositionOpen(id: string, params: {
  entry_price:        number;
  quantity:           number;
  tp:                 number;
  sl:                 number;
  tp_order_id:        number;
  sl_order_id:        number;
  oco_order_list_id:  number;
}) {
  await getSupabaseAdmin()
    .from("live_positions")
    .update({ status: "open", ...params })
    .eq("id", id);
}

export async function incrementLiveHold(id: string, currentHold: number) {
  await getSupabaseAdmin()
    .from("live_positions")
    .update({ hold_count: currentHold + 1 })
    .eq("id", id);
}

export async function setLivePositionChasing(id: string, params: {
  chase_order_id: number;
  chase_price:    number;
}) {
  await getSupabaseAdmin()
    .from("live_positions")
    .update({ status: "chasing", ...params })
    .eq("id", id);
}

export async function updateLiveChaseOrder(id: string, params: {
  chase_order_id: number;
  chase_price:    number;
}) {
  await getSupabaseAdmin()
    .from("live_positions")
    .update(params)
    .eq("id", id);
}

export async function closeLivePosition(id: string, params: {
  exit_price: number;
  pnl:        number;
  result:     string;
}) {
  await getSupabaseAdmin()
    .from("live_positions")
    .update({
      status:     "closed",
      exit_time:  new Date().toISOString(),
      ...params,
    })
    .eq("id", id);
}

export async function logLiveRun(data: object) {
  await getSupabaseAdmin().from("live_runs").insert({
    run_at: new Date().toISOString(),
    data,
  });
}

export async function getLiveSettings() {
  const { data } = await getSupabaseAdmin()
    .from("live_settings")
    .select("*")
    .single();
  return data as { id: string; enabled: boolean; usdt_balance: number } | null;
}

export async function setLiveEnabled(enabled: boolean) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("live_settings").select("id").single();
  await sb.from("live_settings")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", data!.id);
}

export async function updateLiveBalance(usdtBalance: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("live_settings").select("id").single();
  await sb.from("live_settings")
    .update({ usdt_balance: usdtBalance, updated_at: new Date().toISOString() })
    .eq("id", data!.id);
}
