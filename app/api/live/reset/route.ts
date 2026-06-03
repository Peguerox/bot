import { NextResponse } from "next/server";
import { cancelAllOrders } from "@/lib/binance";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const errors: string[] = [];

  // 1. Cancel all open ATOMUSDT orders on Binance.US
  try {
    await cancelAllOrders("ATOMUSDT");
  } catch (err) {
    errors.push(`Binance cancel: ${err}`);
  }

  // 2. Mark any open/pending/chasing positions as cancelled in DB
  const { error: dbErr } = await getSupabaseAdmin()
    .from("live_positions")
    .update({
      status:    "closed",
      result:    "CANCELLED",
      exit_time: new Date().toISOString(),
    })
    .in("status", ["pending", "open", "chasing"]);

  if (dbErr) errors.push(`DB: ${dbErr.message}`);

  return NextResponse.json({ ok: errors.length === 0, errors });
}
