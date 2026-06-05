import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Current state
  const { data: state } = await sb.from("accumulator_state").select("*").single();
  console.log("\n=== ACCUMULATOR STATE ===");
  console.log(state);

  // Last 10 switches with full precision
  const { data: switches } = await sb
    .from("accumulator_switches")
    .select("from_asset,to_asset,sol_btc_price,btc_value_before,btc_value_after,created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  console.log("\n=== LAST 10 SWITCHES (full precision) ===");
  switches?.forEach(s => {
    const gain = s.btc_value_after - s.btc_value_before;
    console.log(
      `${s.from_asset}→${s.to_asset}`.padEnd(8),
      `price: ${s.sol_btc_price}`,
      `before: ${s.btc_value_before}`,
      `after: ${s.btc_value_after}`,
      `gain: ${gain >= 0 ? "+" : ""}${gain.toFixed(8)} BTC`,
      s.created_at.slice(11, 19)
    );
  });
}
main().catch(console.error);
