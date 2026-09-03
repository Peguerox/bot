// Same statistical test as the bid-to-bid version, but for ask-to-ask: does the pattern differ?
import WebSocket from "ws";

const DURATION_MS = 10 * 60_000;
const WIDEN_PCT = 0.02;
const WIDEN_WINDOW_MS = 5000;
const LOOKAHEAD_MS = 10000;
const DEDUPE_MS = 5000;

let binanceAsk: number | null = null, bfxAsk: number | null = null;
const gapHistory: { t: number; gap: number }[] = [];
const bfxAskHistory: { t: number; p: number }[] = [];

type Event = { t: number; gapBefore: number; gapAfter: number; bfxAskBefore: number };
const events: Event[] = [];
let lastEventT = -Infinity;

function checkWiden() {
  if (gapHistory.length < 2) return;
  const now = gapHistory[gapHistory.length - 1];
  while (gapHistory.length > 1 && now.t - gapHistory[0].t > WIDEN_WINDOW_MS) gapHistory.shift();
  const old = gapHistory[0];
  const widenAmount = old.gap - now.gap;
  if (widenAmount >= WIDEN_PCT && now.t - lastEventT > DEDUPE_MS) {
    lastEventT = now.t;
    events.push({ t: now.t, gapBefore: old.gap, gapAfter: now.gap, bfxAskBefore: bfxAsk! });
  }
}

function tick() {
  if (binanceAsk === null || bfxAsk === null) return;
  const gap = (binanceAsk - bfxAsk) / bfxAsk * 100;
  const t = Date.now();
  gapHistory.push({ t, gap });
  bfxAskHistory.push({ t, p: bfxAsk });
  checkWiden();
}

function connectBinance() {
  const ws = new WebSocket("wss://stream.binance.com:9443/ws/solusdt@bookTicker");
  ws.on("open", () => console.log("Binance bookTicker connected"));
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      const ask = parseFloat(msg.a);
      if (ask) { binanceAsk = ask; tick(); }
    } catch {}
  });
  ws.on("error", (e) => console.error("Binance WS error:", e));
  return ws;
}

function connectBitfinex() {
  const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  let chanId: number | null = null;
  ws.on("open", () => {
    console.log("Bitfinex ticker connected, subscribing...");
    ws.send(JSON.stringify({ event: "subscribe", channel: "ticker", symbol: "tSOLUSD" }));
  });
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "subscribed" && msg.channel === "ticker") { chanId = msg.chanId; return; }
      if (!Array.isArray(msg) || msg[0] !== chanId || msg[1] === "hb") return;
      const data = msg[1];
      if (!Array.isArray(data) || data.length < 4) return;
      if (data[2]) { bfxAsk = data[2]; tick(); }
    } catch {}
  });
  ws.on("error", (e) => console.error("Bitfinex WS error:", e));
  return ws;
}

function bfxAskAt(t: number): number | null {
  let last: number | null = null;
  for (const row of bfxAskHistory) { if (row.t <= t) last = row.p; else break; }
  return last;
}

(async () => {
  console.log(`ASK-TO-ASK: detecting gap-widening events (>=${WIDEN_PCT}% within ${WIDEN_WINDOW_MS}ms) over ${DURATION_MS / 1000}s, tracking Bitfinex ask reaction over next ${LOOKAHEAD_MS/1000}s...\n`);
  const w1 = connectBinance();
  const w2 = connectBitfinex();
  await new Promise((r) => setTimeout(r, DURATION_MS));
  try { w1.close(); } catch {}
  try { w2.close(); } catch {}

  console.log(`${events.length} gap-widening events detected\n`);
  let rose = 0, fell = 0, flat = 0;
  for (const e of events) {
    const after = bfxAskAt(e.t + LOOKAHEAD_MS);
    if (after === null) continue;
    const movePct = (after - e.bfxAskBefore) / e.bfxAskBefore * 100;
    const dir = movePct > 0.005 ? "ROSE" : movePct < -0.005 ? "FELL" : "FLAT";
    if (dir === "ROSE") rose++; else if (dir === "FELL") fell++; else flat++;
    console.log(`${new Date(e.t).toISOString().slice(11,23)}  gap ${e.gapBefore.toFixed(3)}%->${e.gapAfter.toFixed(3)}%  bfxAsk ${e.bfxAskBefore.toFixed(4)}->${after.toFixed(4)} (${movePct>=0?"+":""}${movePct.toFixed(4)}%)  ${dir}`);
  }
  console.log(`\n--- Summary (ASK-TO-ASK) ---`);
  console.log(`After a gap-widening event, Bitfinex's own ask over the next ${LOOKAHEAD_MS/1000}s:`);
  console.log(`  ROSE (converging back toward Binance): ${rose}`);
  console.log(`  FELL (diverging further): ${fell}`);
  console.log(`  FLAT (~no move): ${flat}`);
})();
