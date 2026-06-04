import { NextResponse } from "next/server";
import { getFreeBalance } from "@/lib/binance";

export async function GET() {
  const [usdt, atom] = await Promise.all([
    getFreeBalance("USDT"),
    getFreeBalance("ATOM"),
  ]);
  return NextResponse.json({ usdt, atom });
}
