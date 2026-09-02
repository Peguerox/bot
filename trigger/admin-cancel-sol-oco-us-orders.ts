// One-off manual utility — cancels all open SOLUSDT orders on Binance.US. Not scheduled; only
// runs when manually triggered. Used to force a clean slate (e.g. after pausing a bot with a
// resting order still open) since Binance.US only accepts calls from whitelisted IPs, which
// rules out running this from a local machine — it has to run through Trigger.dev's own
// infrastructure like the real bots do.
import { task } from "@trigger.dev/sdk/v3";
import { cancelAllOrders } from "../lib/binance";

export const adminCancelSolOcoUsOrders = task({
  id: "admin-cancel-sol-oco-us-orders",
  run: async () => {
    const result = await cancelAllOrders("SOLUSDT");
    return { ok: true, result };
  },
});
