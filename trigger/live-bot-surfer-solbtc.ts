// Surfer (SOL/BTC) -- DISABLED 2026-09-24. Full strategy archived at
// docs/archive/live-bot-surfer-solbtc-v2.ts.txt (restore by copying it back over this file,
// same task id, same cron, same DB tables). This stub exists only so `trigger.dev deploy` has
// something to build -- it carries no cron, which is what actually unregisters the schedule
// from Trigger.dev's cloud once deployed (a real network object, not just a local file).
import { schedules } from "@trigger.dev/sdk/v3";

export const surferSolBtcBot = schedules.task({
  id: "live-bot-surfer-solbtc-1m",
  maxDuration: 55,
  run: async () => {
    return { ok: false, reason: "disabled -- see docs/archive/live-bot-surfer-solbtc-v2.ts.txt" };
  },
});
