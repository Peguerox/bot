// Live wallet balance via Bitfinex's private authenticated WebSocket ('auth' channel, filtered to
// wallet events). Keeps an in-memory map of exchange-wallet balances that updates in real time
// the instant ANY trade settles on the account (this bot's, or another bot sharing the account) --
// same pattern as bfxBid/bfxAsk from the public ticker. Callers read a synchronous in-memory value
// with zero added latency, instead of either trusting stale local bookkeeping or blocking on a
// REST call at trade time.
//
// Replaces the reactive catch-and-retry approach (submitMarketOrderSafe): that only found out
// about a real balance mismatch AFTER an order failed, wasting an attempt. This lets a bot size
// the order correctly BEFORE submitting, using data that's already current.
//
// Uses AVAILABLE_BALANCE (wallet array index 4), not BALANCE (index 2) -- the REST-based
// getWalletBalance() in bitfinex-auth.ts uses index 2, which is fine for that use case (retry
// after a failure) but AVAILABLE_BALANCE is the technically correct field for "how much can I
// actually trade with right now" (nets out anything tied up in open orders). In practice these
// bots only ever submit market orders that fill instantly, so the two rarely differ.
import WebSocket from "ws";
import crypto from "crypto";

const walletBalances = new Map<string, number>();
let walletWs: WebSocket | null = null;
let ready = false;
let readyCallbacks: (() => void)[] = [];

function authSig(nonce: string): string {
  const apiSecret = process.env.BITFINEX_API_SECRET!;
  return crypto.createHmac("sha384", apiSecret).update(`AUTH${nonce}`).digest("hex");
}

export function connectWalletBalances(): WebSocket {
  const ws = new WebSocket("wss://api.bitfinex.com/ws/2");
  walletWs = ws;

  ws.on("open", () => {
    const apiKey = process.env.BITFINEX_API_KEY!;
    const nonce = Date.now().toString();
    ws.send(JSON.stringify({
      apiKey, authSig: authSig(nonce), authNonce: nonce, authPayload: `AUTH${nonce}`,
      event: "auth", filter: ["wallet"],
    }));
  });

  ws.on("message", (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "auth") {
      if (msg.status !== "OK") console.error("Wallet WS auth FAILED:", JSON.stringify(msg));
      else console.log("Wallet WS authenticated, waiting for balance snapshot...");
      return;
    }

    if (!Array.isArray(msg) || msg[1] === "hb") return;
    const type = msg[1];

    if (type === "ws") {
      // full wallet snapshot on connect: array of [WALLET_TYPE, CURRENCY, BALANCE, UNSETTLED, AVAILABLE_BALANCE, ...]
      for (const w of msg[2]) {
        if (w[0] === "exchange") walletBalances.set(w[1], w[4] ?? w[2]);
      }
      console.log("Wallet snapshot loaded:", JSON.stringify(Object.fromEntries(walletBalances)));
      if (!ready) {
        ready = true;
        readyCallbacks.forEach((cb) => cb());
        readyCallbacks = [];
      }
    } else if (type === "wu") {
      // single wallet update: [WALLET_TYPE, CURRENCY, BALANCE, UNSETTLED, AVAILABLE_BALANCE, ...]
      const w = msg[2];
      if (w[0] === "exchange") walletBalances.set(w[1], w[4] ?? w[2]);
    }
  });

  ws.on("error", (err) => console.error("Wallet WS error:", err));
  ws.on("close", () => { console.log("Wallet WS closed, reconnecting in 2s..."); setTimeout(connectWalletBalances, 2000); });
  return ws;
}

export function getLiveBalance(currency: string): number {
  return walletBalances.get(currency) ?? 0;
}

export function isWalletReady(): boolean {
  return ready;
}

export function onWalletReady(cb: () => void) {
  if (ready) cb(); else readyCallbacks.push(cb);
}
