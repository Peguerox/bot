import { NextResponse } from "next/server";
import { setLiveEnabled, getLiveSettings } from "@/lib/live-db";

export async function POST() {
  const settings = await getLiveSettings();
  const newState = !settings?.enabled;
  await setLiveEnabled(newState);
  return NextResponse.json({ enabled: newState });
}
