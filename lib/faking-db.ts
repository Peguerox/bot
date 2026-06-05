import { getSupabaseAdmin } from "./supabase-admin";

export async function getFakingPosition() {
  const { data } = await getSupabaseAdmin()
    .from("faking_positions")
    .select("*")
    .in("status", ["open", "chasing"])
    .single();
  return data;
}

export async function openFakingPosition(params: {
  symbol:      string;
  entry_price: number;
  sl:          number;
  tp:          number;
  quantity:    number;
  z_score:     number;
  tp_order_id: number;
}) {
  await getSupabaseAdmin().from("faking_positions").insert({
    ...params,
    status:     "open",
    hold_count: 0,
    entry_time: new Date().toISOString(),
  });
}

export async function incrementFakingHold(id: string, currentHold: number) {
  await getSupabaseAdmin()
    .from("faking_positions")
    .update({ hold_count: currentHold + 1 })
    .eq("id", id);
}

export async function setFakingPositionChasing(id: string, params: {
  chase_order_id: number;
  chase_price:    number;
}) {
  await getSupabaseAdmin()
    .from("faking_positions")
    .update({ status: "chasing", ...params })
    .eq("id", id);
}

export async function updateFakingChaseOrder(id: string, params: {
  chase_order_id: number;
  chase_price:    number;
}) {
  await getSupabaseAdmin()
    .from("faking_positions")
    .update(params)
    .eq("id", id);
}

export async function closeFakingPosition(id: string, params: {
  exit_price: number;
  pnl:        number;
  result:     string;
}) {
  await getSupabaseAdmin()
    .from("faking_positions")
    .update({
      status:    "closed",
      exit_time: new Date().toISOString(),
      ...params,
    })
    .eq("id", id);
}

export async function logFakingRun(actions: object[]) {
  await getSupabaseAdmin().from("faking_runs").insert({
    created_at: new Date().toISOString(),
    actions,
  });
}

export async function getFakingSettings() {
  const { data } = await getSupabaseAdmin()
    .from("faking_settings")
    .select("*")
    .single();
  return data as { id: string; enabled: boolean; usdt_balance: number } | null;
}

export async function setFakingEnabled(enabled: boolean) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("faking_settings").select("id").single();
  await sb.from("faking_settings")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", data!.id);
}

export async function updateFakingBalance(usdtBalance: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("faking_settings").select("id").single();
  await sb.from("faking_settings")
    .update({ usdt_balance: usdtBalance, updated_at: new Date().toISOString() })
    .eq("id", data!.id);
}
