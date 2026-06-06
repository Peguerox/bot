import { getSupabaseAdmin } from "./supabase-admin";

export async function getLivePosition() {
  const { data } = await getSupabaseAdmin()
    .from("live_positions")
    .select("*")
    .in("status", ["open", "chasing"])
    .single();
  return data;
}

export async function openLivePosition(params: {
  symbol:      string;
  entry_price: number;
  sl:          number;
  tp:          number;
  quantity:    number;
  z_score:     number;
}) {
  await getSupabaseAdmin().from("live_positions").insert({
    ...params,
    status:     "open",
    hold_count: 0,
    entry_time: new Date().toISOString(),
  });
}

export async function incrementLiveHold(id: string, currentHold: number) {
  await getSupabaseAdmin()
    .from("live_positions")
    .update({ hold_count: currentHold + 1 })
    .eq("id", id);
}

export async function setLiveChasing(id: string, chaseFloor: number) {
  await getSupabaseAdmin()
    .from("live_positions")
    .update({ status: "chasing", chase_price: chaseFloor })
    .eq("id", id);
}

export async function updateLiveChaseFloor(id: string, chaseFloor: number) {
  await getSupabaseAdmin()
    .from("live_positions")
    .update({ chase_price: chaseFloor })
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
      status:    "closed",
      exit_time: new Date().toISOString(),
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
  return data as { id: string; enabled: boolean; pending_sell: boolean; baseline_usdt: number; usdt_balance: number } | null;
}

export async function setBaseline(baseline: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("live_settings").select("id").single();
  if (data) await sb.from("live_settings").update({ baseline_usdt: baseline }).eq("id", data.id);
}

export async function updateLiveBalance(usdtBalance: number) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("live_settings").select("id").single();
  if (data) await sb.from("live_settings").update({ usdt_balance: usdtBalance }).eq("id", data.id);
}

export async function setPendingSell(val: boolean) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("live_settings").select("id").single();
  if (data) await sb.from("live_settings").update({ pending_sell: val }).eq("id", data.id);
}

export async function getLivePnLSum(): Promise<number> {
  const { data } = await getSupabaseAdmin()
    .from("live_positions")
    .select("pnl")
    .eq("status", "closed");
  return (data ?? []).reduce((sum: number, p: any) => sum + (p.pnl ?? 0), 0);
}

export async function setLiveEnabled(enabled: boolean) {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("live_settings").select("id").single();
  await sb.from("live_settings")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", data!.id);
}

