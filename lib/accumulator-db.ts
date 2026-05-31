import { getSupabaseAdmin } from "./supabase-admin";

export async function getAccumulatorState() {
  const { data } = await getSupabaseAdmin()
    .from("accumulator_state")
    .select("*")
    .single();
  return data as {
    id: string;
    holding: "BTC" | "SOL";
    quantity: number;
    btc_value: number;
    switches: number;
    updated_at: string;
  } | null;
}

export async function initAccumulatorState(btcQty: number) {
  await getSupabaseAdmin().from("accumulator_state").insert({
    holding:   "BTC",
    quantity:  btcQty,
    btc_value: btcQty,
    switches:  0,
  });
}

export async function updateAccumulatorState(opts: {
  holding:  "BTC" | "SOL";
  quantity: number;
  btcValue: number;
  switches: number;
}) {
  await getSupabaseAdmin()
    .from("accumulator_state")
    .update({
      holding:    opts.holding,
      quantity:   opts.quantity,
      btc_value:  opts.btcValue,
      switches:   opts.switches,
      updated_at: new Date().toISOString(),
    })
    .neq("id", "00000000-0000-0000-0000-000000000000");
}

export async function logSwitch(opts: {
  from:           "BTC" | "SOL";
  to:             "BTC" | "SOL";
  solBtcPrice:    number;
  btcValueBefore: number;
  btcValueAfter:  number;
}) {
  await getSupabaseAdmin().from("accumulator_switches").insert({
    from_asset:       opts.from,
    to_asset:         opts.to,
    sol_btc_price:    opts.solBtcPrice,
    btc_value_before: opts.btcValueBefore,
    btc_value_after:  opts.btcValueAfter,
  });
}
