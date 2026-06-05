import { NextResponse } from "next/server";
import { getFreeBalance, placeMarketSell } from "@/lib/binance";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export async function POST() {
  const errors: string[] = [];

  // Market sell any ATOM currently held
  try {
    const atomFree = await getFreeBalance("ATOM");
    if (atomFree >= 0.01) {
      const qty = Math.floor(atomFree * 100) / 100;
      await placeMarketSell("ATOMUSDT", qty);
    }
  } catch (err) {
    errors.push(`sell ATOM: ${err}`);
  }

  // Close any open position in DB
  const { error: dbErr } = await getSupabaseAdmin()
    .from("live_positions")
    .update({ status: "closed", result: "CANCELLED", exit_time: new Date().toISOString() })
    .in("status", ["open", "chasing"]);

  if (dbErr) errors.push(`DB: ${dbErr.message}`);

  return NextResponse.json({ ok: errors.length === 0, errors });
}
