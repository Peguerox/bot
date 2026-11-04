import { NextRequest } from "next/server";
import { flipSettingsPost } from "@/lib/flip-settings";

// REAL MONEY: LIT flip martingale settings (target / stop / first % / multiplier / cap) -- applied from the next sequence.
export async function POST(req: NextRequest) {
  return flipSettingsPost(req, "lighter_lit_flip_state");
}
