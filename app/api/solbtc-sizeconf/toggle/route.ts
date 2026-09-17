import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("solbtc_sizeconf_state").select("enabled").eq("id", 1).single();
  const newState = !data?.enabled;
  await sb.from("solbtc_sizeconf_state").update({ enabled: newState }).eq("id", 1);
  return NextResponse.json({ enabled: newState });
}
