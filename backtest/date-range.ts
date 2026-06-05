import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  const [first, last, count] = await Promise.all([
    sb.from("positions").select("entry_time").eq("status","closed").order("entry_time", { ascending: true }).limit(1),
    sb.from("positions").select("exit_time").eq("status","closed").order("exit_time", { ascending: false }).limit(1),
    sb.from("positions").select("*", { count: "exact", head: true }).eq("status","closed"),
  ]);
  const start = new Date(first.data![0].entry_time);
  const end   = new Date(last.data![0].exit_time);
  const days  = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  console.log(`First trade : ${start.toISOString()}`);
  console.log(`Last trade  : ${end.toISOString()}`);
  console.log(`Span        : ${days.toFixed(1)} days`);
  console.log(`Total trades: ${count.count}`);
  console.log(`Trades/day  : ${(count.count! / days).toFixed(1)}`);
}
main().catch(console.error);
