import { NextResponse } from "next/server";
import { setBtcEnabled, getBtcSettings } from "@/lib/btc-live-db";

export async function POST() {
  const settings = await getBtcSettings();
  const newState = !settings?.enabled;
  await setBtcEnabled(newState);
  return NextResponse.json({ enabled: newState });
}
