import { NextResponse } from "next/server";
import { setFakingEnabled, getFakingSettings } from "@/lib/faking-db";

export async function POST() {
  const settings = await getFakingSettings();
  const newState = !settings?.enabled;
  await setFakingEnabled(newState);
  return NextResponse.json({ enabled: newState });
}
