// Temporary diagnostic task — reports this Trigger.dev Prod worker's outbound public IP,
// to verify it actually matches what's whitelisted on Binance API keys. Delete once done.
import { task } from "@trigger.dev/sdk/v3";

export const diagnosticCheckIp = task({
  id: "diagnostic-check-ip",
  run: async () => {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    return { ip: data.ip };
  },
});
