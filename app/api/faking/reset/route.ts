import { NextResponse } from "next/server";
import { cancelAllOrders } from "@/lib/binance";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const errors: string[] = [];

  try {
    await cancelAllOrders("ATOMUSDT");
  } catch (err) {
    errors.push(`Binance cancel: ${err}`);
  }

  const { error: dbErr } = await getSupabaseAdmin()
    .from("faking_positions")
    .update({
      status:    "closed",
      result:    "CANCELLED",
      exit_time: new Date().toISOString(),
    })
    .in("status", ["open", "chasing"]);

  if (dbErr) errors.push(`DB: ${dbErr.message}`);

  return NextResponse.json({ ok: errors.length === 0, errors });
}
