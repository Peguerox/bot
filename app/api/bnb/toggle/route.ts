import { NextResponse } from "next/server";
import { setBnbEnabled, getBnbSettings } from "@/lib/bnb-live-db";

export async function POST() {
  const settings = await getBnbSettings();
  const newState = !settings?.enabled;
  await setBnbEnabled(newState);
  return NextResponse.json({ enabled: newState });
}
