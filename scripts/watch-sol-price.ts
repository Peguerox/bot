import WebSocket from "ws";

const ws = new WebSocket("wss://stream.binance.us:9443/ws/solusdt@miniTicker");

ws.on("open", () => {
  process.stdout.write("\x1Bc"); // clear screen
  console.log("SOL/USDT live price  (Ctrl+C to stop)\n");
});

ws.on("message", (raw) => {
  const d = JSON.parse(raw.toString());
  const price = parseFloat(d.c).toFixed(2);
  const time  = new Date().toLocaleTimeString();
  console.log(`  ${time}   $${price}`);
});

ws.on("error", (e) => console.error("WS error:", e.message));
ws.on("close", () => console.log("\nDisconnected."));
