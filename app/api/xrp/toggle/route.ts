import { NextResponse } from "next/server";
import { setXrpEnabled, getXrpSettings } from "@/lib/xrp-live-db";

export async function POST() {
  const settings = await getXrpSettings();
  const newState = !settings?.enabled;
  await setXrpEnabled(newState);
  return NextResponse.json({ enabled: newState });
}
