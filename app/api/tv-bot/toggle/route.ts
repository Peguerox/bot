import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST(req: NextRequest) {
  const { id } = await req.json();
  const sb = getSupabaseAdmin();
  const { data } = await sb.from("tv_bot_state").select("enabled").eq("id", id).single();
  const newEnabled = !data?.enabled;
  await sb.from("tv_bot_state").update({ enabled: newEnabled }).eq("id", id);
  return NextResponse.json({ enabled: newEnabled });
}
