import { NextResponse } from "next/server";
import { setXlmEnabled, getXlmSettings } from "@/lib/xlm-live-db";

export async function POST() {
  const settings = await getXlmSettings();
  const newState = !settings?.enabled;
  await setXlmEnabled(newState);
  return NextResponse.json({ enabled: newState });
}
