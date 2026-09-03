import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const sb = getSupabaseAdmin();
  await sb.from("sol_book_volume_log").delete().gt("id", 0);
  return NextResponse.json({ ok: true });
}
