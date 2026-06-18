import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST(req: NextRequest) {
  const { id, ...config } = await req.json();
  await getSupabaseAdmin().from("tv_bot_state").update(config).eq("id", id);
  return NextResponse.json({ ok: true });
}
