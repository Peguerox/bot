"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import PnLChart from "@/components/PnLChart";
import HedgeEntryFilters from "./components/HedgeEntryFilters";
import { SEED_USD as HT_SEED_USD, dropPctForLevel as htDropPctForLevel } from "@/lib/sol-hypertrade-config";

// Mirrors trigger/live-bot-surfer-solbtc.ts BUF_UP/BUF_DN/ARM/GIVEBACK -- keep in sync if that changes.
const SURFER_BUF_UP = 0.0025;
const SURFER_BUF_DN = 0.0020;
const SURFER_ARM = 0.18;
const SURFER_GIVEBACK = 0.15;
// Worker 1's real strategy swapped from plain stochastic to RSI-Stoch at this moment
// (2026-09-26) -- equity was reset to real collateral the same instant. Trades before this are
// the old strategy's history and get filtered out of the dashboard so the win-rate/trade-count
// shown is a clean comparison against Worker 3, not blended with the old strategy's numbers.
// Non-destructive: the old rows stay in lighter_btc_initial_trades, just hidden from display.
// Reset again 2026-09-27 when stoch_window/thresholds changed (5,25/75 -> 20,10/90), then once
// more the same day after SL briefly went live at 0.05% before being reverted to 0.11% -- a few
// trades ran under the wrong SL, so the baseline moved past those too. Reset again 2026-10-01
// for the intrabar dispersion isolated test (self-lock off, hours 9/21 restored) -- done by
// hand this one last time. Every reset after this one goes through the new Reset button
// (/api/lighter-btc-initial-reset), which writes the same cutoff into
// lighter_btc_initial_state.history_reset_at instead of a hardcoded constant here -- see the
// trades filter below. This constant now only matters as the fallback for trade rows from
// before that column existed.
const WORKER1_RESET_AT = "2026-10-01T12:53:44.000000+00:00";
// Worker 2's schedule was removed and SL tightened (0.11% -> 0.05%) at this moment -- same
// reasoning as Worker 1's reset above, a clean baseline for a config that changed twice at once.
// Reset again 2026-09-27 when stoch_window/thresholds changed, then once more after the SL
// revert (0.05% -> 0.11%) -- same reasoning as Worker 1's reset above. Reset again 2026-09-29
// (repeatedly, through several same-day pivots -- most recently the hedge dual-leg pivot:
// Worker 2's account is now the long leg, Worker 3's account the short leg, both driven by
// one process. This cutoff also gates the short leg's trade list in HedgeDualLegPanel). Reset
// again 2026-09-30 after a Render zombie-process double-entry (two process instances briefly
// live post-redeploy, both entered "long" -- unrelated to strategy logic, see that day's
// incident) forced an emergency_flatten; both legs manually closed/reset, left disabled for
// the user to re-enable once the redeploy overlap issue is addressed.
const WORKER2_RESET_AT = "2026-09-30T03:35:43.000Z";
// Worker 3 reset 2026-09-27 ahead of testing the volatility-adaptive window formula + the
// order-flow entry filter -- clean baseline before that config lands.
const WORKER3_RESET_AT = "2026-09-29T00:52:00.000000+00:00";
// Must match lighter_stoch_dca_btc_initial.py's _WEEKDAY_SCHEDULE exactly -- the ET-shifted
// weekend block (see that file's docstring for the derivation). Kept as a literal duplicate
// rather than a shared import since the backend is Python and this is the frontend.
const WORKER1_TRADING_HOURS: Record<number, number[]> = {
  0: [4, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21],
  1: [0, 1, 4, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21],
  2: [0, 1, 4, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21],
  3: [0, 1, 4, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21],
  4: [0, 1, 4, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21],
  5: [0, 1],
  6: [],
};

// Display-only shortening for the recent-trades list -- the underlying reason string (used for
// self-lock classification, etc.) stays exactly as the backend writes it; this only affects what
// gets rendered in the compact trade rows, which run out of horizontal space fast.
function shortReason(reason: string | null | undefined): string {
  if (reason === "BOOK_OPPOSITION") return "BOOK_OPP";
  return reason ?? "";
}

function formatDurationShort(ms: number): string {
  if (ms <= 0) return "0m";
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const remMins = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${remMins}m`;
  return `${remMins}m`;
}

function Stat({ label, value, sub, color }: { label: string; value: React.ReactNode; sub: React.ReactNode; color: string }) {
  return (
    <div className="bg-gray-800/60 rounded-lg p-3">
      <p className="text-gray-500 text-xs uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${color}`}>{value}</p>
      <p className="text-gray-600 text-xs mt-0.5">{sub}</p>
    </div>
  );
}

// ── Health banner ────────────────────────────────────────────────────────────
// Surfaces exactly the failure mode that bit us on 2026-09-23: a blocked/erroring
// exchange endpoint spamming "error" runs, or a worker that's gone quiet while it's
// supposed to be enabled. Reads only from data already being polled -- no extra calls.
type HealthIssue = { worker: string; text: string; detail: string };

function checkWorkerHealth(worker: string, enabled: boolean, runs: any[], nowMs: number): HealthIssue | null {
  const recent = runs.slice(0, 10);
  const errorCount = recent.filter((r) => r.action === "error" || r.action === "tick_watchdog_timeout").length;
  if (errorCount >= 3) {
    const lastErr = recent.find((r) => r.action === "error" || r.action === "tick_watchdog_timeout");
    const msg: string = lastErr?.detail?.error ?? "";
    const short = msg.includes("captcha") || msg.includes("CloudFront")
      ? "exchange endpoint blocked (CAPTCHA/WAF)" : msg.split("\n")[0].slice(0, 80) || "repeated errors";
    return { worker, text: `${errorCount}/10 recent ticks failed`, detail: short };
  }
  if (enabled && runs.length > 0) {
    const ageMs = nowMs - new Date(runs[0].ran_at ?? runs[0].run_at).getTime();
    if (ageMs > 8 * 60_000) {
      return { worker, text: `no activity in ${Math.round(ageMs / 60000)}m`, detail: "worker may be offline or stuck" };
    }
  }
  return null;
}

function HealthBanner({ issues }: { issues: HealthIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="bg-red-950/60 border border-red-800/60 rounded-xl px-4 py-3 flex items-start gap-3">
      <span className="text-red-400 text-lg leading-none mt-0.5">⚠</span>
      <div className="space-y-1">
        <p className="text-red-300 font-semibold text-sm">Something needs attention</p>
        {issues.map((iss, i) => (
          <p key={i} className="text-red-400/90 text-xs">
            <span className="font-semibold">{iss.worker}</span> — {iss.text} ({iss.detail})
          </p>
        ))}
      </div>
    </div>
  );
}

function actionColor(action: string) {
  if (action === "OPEN")              return "text-green-400";
  if (action === "TP")                return "text-green-400";
  if (action === "SL")                return "text-red-400";
  if (action === "CHASE_EXIT")        return "text-yellow-400";
  if (action === "START_EXIT")        return "text-yellow-400";
  if (action === "EXIT_REPRICE")      return "text-yellow-400";
  if (action === "EXIT_HOLD")         return "text-gray-500";
  if (action === "HOLD")              return "text-gray-500";
  if (action === "SKIP_NO_FUNDS")     return "text-orange-400";
  if (action === "WATCH" || action === "WATCH_30S") return "text-gray-500";
  if (action === "LIMIT_BUY_PLACED")  return "text-blue-400";
  if (action === "ENTRY_FILLED")      return "text-green-400";
  if (action === "PENDING_FILL")      return "text-yellow-400";
  if (action === "MISSED")            return "text-orange-400";
  if (action === "STUCK_RESCUE")      return "text-orange-400";
  if (action === "STUCK_RESCUE_CHASE") return "text-orange-400";
  if (action === "ERROR")             return "text-red-400";
  // Surfer-specific actions
  if (action === "ARM_BUY")          return "text-blue-400";
  if (action === "ARM_SELL")         return "text-orange-400";
  if (action === "START_BUY")        return "text-green-400";
  if (action === "START_SELL")       return "text-yellow-400";
  if (action === "BUY_FILLED")       return "text-green-400";
  if (action === "SELL_FILLED")      return "text-green-400";
  if (action === "BUY_REPRICE")      return "text-yellow-400";
  if (action === "SELL_REPRICE")     return "text-yellow-400";
  if (action === "BUY_WAIT")         return "text-gray-500";
  if (action === "SELL_WAIT")        return "text-gray-500";
  if (action === "BUY_CANCELED")     return "text-orange-400";
  if (action === "SELL_CANCELED")    return "text-orange-400";
  if (action === "CHECK")            return "text-gray-500";
  if (action === "SELL_TRIGGER")     return "text-orange-400";
  if (action === "WAIT_HISTORY")     return "text-gray-600";
  return "text-gray-400";
}

function formatAction(a: any): string {
  if (a.action === "WATCH" || a.action === "WATCH_30S") {
    const tag = a.action === "WATCH_30S" ? "WATCH 30s" : "WATCH";
    const spread = isNaN(parseFloat(a.xlmGLRet)) ? "N/A" : (parseFloat(a.xlmGLRet)*100).toFixed(3)+"%";
    return a.z != null
      ? `${tag}  z=${parseFloat(a.z).toFixed(2)}  $${a.price}`
      : a.xlmGLRet != null
      ? `${tag}  spread=${spread}  $${a.price}`
      : `${tag}  btc=${(parseFloat(a.btcRet)*100).toFixed(3)}%  bnb=${(parseFloat(a.bnbRet)*100).toFixed(3)}%  $${a.price}`;
  }
  if (a.action === "HOLD")                return `HOLD  [${a.hold}/${6}]  tp=$${a.tp}  sl=$${a.sl}`;
  if (a.action === "TP")                  return `TP HIT  exit=$${a.exit}  pnl=+$${parseFloat(a.pnl).toFixed(2)}`;
  if (a.action === "SL")                  return `SL HIT  exit=$${a.exit}  pnl=$${parseFloat(a.pnl).toFixed(2)}`;
  if (a.action === "START_EXIT")          return `EXIT START  @$${a.exitPrice}`;
  if (a.action === "EXIT_REPRICE")        return `EXIT REPRICE  $${a.from} → $${a.to}`;
  if (a.action === "EXIT_HOLD")           return `EXIT HOLD  @$${a.price}`;
  if (a.action === "CHASE_EXIT")          return `EXIT FILLED  exit=$${a.exit}  pnl=$${parseFloat(a.pnl).toFixed(2)}`;
  if (a.action === "LIMIT_BUY_PLACED" || a.action === "LIMIT_BUY_PLACED_30S") {
    const tag = a.action === "LIMIT_BUY_PLACED_30S" ? "BUY LIMIT 30s" : "BUY LIMIT";
    return a.z != null
      ? `${tag}  qty=${a.qty}  @$${a.price}  z=${parseFloat(a.z).toFixed(2)}`
      : a.xlmGLRet != null
      ? `${tag}  qty=${a.qty}  @$${a.price}  spread=${(parseFloat(a.xlmGLRet)*100).toFixed(3)}%`
      : `${tag}  qty=${a.qty}  @$${a.price}  btc=${(parseFloat(a.btcRet)*100).toFixed(3)}%`;
  }
  if (a.action === "ENTRY_FILLED")        return `FILLED  entry=$${a.entry}  qty=${a.qty}  tp=$${a.tp}  sl=$${a.sl}`;
  if (a.action === "PENDING_FILL")        return `WAITING FILL  orderId=${a.orderId}`;
  if (a.action === "MISSED")              return `MISSED  live=$${a.livePrice}  order=$${a.orderPrice}`;
  if (a.action === "CANCELED_DROP")       return `CANCELED  price dropped  live=$${a.livePrice}  order=$${a.orderPrice}`;
  if (a.action === "ENTRY_TIMEOUT")       return `ENTRY TIMEOUT  no fill after ${a.holdCount} min  orderId=${a.orderId}`;
  if (a.action === "STUCK_RESCUE")        return `STUCK RESCUE  live=$${a.livePrice}  sl=$${a.sl}  rescue=$${a.rescuePrice}`;
  if (a.action === "STUCK_RESCUE_CHASE")  return `STUCK RESCUE CHASE  live=$${a.livePrice}  floor=$${a.chaseFloor}  rescue=$${a.rescuePrice}`;
  if (a.action === "SKIP_NO_FUNDS")       return `NO FUNDS  $${parseFloat(a.balance).toFixed(2)} USDT`;
  if (a.action === "ERROR")               return `ERROR (${a.stage}): ${a.error}`;
  // Surfer-specific (both SOLBTC and SOLUSDT bots)
  if (a.action === "CHECK" && a.R != null) {
    // SOL/BTC buffered rotation (new strategy) -- R/H/L/C shape, not RSI/EMA.
    // Thresholds mirror trigger/live-bot-surfer-solbtc.ts exactly (BUF_UP/BUF_DN/ARM/GIVEBACK/FAIL).
    const pct = (x: number) => (x * 100).toFixed(3);
    if (a.mode === "BTC") {
      const breakoutPrice = a.H * (1 + SURFER_BUF_UP);
      const toBreakout = pct(a.R / breakoutPrice - 1);
      const cNote = a.R > a.C ? "" : ", lag not confirmed";
      return `WATCH  R=${a.R}  H=${a.H} (${toBreakout}% to breakout${cNote})  BTC  ${a.status}`;
    }
    const anchor = a.anchor, peak = a.peak ?? anchor;
    const gg = anchor ? peak / anchor - 1 : 0;
    let stopPrice: number, label: string;
    if (gg >= SURFER_ARM) { stopPrice = anchor * (1 + (1 - SURFER_GIVEBACK) * gg); label = "giveback stop"; }
    else { stopPrice = a.L * (1 - SURFER_BUF_DN); label = "stop"; }
    const toStop = anchor ? pct(a.R / stopPrice - 1) : "—";
    return `WATCH  R=${a.R}  gain=${pct(gg)}%  ${label}=${stopPrice.toFixed(8)} (${toStop}% away)  SOL  ${a.status}`;
  }
  if (a.action === "CHECK")             return `WATCH  rsi=${a.rsi}  ${a.emaBullish ? "bullish" : "bearish"}  ${a.mode}  ${a.status}`;
  if (a.action === "ARM_BUY")           return `ARM BUY  RSI↑${a.curRSI} (was ${a.prevRSI})`;
  if (a.action === "ARM_SELL")          return `ARM SELL  RSI↓${a.curRSI} (was ${a.prevRSI})`;
  if (a.action === "START_BUY") {
    const pStr = a.usdtFree != null ? `$${parseFloat(a.price).toFixed(2)}` : parseFloat(a.price).toFixed(8);
    return `START BUY  ${a.qty} SOL @ ${pStr}`;
  }
  if (a.action === "START_SELL") {
    const pStr = parseFloat(a.price) > 1 ? `$${parseFloat(a.price).toFixed(2)}` : parseFloat(a.price).toFixed(8);
    return `START SELL  ${a.qty} SOL @ ${pStr}`;
  }
  if (a.action === "BUY_FILLED") {
    if (a.usdtSpent != null) return `BUY FILLED  ${a.qty} SOL @ $${parseFloat(a.price).toFixed(2)}  spent $${parseFloat(a.usdtSpent).toFixed(2)}`;
    return `BUY FILLED  ${a.qty} SOL @ ${parseFloat(a.price).toFixed(8)}  spent ${parseFloat(a.btcSpent).toFixed(8)} BTC`;
  }
  if (a.action === "SELL_FILLED") {
    if (a.pnlUsdt != null) return `SELL FILLED  @ $${parseFloat(a.price).toFixed(2)}  pnl ${parseFloat(a.pnlUsdt) >= 0 ? "+" : ""}$${parseFloat(a.pnlUsdt).toFixed(2)}`;
    return `SELL FILLED  @ ${parseFloat(a.price).toFixed(8)}  pnl ${parseFloat(a.pnlBtc) >= 0 ? "+" : ""}${parseFloat(a.pnlBtc).toFixed(8)} BTC`;
  }
  if (a.action === "BUY_REPRICE")       return `BUY REPRICE  ${a.from} → ${a.to}`;
  if (a.action === "SELL_REPRICE")      return `SELL REPRICE  ${a.from} → ${a.to}`;
  if (a.action === "BUY_WAIT") {
    const pStr = parseFloat(a.price) > 1 ? `$${parseFloat(a.price).toFixed(2)}` : parseFloat(a.price).toFixed(8);
    return `BUY WAIT  @ ${pStr}`;
  }
  if (a.action === "SELL_WAIT") {
    const pStr = parseFloat(a.price) > 1 ? `$${parseFloat(a.price).toFixed(2)}` : parseFloat(a.price).toFixed(8);
    return `SELL WAIT  @ ${pStr}`;
  }
  if (a.action === "BUY_CANCELED")      return `BUY CANCELED`;
  if (a.action === "SELL_CANCELED")     return `SELL CANCELED`;
  if (a.action === "BUY_FILLED_ON_CANCEL") {
    const pStr = parseFloat(a.price) > 1 ? `$${parseFloat(a.price).toFixed(2)}` : parseFloat(a.price).toFixed(8);
    return `BUY FILLED (on cancel)  ${a.qty} SOL @ ${pStr}`;
  }
  if (a.action === "SELL_FILLED_ON_CANCEL") {
    if (a.pnlUsdt != null) return `SELL FILLED (on cancel)  @ $${parseFloat(a.price).toFixed(2)}  pnl ${parseFloat(a.pnlUsdt) >= 0 ? "+" : ""}$${parseFloat(a.pnlUsdt).toFixed(2)}`;
    return `SELL FILLED (on cancel)  @ ${parseFloat(a.price).toFixed(8)}  pnl ${parseFloat(a.pnlBtc) >= 0 ? "+" : ""}${parseFloat(a.pnlBtc).toFixed(8)} BTC`;
  }
  if (a.action === "SKIP_BUY")          return `SKIP BUY  ${a.reason}`;
  if (a.action === "SKIP_SELL")         return `SKIP SELL  ${a.reason}`;
  if (a.action === "SELL_TRIGGER")      return `SELL TRIGGER  ${a.reason}  M=${a.M}  g=${a.g}`;
  if (a.action === "WAIT_HISTORY")      return `WAITING FOR HISTORY  ${a.have}/${a.need} candles`;
  return a.action;
}

const LIT_GRID_EXCLUDED_WINDOWS: [string, string][] = [
  ["2026-10-19T14:46:00Z", "2026-10-19T20:13:00Z"],
];

// ── LIT liquidity tracker (2026-10-23, in Worker 4's old spot after the merge) ──────────────────
// Answers one question: how much bigger can the LIT grid get before LIT's own market can't absorb
// its orders? Reads Lighter's public order book + 24h stats straight from the browser (Lighter
// allows this site), and Worker 3's last-24h fills from Supabase. No bot involvement.
const LIT_MARKET_ID = 2049;
const LIGHTER_API = "https://mainnet.zklighter.elliot.ai/api/v1";

function LitLiquidityPanel({ state, fills24h }: { state: any; fills24h: any[] }) {
  const [book, setBook] = useState<{ bids: [number, number][]; asks: [number, number][] } | null>(null);
  const [stats, setStats] = useState<{ volLit: number; volUsd: number; trades: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [ob, det] = await Promise.all([
          fetch(`${LIGHTER_API}/orderBookOrders?market_id=${LIT_MARKET_ID}&limit=100`).then((r) => r.json()),
          fetch(`${LIGHTER_API}/orderBookDetails?market_id=${LIT_MARKET_ID}`).then((r) => r.json()),
        ]);
        if (!alive) return;
        const side = (xs: any[]) => (xs ?? []).map((o: any) => [Number(o.price), Number(o.remaining_base_amount)] as [number, number]);
        setBook({ bids: side(ob.bids), asks: side(ob.asks) });
        const d = (det.spot_order_book_details ?? det.order_book_details ?? [])[0] ?? {};
        setStats({ volLit: Number(d.daily_base_token_volume ?? 0), volUsd: Number(d.daily_quote_token_volume ?? 0), trades: Number(d.daily_trades_count ?? 0) });
        setErr(null);
      } catch (e: any) {
        if (alive) setErr("Lighter market data unavailable");
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const price = state?.live_price != null ? Number(state.live_price) : null;
  const orderLit = state?.order_size_lit != null ? Number(state.order_size_lit) : null;
  const capital = state?.capital_usd != null ? Number(state.capital_usd) : null;
  const within = (xs: [number, number][], lo: number, hi: number) => xs.filter(([p]) => p >= lo && p <= hi).reduce((a, [, q]) => a + q, 0);
  const bidDepth = book && price ? within(book.bids, price * 0.995, price) : null;
  const askDepth = book && price ? within(book.asks, price, price * 1.005) : null;
  const thinner = bidDepth != null && askDepth != null ? Math.min(bidDepth, askDepth) : null;
  const vsBook = thinner && orderLit ? (orderLit / thinner) * 100 : null;

  // Our fills in the last 24h: share of LIT's whole market, and how often an order filled only in part.
  const withFill = fills24h.filter((r: any) => Number(r.filled_qty ?? 0) > 0);
  const partial = withFill.filter((r: any) => Number(r.filled_qty) < Number(r.size ?? 0) * 0.999);
  const partialPct = withFill.length ? (partial.length / withFill.length) * 100 : null;
  const ourLit24h = withFill.reduce((a: number, r: any) => a + Number(r.filled_qty ?? 0), 0);
  const marketShare = stats && stats.volLit > 0 ? (ourLit24h / stats.volLit) * 100 : null;

  // Verdict + headroom from our SHARE OF REAL TRADING (a grid fills from actual trades, not from
  // orders resting on the book): past ~10% of LIT's whole volume we would be a big part of the
  // market and fills would degrade. Partial fills are the early warning.
  const SHARE_CEILING = 10;
  const verdict = marketShare == null ? null
    : marketShare < 5 && (partialPct ?? 0) < 10 ? { label: "Room to grow", cls: "bg-green-500/15 text-green-300 border-green-500/50" }
    : marketShare < SHARE_CEILING && (partialPct ?? 0) < 25 ? { label: "Getting close", cls: "bg-amber-500/15 text-amber-300 border-amber-500/50" }
    : { label: "At the limit", cls: "bg-red-500/15 text-red-300 border-red-500/50" };
  const headroomX = marketShare ? SHARE_CEILING / marketShare : null;

  return (
    <section className="bg-gray-900/60 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-white font-semibold">LIT Liquidity — how big can Worker 3 get?</h2>
          <p className="text-gray-500 text-xs">Lighter's live LIT/USDC order book and 24h market, against Worker 3's orders and fills</p>
        </div>
        {verdict && <span className={`text-sm font-semibold px-3 py-1 rounded-md border ${verdict.cls}`}>{verdict.label}</span>}
      </div>
      {err && <p className="text-amber-400 text-xs">{err}</p>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="Our order vs the book"
          value={vsBook != null ? `${vsBook.toFixed(1)}%` : "—"}
          sub={orderLit != null && thinner != null
            ? `${orderLit.toFixed(2)} LIT per order vs ${thinner.toFixed(0)} LIT on the thinner side within ±0.5% (bids ${bidDepth!.toFixed(0)} · asks ${askDepth!.toFixed(0)})`
            : "loading the order book…"}
          color={vsBook == null ? "text-gray-400" : vsBook < 10 ? "text-green-400" : vsBook < 30 ? "text-amber-400" : "text-red-400"} />
        <Stat label="Partial fills (24h)"
          value={partialPct != null ? `${partialPct.toFixed(1)}%` : "—"}
          sub={`${partial.length} of ${withFill.length} filled orders filled only in part`}
          color={partialPct == null ? "text-gray-400" : partialPct < 10 ? "text-green-400" : partialPct < 25 ? "text-amber-400" : "text-red-400"} />
        <Stat label="Our share of LIT volume (24h)"
          value={marketShare != null ? `${marketShare.toFixed(2)}%` : "—"}
          sub={stats ? `${ourLit24h.toFixed(0)} of ${stats.volLit.toLocaleString(undefined, { maximumFractionDigits: 0 })} LIT traded ($${(stats.volUsd / 1e6).toFixed(2)}M, ${stats.trades.toLocaleString()} trades)` : "loading…"}
          color="text-gray-300" />
        <Stat label="Room to grow"
          value={headroomX != null ? `~${headroomX.toFixed(1)}×` : "—"}
          sub={headroomX != null && capital != null
            ? `Investment could grow to ~$${(capital * headroomX).toLocaleString(undefined, { maximumFractionDigits: 0 })} before we are ${SHARE_CEILING}% of all LIT trading (watch partial fills on the way)`
            : ""}
          color={headroomX == null ? "text-gray-400" : headroomX >= 2 ? "text-green-400" : headroomX >= 1 ? "text-amber-400" : "text-red-400"} />
      </div>
    </section>
  );
}

// Curve pill body (2026-10-25): chart of size vs fall from the top, live position, and a
// per-level table with $/trade and $/month at the bot's live trade rate. size(p) is rebuilt from
// curve_state exactly: floor + (size_top - floor) * ((p - F)/(P - F))^n.
function CurveView({ curve, livePrice, spacingPct, tradesPerDay, ago }: {
  curve: any; livePrice: number | null; spacingPct: number; tradesPerDay: number; ago: string | null;
}) {
  const P = Number(curve.top), F = Number(curve.bottom), n = Number(curve.n);
  const floor = Number(curve.floor_lit), top = Number(curve.size_top);
  const sizeAt = (px: number) => floor + (top - floor) * Math.pow(Math.min(1, Math.max(0, (px - F) / (P - F))), n);
  const perTrade = (px: number) => sizeAt(px) * px * spacingPct / 100;
  const perMonth = (px: number) => perTrade(px) * tradesPerDay * 30;
  const fallNow = livePrice != null ? Math.max(0, (1 - livePrice / P) * 100) : null;
  const usd = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;

  // chart: x = fall from top 0..60%, y = size
  const W = 320, H = 130, padL = 30, padB = 18, padT = 8, padR = 8, XMAX = 60;
  const xs = (d: number) => padL + (d / XMAX) * (W - padL - padR);
  const ys = (q: number) => padT + (1 - q / top) * (H - padT - padB);
  const pts: [number, number][] = [];
  for (let i = 0; i <= 120; i++) { const d = (i / 120) * XMAX; pts.push([xs(d), ys(sizeAt(P * (1 - d / 100)))]); }
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${xs(XMAX)},${ys(0)} L${xs(0)},${ys(0)} Z`;
  const nowX = fallNow != null ? xs(Math.min(fallNow, XMAX)) : null;
  const nowY = livePrice != null ? ys(sizeAt(livePrice)) : null;

  const rows = [0, 5, 10, 15, 20, 30, 40, 50, 99.9];
  const nearest = fallNow == null ? null : rows.reduce((a, b) => Math.abs(b - fallNow) < Math.abs(a - fallNow) ? b : a);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-gray-700 bg-gray-800/60 p-2">
          <p className="text-gray-500 text-[10px] uppercase tracking-wide">Top</p>
          <p className="text-gray-100 text-sm font-bold tabular-nums">${P.toFixed(4)}</p>
          <p className={`text-[10px] tabular-nums ${fallNow != null && fallNow > 0.01 ? "text-red-400" : "text-green-400"}`}>
            {fallNow != null ? (fallNow > 0.01 ? `price −${fallNow.toFixed(2)}%` : "price at the top") : ""}
          </p>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-800/60 p-2">
          <p className="text-gray-500 text-[10px] uppercase tracking-wide">Budget</p>
          <p className="text-gray-100 text-sm font-bold tabular-nums">${Number(curve.budget_usd).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          <p className="text-gray-500 text-[10px] tabular-nums">floor ${Number(curve.floor_reserve_usd).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="rounded-lg border border-blue-500/40 bg-blue-500/10 p-2">
          <p className="text-blue-300/80 text-[10px] uppercase tracking-wide">Next buy</p>
          <p className="text-blue-300 text-sm font-bold tabular-nums">{Number(curve.next_buy_size).toFixed(2)} LIT</p>
          <p className="text-gray-500 text-[10px] tabular-nums">${Number(curve.next_buy_price).toFixed(4)} · ~{usd(livePrice != null ? perMonth(livePrice) : 0)}/mo</p>
        </div>
      </div>

      <div className="rounded-lg border border-gray-700 bg-gray-950/60 p-2">
        <div className="flex items-center justify-between mb-1">
          <p className="text-gray-400 text-[10px] uppercase tracking-wide">Order size by fall from the top</p>
          <p className="text-gray-500 text-[10px]">n {n} · floor {floor} LIT</p>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
          <defs>
            <linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.03" />
            </linearGradient>
          </defs>
          {[10, 20, 30, 40, 50].map((d) => (
            <g key={d}>
              <line x1={xs(d)} x2={xs(d)} y1={padT} y2={ys(0)} stroke="#374151" strokeDasharray="2 3" strokeWidth="0.6" />
              <text x={xs(d)} y={H - 5} fill="#6b7280" fontSize="8" textAnchor="middle">−{d}%</text>
            </g>
          ))}
          <text x={xs(0)} y={H - 5} fill="#6b7280" fontSize="8" textAnchor="start">top</text>
          {[top, top / 2].map((q) => (
            <g key={q}>
              <line x1={padL} x2={W - padR} y1={ys(q)} y2={ys(q)} stroke="#1f2937" strokeWidth="0.6" />
              <text x={padL - 3} y={ys(q) + 3} fill="#6b7280" fontSize="8" textAnchor="end">{q.toFixed(0)}</text>
            </g>
          ))}
          <path d={area} fill="url(#curveFill)" />
          <path d={line} fill="none" stroke="#60a5fa" strokeWidth="1.6" />
          <line x1={padL} x2={W - padR} y1={ys(floor)} y2={ys(floor)} stroke="#f59e0b" strokeOpacity="0.6" strokeDasharray="3 2" strokeWidth="0.8" />
          {nowX != null && nowY != null && (
            <g>
              <line x1={nowX} x2={nowX} y1={padT} y2={ys(0)} stroke="#22c55e" strokeOpacity="0.5" strokeWidth="0.8" />
              <circle cx={nowX} cy={nowY} r="3.2" fill="#22c55e" stroke="#052e16" strokeWidth="1" />
              <text x={Math.min(nowX + 5, W - 40)} y={Math.max(nowY - 5, padT + 8)} fill="#4ade80" fontSize="8.5" fontWeight="bold">now {sizeAt(livePrice!).toFixed(1)}</text>
            </g>
          )}
        </svg>
      </div>

      <div className="rounded-lg border border-gray-700 overflow-hidden">
        <div className="grid grid-cols-[3.2rem_4.2rem_1fr_3.6rem] gap-2 bg-gray-800/80 text-[10px] uppercase tracking-wide text-gray-500 px-2 py-1">
          <span>Fall</span><span>Price</span><span>Size</span><span className="text-right">$/mo</span>
        </div>
        {rows.map((d) => {
          const px = P * (1 - d / 100);
          const q = d === 99.9 ? floor : sizeAt(px);
          const here = d === nearest;
          return (
            <div key={d} className={`grid grid-cols-[3.2rem_4.2rem_1fr_3.6rem] gap-2 items-center px-2 py-1.5 text-xs tabular-nums border-t border-gray-800 ${here ? "bg-green-500/10 text-green-200 font-semibold" : "text-gray-400"}`}>
              <span>{here ? "▶ " : ""}{d === 0 ? "top" : `−${d}%`}</span>
              <span>${px < 0.1 ? px.toFixed(4) : px.toFixed(3)}</span>
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="h-1.5 rounded-full bg-blue-400/70 shrink-0" style={{ width: `${Math.max(2, (q / top) * 100) * 0.6}%` }} />
                <span className="truncate">{q.toFixed(q < 10 ? 2 : 1)} LIT</span>
              </span>
              <span className="text-right">{usd(perMonth(px))}</span>
            </div>
          );
        })}
      </div>
      <p className="text-gray-500 text-[10px] leading-snug tabular-nums">
        size = floor + (B − R)/W × ((p − F)/(P − F))^n · bottom ${F.toFixed(4)} · {curve.lines} lines · $/mo at the live rate of ~{tradesPerDay.toFixed(0)} trades/day{ago ? ` · updated ${ago} ago` : ""}
      </p>
    </div>
  );
}

function LitGridLivePanel({
  state, orders, sells, sellCount, resting, loading, firstSellAt = null,
  enabled, onToggle, toggling,
  onFlatten, flattening,
  onClearHistory, clearingHistory,
  apiBase = "/api/lighter-lit-grid-live",
  title = "LIT/USDC Grid Bot",
  subaccountNote = "same sub-account Worker 4 used",
}: {
  state: any; orders: any[]; sells: any[]; sellCount: number; resting: any[]; loading: boolean;
  firstSellAt?: string | null;
  enabled: boolean; onToggle: () => void; toggling: boolean;
  onFlatten: () => void; flattening: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
  // 2026-10-21: Worker 3 twin reuses this exact component (same careful real-money logic,
  // never duplicated) pointed at its own API routes/account via these three overrides --
  // Worker 4's own call site passes none of them, so its behavior is byte-for-byte unchanged.
  apiBase?: string; title?: string; subaccountNote?: string;
}) {
  const st = state;

  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const lockAge = st?.lock_heartbeat ? nowTick - new Date(st.lock_heartbeat).getTime() : null;
  const workerAlive = lockAge != null && lockAge < 30_000; // ticks every 3s, generous margin

  const capitalUsd = st?.capital_usd ?? 500;
  const usdcBalance = st?.usdc_balance ?? null;
  const litBalance = st?.lit_balance ?? null;
  const livePrice = st?.live_price ?? null;
  const litValueUsd = litBalance != null && livePrice != null ? litBalance * livePrice : null;
  const totalValue = usdcBalance != null && litValueUsd != null ? usdcBalance + litValueUsd : null;
  const totalPnl = totalValue != null ? totalValue - capitalUsd : null;
  const totalPnlPct = totalPnl != null && capitalUsd > 0 ? (totalPnl / capitalUsd) * 100 : null;
  // Bot profit = realized profit from completed grid round trips (each sell's own recorded
  // profit). Unrealized = whatever is left of Total PNL (held LIT marked at live price).
  // The buckets are server-derived over the FULL ledger (no row cap) -- summing them avoids
  // the bug where summing the (capped) `sells` array silently dropped older trades' profit
  // once the ledger grew past the query's limit (2026-10-20 audit finding).
  const botProfit = Number(st?.profit_bucket_rest_usd ?? 0) + Number(st?.profit_bucket_cover_drop_usd ?? 0)
    + Number(st?.profit_bucket_compound_usd ?? 0);
  const botProfitPct = capitalUsd > 0 ? (botProfit / capitalUsd) * 100 : null;
  // Trades/hour: sell count since the bot's current history started (history_reset_at), or
  // since the oldest sell we have if that's missing -- live, recomputes as nowTick ticks.
  const sellTimes = sells.map((r: any) => r.filled_at ? new Date(r.filled_at).getTime() : null).filter((t: number | null): t is number => t != null);
  const tradesStartMs = st?.history_reset_at ? new Date(st.history_reset_at).getTime()
    : firstSellAt ? new Date(firstSellAt).getTime()
    : (sellTimes.length ? Math.min(...sellTimes) : null);
  // Hours the bot was stuck (not its normal pace) don't count -- 2026-10-19 dust-lot freeze.
  const excludedMs = tradesStartMs == null ? 0 : LIT_GRID_EXCLUDED_WINDOWS.reduce((sum, [a, b]) => {
    const s = Math.max(Date.parse(a), tradesStartMs), e = Math.min(Date.parse(b), nowTick);
    return sum + Math.max(0, e - s);
  }, 0);
  const tradesHours = tradesStartMs != null ? Math.max((nowTick - tradesStartMs - excludedMs) / 3_600_000, 1 / 60) : null;
  // sellCount is a count-only query over the full ledger -- never capped by a row limit,
  // unlike sells.length which only reflects whatever this page happened to fetch for display
  // (2026-10-20 fix: the fetch limit used to be reused as the trade-rate denominator too).
  const tradesPerHour = tradesHours != null && sellCount > 0 ? sellCount / tradesHours : null;
  const unrealizedPnl = totalPnl != null ? totalPnl - botProfit : null;
  const unrealizedPct = unrealizedPnl != null && capitalUsd > 0 ? (unrealizedPnl / capitalUsd) * 100 : null;
  const pnlColor = (v: number | null) => v == null ? "text-gray-500" : Math.abs(v) < 0.005 ? "text-gray-300" : v >= 0 ? "text-green-400" : "text-red-400";
  const fmtUsd = (v: number | null) => v == null ? "—" : `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
  const fmtPct = (v: number | null, d = 2) => v == null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;

  // Sizing mode (2026-10-25): exactly one of flat / dynamic (gates) / curve; curve wins if both
  // flags are ever set, same as the worker's sizing_mode().
  const curveOn = !!st?.curve_enabled;
  const dynOn = !!st?.dynamic_dd_enabled && !curveOn;
  const sizingMode: "flat" | "dynamic" | "curve" = curveOn ? "curve" : dynOn ? "dynamic" : "flat";
  const curve = st?.curve_state ?? null;
  const curveAgo = curve?.at ? Math.max(0, nowTick - new Date(curve.at).getTime()) : null;
  const dynTier = st?.dynamic_dd_tier != null ? Number(st.dynamic_dd_tier) : null;
  const dynHigh = st?.dynamic_dd_high != null ? Number(st.dynamic_dd_high) : null;
  const dynDrop = dynHigh != null && livePrice != null ? Math.max(0, (1 - livePrice / dynHigh) * 100) : null;
  // Gate-dependent spacing growth (2026-10-21, capital-corrected formula since 2026-10-22):
  // spacing widens with the dynamic-drawdown tier instead of staying flat all the way down --
  // see server/lit_grid_live.py's capital_corrected_spacing_multiplier()/effective_spacing_pct().
  // gate_spacing_multiplier_value is PERSISTED by the worker (it needs live cash figures the
  // dashboard doesn't have), so this just reads it rather than recomputing anything client-side.
  const gateGrowthOn = !!st?.gate_spacing_growth_enabled;
  const gateMultiplier = st?.gate_spacing_multiplier_value != null ? Number(st.gate_spacing_multiplier_value) : 1;
  const baseSpacingPct = st?.spacing_pct != null ? Number(st.spacing_pct) : null;
  const effectiveSpacingPct = baseSpacingPct != null && dynOn && gateGrowthOn ? baseSpacingPct * gateMultiplier : baseSpacingPct;
  const restingPrices = (side: string) => resting.filter((r: any) => r.side === side).map((r: any) => Number(r.limit_price));
  const nearestSell = livePrice != null ? (restingPrices("sell").filter((p: number) => p >= livePrice).sort((a: number, b: number) => a - b)[0] ?? null) : null;
  const nearestBuy = livePrice != null ? (restingPrices("buy").filter((p: number) => p <= livePrice).sort((a: number, b: number) => b - a)[0] ?? null) : null;
  // Gap alarm (2026-10-23, direct request): the worker publishes whether the buy right below
  // price and the nearest sell its rules allow are actually on the book (near_book). A gap that
  // lasts longer than alert_after_s (normal reactions take ~1s) lights the alarm.
  const nearBook = st?.near_book ?? null;
  const gapSinceMs = nearBook?.gap_since ? new Date(nearBook.gap_since).getTime() : null;
  const gapSecs = gapSinceMs != null ? Math.max(0, Math.round((nowTick - gapSinceMs) / 1000)) : null;
  const gapAlarm = workerAlive && nearBook != null && gapSecs != null && gapSecs >= Number(nearBook.alert_after_s ?? 10);
  // Compound resize (2026-10-24): orders grow by the compound profit once it adds >= 0.01 LIT to
  // each order; the worker records when, and the $ step (it moves with price and the gate).
  const compoundResize = st?.compound_resize ?? null;
  const compoundResizeAgo = compoundResize?.at ? Math.max(0, nowTick - new Date(compoundResize.at).getTime()) : null;
  const fmtAgo = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
  const compoundNextUsd = compoundResize?.compound_usd != null && compoundResize?.step_usd != null
    ? Number(compoundResize.compound_usd) + Number(compoundResize.step_usd) : null;

  const openOrders = orders.filter((o: any) => o.status === "pending" || o.status === "open");
  const filledOrders = orders.filter((o: any) => o.status === "filled");

  const [spacingIn, setSpacingIn] = useState("");
  const [upIn, setUpIn] = useState("");
  const [downIn, setDownIn] = useState("");
  const [drawdownIn, setDrawdownIn] = useState("");
  const [capitalIn, setCapitalIn] = useState("");
  const [maxBuysIn, setMaxBuysIn] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [profitModeSaving, setProfitModeSaving] = useState(false);

  async function handleSetProfitMode(mode: "rest" | "cover_drop" | "compound") {
    if (mode === st?.profit_mode || profitModeSaving) return;
    const labels: Record<string, string> = { rest: "Rest", cover_drop: "Cover Drop", compound: "Compound" };
    if (!confirm(`Switch profit allocation to "${labels[mode]}"? Money already in another bucket stays there for its own purpose.`)) return;
    const secret = litGridLiveAdminSecret();
    if (!secret) return;
    setProfitModeSaving(true);
    const res = await fetch(`${apiBase}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify({ profitMode: mode }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error ?? "Failed to switch profit mode.");
      if (res.status === 401) { try { localStorage.removeItem("litGridLiveAdminSecret"); } catch {} }
    }
    setProfitModeSaving(false);
  }

  const [restCapIn, setRestCapIn] = useState("");
  const [restWithdrawIn, setRestWithdrawIn] = useState("");
  const [restSaving, setRestSaving] = useState(false);
  async function handleRestSetting(body: Record<string, string | number>, question: string, done?: () => void) {
    if (restSaving || !confirm(question)) return;
    const secret = litGridLiveAdminSecret();
    if (!secret) return;
    setRestSaving(true);
    const res = await fetch(`${apiBase}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error ?? "Failed to save.");
      if (res.status === 401) { try { localStorage.removeItem("litGridLiveAdminSecret"); } catch {} }
    } else if (done) done();
    setRestSaving(false);
  }

  const [dynSaving, setDynSaving] = useState(false);
  async function handleDynamicDrawdown(body: Record<string, boolean | string | number>, question: string) {
    if (dynSaving || !confirm(question)) return;
    const secret = litGridLiveAdminSecret();
    if (!secret) return;
    setDynSaving(true);
    const res = await fetch(`${apiBase}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error ?? "Failed to save.");
      if (res.status === 401) { try { localStorage.removeItem("litGridLiveAdminSecret"); } catch {} }
    }
    setDynSaving(false);
  }

  const [curveNIn, setCurveNIn] = useState("");
  const [curveFloorIn, setCurveFloorIn] = useState("");
  const sizingQuestions: Record<string, string> = {
    flat: "Switch sizing to FLAT? Gates and curve both off: one order size from your Drawdown setting.",
    dynamic: "Switch sizing to DYNAMIC (gates)? The high starts at the current price and order size follows the gates, using the available balance.",
    curve: "Switch sizing to CURVE? The curve starts at the current price with the cash available now: biggest buys right below price, shrinking to the floor down to a 99.9% fall. Resting buys are swapped once to their curve size. Held LIT is not touched.",
  };

  async function handleSave() {
    const body: Record<string, unknown> = {};
    if (spacingIn.trim()) body.spacingPct = Number(spacingIn);
    if (upIn.trim()) body.levelsUp = Number(upIn);
    if (downIn.trim()) body.levelsDown = Number(downIn);
    if (drawdownIn.trim()) body.drawdownPct = Number(drawdownIn);
    if (capitalIn.trim()) body.capitalUsd = Number(capitalIn);
    if (maxBuysIn.trim()) body.maxOpenBuys = Number(maxBuysIn);
    if (Object.keys(body).length === 0) return;
    if (!confirm("Apply these REAL-MONEY grid settings now?")) return;
    const secret = litGridLiveAdminSecret();
    if (!secret) return;
    setSaving(true);
    setSaveError(null);
    const res = await fetch(`${apiBase}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setSaveError(data.error ?? "Failed to save.");
      if (res.status === 401) { try { localStorage.removeItem("litGridLiveAdminSecret"); } catch {} }
    } else {
      setSpacingIn(""); setUpIn(""); setDownIn(""); setDrawdownIn(""); setCapitalIn(""); setMaxBuysIn("");
    }
    setSaving(false);
  }

  const statusColor = (status: string) =>
    status === "filled" ? "text-green-400"
    : status === "rejected" ? "text-red-400"
    : status === "cancelled" ? "text-gray-500"
    : "text-yellow-400"; // pending / open

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col border border-red-900/40">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-white font-bold text-lg">{title}</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">LIVE — REAL MONEY</span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${workerAlive ? "bg-green-500/20 text-green-400" : "bg-gray-700/40 text-gray-500"}`}>
              {workerAlive ? "worker alive" : "worker offline"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            <button
              onClick={onClearHistory}
              disabled={clearingHistory || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Disable the bot before clearing" : "Clear the order ledger and reset the lifetime buy counter (only while disabled and flat)"}
            >
              {clearingHistory ? "Clearing…" : "Clear"}
            </button>
            <button
              onClick={onFlatten}
              disabled={flattening}
              className="text-xs font-bold px-2.5 py-1.5 rounded-md bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-all disabled:opacity-30"
              title="Cancel every resting order and market-sell all held LIT back to USDC, then disable"
            >
              {flattening ? "Flattening…" : "Flatten All"}
            </button>
            <button
              onClick={onToggle}
              disabled={toggling}
              className={`flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                enabled ? "bg-green-500/20 text-green-400 hover:bg-green-500/30" : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${enabled ? "bg-green-400" : "bg-gray-600"}`} />
              {toggling ? "…" : enabled ? "Running" : "Paused"}
            </button>
          </div>
        </div>
        <p className="text-gray-500 text-xs">
          Real resting LIMIT/POST_ONLY orders on Lighter, {subaccountNote} · durable
          order ledger survives restarts (every order's real fill price comes from the exchange,
          never assumed) · balance-divergence check pauses new orders if the ledger ever disagrees
          with the real exchange balance
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(6)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <>
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Total PNL" value={fmtUsd(totalPnl)} sub={fmtPct(totalPnlPct)} color={pnlColor(totalPnl)} />
          <Stat
            label="Bot Profit"
            value={`${botProfit >= 0 ? "+" : "-"}$${Math.abs(botProfit).toFixed(4)}`}
            sub={`${fmtPct(botProfitPct, 3)} · ${sellCount} trades${tradesPerHour != null ? ` · ${tradesPerHour.toFixed(1)}/hr` : ""}`}
            color={pnlColor(botProfit)}
          />
          <Stat label="Unrealized PNL" value={fmtUsd(unrealizedPnl)} sub={fmtPct(unrealizedPct)} color={pnlColor(unrealizedPnl)} />
          <Stat
            label="Total Account Value"
            value={totalValue != null ? `$${totalValue.toFixed(2)}` : "—"}
            sub="USDC + LIT at live price (profit included)"
            color="text-white"
          />
          <Stat label="Investment" value={`$${capitalUsd.toFixed(2)}`} sub="set via Settings" color="text-gray-300" />
          <Stat
            label="Live Price"
            value={<span className="flex items-center gap-3">
              <span>{livePrice != null ? `$${Number(livePrice).toFixed(4)}` : "—"}</span>
              {nearBook != null && workerAlive && (gapAlarm
                ? <span className="text-red-400 text-base font-bold animate-pulse"
                        title={`Gap for ${gapSecs}s:${!nearBook.buy_ok && nearBook.want_buy != null ? ` no buy at $${Number(nearBook.want_buy).toFixed(4)}` : ""}${!nearBook.sell_ok && nearBook.want_sell != null ? ` no sell at $${Number(nearBook.want_sell).toFixed(4)}` : ""}`}>
                    ⚠ GAP {gapSecs}s
                  </span>
                : <span className="text-green-400 text-lg" title="Buy and sell next to price are on the book">✓</span>)}
              <span className="flex flex-col text-xs font-normal leading-tight">
                <span className="text-green-400/80">sell ↑ {nearestSell != null && livePrice != null ? `$${nearestSell.toFixed(4)} (+${((nearestSell / livePrice - 1) * 100).toFixed(2)}%)` : "none"}</span>
                <span className="text-red-400/80">buy ↓ {nearestBuy != null && livePrice != null ? `$${nearestBuy.toFixed(4)} (-${((1 - nearestBuy / livePrice) * 100).toFixed(2)}%)` : "none"}</span>
              </span>
            </span>}
            sub={st?.order_size_lit != null ? `${Number(st.order_size_lit).toFixed(2)} LIT/order` : ""}
            color={gapAlarm ? "text-red-400" : "text-gray-300"}
          />
          <Stat label="USDC Balance" value={usdcBalance != null ? `$${usdcBalance.toFixed(2)}` : "—"} sub="real, from the exchange" color="text-gray-300" />
          <Stat
            label="LIT Balance"
            value={litBalance != null ? `${litBalance.toFixed(2)} LIT` : "—"}
            sub={litValueUsd != null ? `~$${litValueUsd.toFixed(2)}` : ""}
            color="text-gray-300"
          />
          <Stat
            label="Open Orders"
            value={String(resting.length)}
            sub={`${resting.filter((r: any) => r.side === "sell").length} sells · ${resting.filter((r: any) => r.side === "buy").length} buys · spacing ${st?.spacing_pct ?? "—"}% · ${st?.levels_up ?? "—"} up / ${st?.levels_down ?? "—"} down window`}
            color="text-gray-300"
          />
          <Stat
            label="Rest Bucket"
            value={`$${Number(st?.profit_bucket_rest_usd ?? 0).toFixed(2)}`}
            sub="yours to withdraw"
            color="text-gray-300"
          />
          <Stat
            label="Cover-Drop Bucket"
            value={`$${Number(st?.profit_bucket_cover_drop_usd ?? 0).toFixed(2)}`}
            sub={st?.drawdown_coverage_pct != null
              ? `now covering a ${Number(st.drawdown_coverage_pct).toFixed(1)}% drop`
              : "extends buying past capital_usd"}
            color="text-gray-300"
          />
          <Stat
            label="Compound Bucket"
            value={`$${Number(st?.profit_bucket_compound_usd ?? 0).toFixed(2)}`}
            sub={curveOn ? <span className="flex flex-col gap-0.5 text-xs">
              <span className="text-blue-300 font-semibold">∿ in the curve budget</span>
              <span className="text-sky-300">
                every new buy uses it
                {st?.curve_profit_base_usd != null
                  ? ` · +$${Math.max(0, Number(st?.profit_bucket_compound_usd ?? 0) + Number(st?.profit_bucket_cover_drop_usd ?? 0) - Number(st.curve_profit_base_usd)).toFixed(2)} since the last reset`
                  : ""}
              </span>
            </span> : <span className="flex flex-col gap-0.5 text-xs">
              <span className="text-amber-300 font-semibold">
                {compoundResizeAgo != null ? `↻ last resize ${fmtAgo(compoundResizeAgo)} ago` : "↻ no resize yet"}
              </span>
              <span className="text-sky-300">
                {compoundNextUsd != null ? `next resize at $${compoundNextUsd.toFixed(2)}` : "resizes every +0.01 LIT per order"}
              </span>
            </span>}
            color="text-gray-300"
          />
        </div>
        </>
      )}
      <div className="space-y-2">
        <p className="text-gray-500 text-[9px] uppercase tracking-wide">
          Profit Allocation (currently: {st?.profit_mode ?? "rest"})
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          {([
            ["rest", "Rest"],
            ["cover_drop", "Cover Drop"],
            ["compound", "Compound"],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => handleSetProfitMode(mode)}
              disabled={profitModeSaving}
              className={`text-xs font-semibold px-2 py-1.5 rounded-md transition-all disabled:opacity-40 ${
                (st?.profit_mode ?? "rest") === mode
                  ? "bg-red-500/20 text-red-400"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-gray-600 text-[9px] leading-snug">
          Only one mode active at a time. Switching only changes where NEW realized profit goes
          going forward -- money already in a bucket stays earmarked for that bucket's own purpose.
        </p>
      </div>
      {(() => {
        const restMode = (st?.profit_mode ?? "rest") === "rest";
        const cap = st?.rest_cap_usd != null ? Number(st.rest_cap_usd) : null;
        const overflow: string | null = st?.rest_overflow_to ?? null;
        const restNow = Number(st?.profit_bucket_rest_usd ?? 0);
        const full = cap != null && overflow != null && restNow >= cap;
        const off = !restMode || restSaving;
        return (
          <div className={`border border-gray-800 rounded-md p-2 space-y-1.5 ${restMode ? "" : "opacity-40"}`}>
            <p className="text-gray-500 text-[9px] uppercase tracking-wide">
              Rest cap {restMode ? (cap != null && overflow
                ? `· $${restNow.toFixed(2)} of $${cap.toFixed(2)}${full ? ` · FULL → ${overflow === "compound" ? "Compound" : "Cover Drop"}` : ""}`
                : "· no cap") : "· only in Rest mode"}
            </p>
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500 text-[10px] w-16 shrink-0">Fill to $</span>
              <input
                value={restCapIn} onChange={(e) => setRestCapIn(e.target.value)} disabled={off}
                placeholder={cap != null ? String(cap) : "no cap"} inputMode="decimal"
                className="flex-1 min-w-0 bg-gray-800 text-gray-200 text-xs rounded px-2 py-1 disabled:opacity-60"
              />
              <button
                disabled={off || restCapIn.trim() === ""}
                onClick={() => handleRestSetting({ restCapUsd: restCapIn.trim() },
                  Number(restCapIn) === 0 ? "Remove the Rest cap? All profit stays in Rest." : `Set the Rest cap to $${restCapIn.trim()}?`,
                  () => setRestCapIn(""))}
                className="text-[10px] font-semibold px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
              >Save</button>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500 text-[10px] w-16 shrink-0">When full →</span>
              {([["compound", "Compound"], ["cover_drop", "Cover Drop"]] as const).map(([dest, label]) => (
                <button
                  key={dest}
                  disabled={off}
                  onClick={() => overflow !== dest && handleRestSetting({ restOverflowTo: dest },
                    `When Rest is full, send new profit to ${label}?`)}
                  className={`flex-1 text-[10px] font-semibold px-2 py-1 rounded disabled:opacity-40 ${
                    overflow === dest ? "bg-red-500/20 text-red-400" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                  }`}
                >{label}</button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500 text-[10px] w-16 shrink-0">Withdrew $</span>
              <input
                value={restWithdrawIn} onChange={(e) => setRestWithdrawIn(e.target.value)} disabled={off}
                placeholder="amount taken out" inputMode="decimal"
                className="flex-1 min-w-0 bg-gray-800 text-gray-200 text-xs rounded px-2 py-1 disabled:opacity-60"
              />
              <button
                disabled={off || restWithdrawIn.trim() === ""}
                onClick={() => handleRestSetting({ restWithdrawUsd: restWithdrawIn.trim() },
                  `Record a $${restWithdrawIn.trim()} withdrawal from Rest? Rest drops by that amount and starts filling again.`,
                  () => setRestWithdrawIn(""))}
                className="text-[10px] font-semibold px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
              >Save</button>
            </div>
            {Number(st?.rest_withdrawn_usd ?? 0) > 0 && (
              <p className="text-gray-600 text-[9px]">Withdrawn so far: ${Number(st.rest_withdrawn_usd).toFixed(2)}</p>
            )}
          </div>
        );
      })()}

      <div className="space-y-2">
        <p className="text-gray-500 text-[9px] uppercase tracking-wide">Settings</p>
        <div className="grid grid-cols-2 gap-2">
          <input
            value={spacingIn}
            onChange={(e) => setSpacingIn(e.target.value)}
            placeholder={`spacing % (now ${st?.spacing_pct ?? "—"})`}
            inputMode="decimal"
            className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-red-500"
          />
          <input
            value={capitalIn}
            onChange={(e) => setCapitalIn(e.target.value)}
            placeholder={`capital $ (now ${st?.capital_usd ?? "—"})`}
            inputMode="decimal"
            className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-red-500"
          />
          <input
            value={upIn}
            onChange={(e) => setUpIn(e.target.value)}
            placeholder={`levels up (now ${st?.levels_up ?? "—"})`}
            inputMode="numeric"
            className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-red-500"
          />
          <input
            value={downIn}
            onChange={(e) => setDownIn(e.target.value)}
            placeholder={`levels down (now ${st?.levels_down ?? "—"})`}
            inputMode="numeric"
            className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-red-500"
          />
          <input
            value={drawdownIn}
            onChange={(e) => setDrawdownIn(e.target.value)}
            placeholder={`drawdown % (now ${st?.drawdown_pct ?? "—"})`}
            inputMode="decimal"
            className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-red-500"
          />
          <input
            value={maxBuysIn}
            onChange={(e) => setMaxBuysIn(e.target.value)}
            placeholder={`max open buys (now ${st?.max_open_buys ?? "—"})`}
            inputMode="numeric"
            className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-red-500"
          />
        </div>
        <button
          onClick={handleSave}
          disabled={saving || (!spacingIn.trim() && !upIn.trim() && !downIn.trim() && !drawdownIn.trim() && !capitalIn.trim() && !maxBuysIn.trim())}
          className="text-xs font-bold px-2.5 py-1.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-30 w-full"
        >
          {saving ? "Saving…" : "Save Settings"}
        </button>
        {saveError && <p className="text-red-400 text-xs">{saveError}</p>}
        <p className="text-gray-600 text-[9px] leading-snug">
          "Max open buys" is a code-enforced cap on new buy placement (defaults to 1 for the first
          real test) -- raise it once that's verified before enabling the full ladder.
        </p>
      </div>

      <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-3 space-y-2">
        <p className="text-gray-200 text-sm font-bold">Sizing</p>
        <div className="grid grid-cols-3 gap-1.5">
          {(["flat", "dynamic", "curve"] as const).map((m) => (
            <button
              key={m}
              onClick={() => m !== sizingMode && handleDynamicDrawdown({ sizingMode: m }, sizingQuestions[m])}
              disabled={dynSaving}
              className={`text-xs font-bold px-2 py-1.5 rounded-full border disabled:opacity-40 ${m === sizingMode
                ? "bg-green-500/15 text-green-400 border-green-500/40"
                : "bg-gray-800 text-gray-400 border-gray-600 hover:text-gray-200"}`}
            >
              {m === sizingMode ? "● " : ""}{m === "flat" ? "Flat" : m === "dynamic" ? "Dynamic" : "Curve"}
            </button>
          ))}
        </div>
        <p className="text-gray-500 text-[10px] leading-snug">Only one is ever on. Flat = one size from Drawdown · Dynamic = the gates · Curve = the formula.</p>
      </div>

      <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-3 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-gray-200 text-sm font-bold">Curve</p>
            <p className="text-gray-500 text-[11px] leading-snug">
              Each new buy sized at its own price: most right below the top, shrinking smoothly to the floor, down to a 99.9% fall. Profit grows it right away.
            </p>
          </div>
          <span className={`shrink-0 text-xs font-bold px-3 py-1.5 rounded-full border ${curveOn
            ? "bg-green-500/15 text-green-400 border-green-500/40" : "bg-gray-800 text-gray-500 border-gray-700"}`}>
            {curveOn ? "● ON" : "○ OFF"}
          </span>
        </div>
        {curveOn && (curve == null
          ? <p className="text-gray-500 text-xs">Planning the curve at the current price…</p>
          : <CurveView curve={curve} livePrice={livePrice} spacingPct={baseSpacingPct ?? 0.125}
              tradesPerDay={tradesPerHour != null ? tradesPerHour * 24 : 626} ago={curveAgo != null ? fmtAgo(curveAgo) : null} />)}
        <div className="flex items-end gap-2">
          <label className="flex-1 text-[10px] text-gray-500">n
            <input value={curveNIn} onChange={(e) => setCurveNIn(e.target.value)} placeholder={String(st?.curve_n ?? 10)}
              className="mt-0.5 w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200" />
          </label>
          <label className="flex-1 text-[10px] text-gray-500">Floor (LIT)
            <input value={curveFloorIn} onChange={(e) => setCurveFloorIn(e.target.value)} placeholder={String(st?.curve_floor_lit ?? 1)}
              className="mt-0.5 w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200" />
          </label>
          <button
            onClick={() => {
              const body: Record<string, number> = {};
              if (curveNIn.trim()) body.curveN = Number(curveNIn);
              if (curveFloorIn.trim()) body.curveFloorLit = Number(curveFloorIn);
              if (Object.keys(body).length === 0) return;
              handleDynamicDrawdown(body, `Set curve ${body.curveN != null ? `n = ${body.curveN} ` : ""}${body.curveFloorLit != null ? `floor = ${body.curveFloorLit} LIT` : ""}? New buys only; resting buys more than 25% off get swapped.`)
                .then(() => { setCurveNIn(""); setCurveFloorIn(""); });
            }}
            disabled={dynSaving || (!curveNIn.trim() && !curveFloorIn.trim())}
            className="text-xs font-bold px-2.5 py-1.5 rounded bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 disabled:opacity-30"
          >Save</button>
        </div>
      </div>

      <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-3 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-gray-200 text-sm font-bold">Dynamic Drawdown</p>
            <p className="text-gray-500 text-[11px] leading-snug">
              The further price falls from its high, the deeper the money is stretched, so the bot never runs out of cash.
            </p>
          </div>
          <span className={`shrink-0 text-xs font-bold px-3 py-1.5 rounded-full border ${dynOn
            ? "bg-green-500/15 text-green-400 border-green-500/40" : "bg-gray-800 text-gray-500 border-gray-700"}`}>
            {dynOn ? "● ON" : "○ OFF"}
          </span>
        </div>

        {dynOn && (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-gray-700 bg-gray-800/60 p-2">
              <p className="text-gray-500 text-[10px] uppercase tracking-wide">High</p>
              <p className="text-gray-100 text-sm font-bold tabular-nums">${dynHigh != null ? dynHigh.toFixed(4) : "—"}</p>
              <button
                onClick={() => handleDynamicDrawdown({ resetDynamicHigh: true }, `Reset the high from $${dynHigh != null ? dynHigh.toFixed(4) : "—"} to the current price $${livePrice != null ? Number(livePrice).toFixed(4) : "—"}?\n\nPrice fall goes back to 0%, the bot returns to the 10% level and new orders get BIGGER (re-sized on the available balance).`)}
                disabled={dynSaving}
                className="mt-1 w-full text-[11px] font-semibold px-2 py-1 rounded-md border border-blue-500/50 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 disabled:opacity-40"
              >
                ↻ Reset high
              </button>
            </div>
            <div className="rounded-lg border border-gray-700 bg-gray-800/60 p-2">
              <p className="text-gray-500 text-[10px] uppercase tracking-wide">Price fall</p>
              <p className={`text-sm font-bold tabular-nums ${dynDrop != null && dynDrop >= 5 ? "text-red-400" : "text-gray-100"}`}>
                {dynDrop != null ? `${dynDrop.toFixed(2)}%` : "—"}
              </p>
              <p className="text-gray-500 text-[10px]">below the high</p>
            </div>
            <div className="rounded-lg border border-blue-500/40 bg-blue-500/10 p-2">
              <p className="text-blue-300/80 text-[10px] uppercase tracking-wide">Money lasts to</p>
              <p className="text-blue-300 text-sm font-bold tabular-nums">{dynTier != null && dynHigh != null ? `$${(dynHigh * (1 - dynTier / 100)).toFixed(4)}` : "—"}</p>
              <p className="text-gray-500 text-[10px] tabular-nums">{dynTier != null ? `−${dynTier}% · ` : ""}{st?.order_size_lit != null ? `${Number(st.order_size_lit).toFixed(1)} LIT/order` : ""}</p>
            </div>
          </div>
        )}

        {dynOn && dynDrop != null && (
          <div>
            <div className="relative h-2.5 rounded-full bg-gray-800 overflow-hidden border border-gray-700">
              <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-green-500/70 via-yellow-500/70 to-red-500/80"
                   style={{ width: `${Math.min(dynDrop / 25, 1) * 100}%` }} />
              {[5, 10, 20].map((g) => (
                <div key={g} className="absolute inset-y-0 w-px bg-gray-400/60" style={{ left: `${(g / 25) * 100}%` }} />
              ))}
            </div>
            <div className="relative h-3 text-[9px] text-gray-500 tabular-nums">
              {[0, 5, 10, 20].map((g) => (
                <span key={g} className="absolute -translate-x-1/2 first:translate-x-0" style={{ left: `${(g / 25) * 100}%` }}>{g === 0 ? "high" : `−${g}%`}</span>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-lg border border-gray-700 overflow-hidden">
          <div className="grid grid-cols-3 bg-gray-800/80 text-[10px] uppercase tracking-wide text-gray-500 px-2 py-1">
            <span>Price fall</span><span>Switches at</span><span className="text-right">Money lasts to</span>
          </div>
          {([[0, 5, 10], [5, 10, 20], [10, 20, 40], [20, null, 99.9]] as const).map(([from, to, tier]) => {
            const active = dynOn && dynTier === tier;
            const ref = dynOn ? dynHigh : livePrice;
            return (
              <div key={tier} className={`grid grid-cols-3 px-2 py-1.5 text-xs tabular-nums border-t border-gray-800 ${active ? "bg-blue-500/15 text-blue-200 font-semibold" : "text-gray-400"}`}>
                <span>{active ? "▶ " : ""}{to == null ? `over ${from}%` : `${from}–${to}%`}</span>
                <span>{from === 0 ? "start" : ref != null ? `$${(ref * (1 - from / 100)).toFixed(4)}` : "—"}</span>
                <span className="text-right">{ref != null ? `$${(ref * (1 - tier / 100)).toFixed(4)}` : "—"} <span className="text-gray-500">(−{tier}%)</span></span>
              </div>
            );
          })}
        </div>
        <p className="text-gray-500 text-[10px] leading-snug">
          All % are measured from the high. At each switch the <span className="text-gray-300">available balance</span> is spread over every buy line from today's price down to "money lasts to", so new orders get smaller as price falls and the cash never runs out before that price.
          Orders already placed keep their size. When price climbs back above a switch price, orders grow again.
        </p>
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Completed Trades ({sellCount})</p>
        {sells.length === 0 ? (
          <p className="text-gray-600 text-sm">No completed trades yet</p>
        ) : (
          <div className="overflow-auto max-h-64">
            <table className="w-full table-fixed text-xs font-mono">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800 sticky top-0 bg-gray-900">
                  <th className="text-left pb-1 w-1/5">Time</th>
                  <th className="text-left pb-1 w-1/5">Bought</th>
                  <th className="text-left pb-1 w-1/5">Sold</th>
                  <th className="text-left pb-1 w-1/5">Qty</th>
                  <th className="text-left pb-1 w-1/5">Profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {sells.slice(0, 50).map((r: any) => {
                  const qty = Number(r.filled_qty ?? 0);
                  const profit = Number(r.realized_profit_usd ?? 0);
                  const quote = r.filled_quote != null ? Number(r.filled_quote) : qty * Number(r.filled_price ?? 0);
                  const bought = qty > 0 ? (quote - profit) / qty : null;
                  const time = r.filled_at
                    ? new Date(r.filled_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
                    : "";
                  return (
                    <tr key={r.id} className="hover:bg-gray-800/30">
                      <td className="py-1.5 text-gray-600">{time}</td>
                      <td className="py-1.5 text-gray-300">{bought != null ? bought.toFixed(4) : "—"}</td>
                      <td className="py-1.5 text-gray-300">{Number(r.filled_price ?? 0).toFixed(4)}</td>
                      <td className="py-1.5 text-gray-500">{qty.toFixed(2)}</td>
                      <td className={`py-1.5 font-bold ${pnlColor(profit)}`}>
                        {`${profit >= 0 ? "+" : "-"}$${Math.abs(profit).toFixed(4)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <details>
        <summary className="text-gray-500 text-xs uppercase tracking-wide mb-2 cursor-pointer">
          Order Ledger ({filledOrders.length} filled, {openOrders.length} open/pending)
        </summary>
        {orders.length === 0 ? (
          <p className="text-gray-600 text-sm">No orders yet</p>
        ) : (
          <div className="overflow-auto max-h-64">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800 sticky top-0 bg-gray-900">
                  <th className="text-left pb-1">Time</th>
                  <th className="text-left pb-1">Side</th>
                  <th className="text-left pb-1">Status</th>
                  <th className="text-right pb-1">Limit</th>
                  <th className="text-right pb-1">Filled</th>
                  <th className="text-right pb-1">Qty</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {orders.slice(0, 30).map((o: any) => {
                  const time = o.placed_at
                    ? new Date(o.placed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
                    : "";
                  return (
                    <tr key={o.id} className="hover:bg-gray-800/30">
                      <td className="py-1.5 text-gray-600">{time}</td>
                      <td className={`py-1.5 font-bold ${o.side === "buy" ? "text-yellow-400" : "text-green-400"}`}>
                        {o.side?.toUpperCase()}
                      </td>
                      <td className={`py-1.5 font-bold ${statusColor(o.status)}`}>{o.status}</td>
                      <td className="py-1.5 text-right text-gray-300">{Number(o.limit_price).toFixed(4)}</td>
                      <td className="py-1.5 text-right text-gray-300">
                        {o.filled_price != null ? Number(o.filled_price).toFixed(4) : "—"}
                      </td>
                      <td className="py-1.5 text-right text-gray-500">{Number(o.size).toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  );
}

// Real-money live grid bot controls need a shared secret (2026-10-18, audit finding -- these
// routes previously had no auth at all). Stored in localStorage only, never baked into the
// static JS bundle -- prompts the user once, reuses it after. Returns null if the user cancels.
function litGridLiveAdminSecret(): string | null {
  try {
    const existing = localStorage.getItem("litGridLiveAdminSecret");
    if (existing) return existing;
    const entered = prompt("Admin secret for the LIVE grid bot controls:");
    if (!entered) return null;
    localStorage.setItem("litGridLiveAdminSecret", entered);
    return entered;
  } catch {
    return prompt("Admin secret for the LIVE grid bot controls:");
  }
}

// Worker 1's real-money control routes (toggle/settings/reset/close-position) got the same
// admin-secret gate as the LIT grid bots (2026-10-21) -- same reused secret/prompt, since it's
// one dashboard behind one login already. If the user cancels the prompt, this resolves to a
// synthetic 401 Response instead of throwing, so every existing `res.ok`/`res.json()` call site
// below keeps working unchanged.
async function btcAdminPost(url: string, body: Record<string, unknown>): Promise<Response> {
  const secret = litGridLiveAdminSecret();
  if (!secret) {
    return new Response(JSON.stringify({ error: "Admin secret required." }), { status: 401 });
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-secret": secret },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    try { localStorage.removeItem("litGridLiveAdminSecret"); } catch {}
  }
  return res;
}

function currentSessionStart(nowUtc: Date): Date {
  // Mirrors stoch_bot_core.py's _current_session_start: 3 fixed 8h sessions,
  // 15:00-23:00 / 23:00-07:00 / 07:00-15:00 UTC (11am-7pm / 7pm-3am / 3am-11am ET).
  const hour = nowUtc.getUTCHours();
  const y = nowUtc.getUTCFullYear(), m = nowUtc.getUTCMonth(), d = nowUtc.getUTCDate();
  if (hour >= 15 && hour < 23) return new Date(Date.UTC(y, m, d, 15));
  if (hour < 7) return new Date(Date.UTC(y, m, d - 1, 23));
  if (hour < 15) return new Date(Date.UTC(y, m, d, 7));
  return new Date(Date.UTC(y, m, d, 23));
}

function CompactStochBtcPanel({
  title, subtitle, table, state, trades, currentPrice, loading, onToggled, runs, cooldownMin,
  showSelfLock, stats, tradingHoursUtc, combineEquityWinRate, rsiPaperStats, fixedSettings,
  selfLockUnlockRange, selfLockUnlockTitle, dormant,
}: {
  title: string; subtitle: string; table: string; state: any; trades: any[];
  currentPrice: number | null; loading: boolean; onToggled: () => void;
  runs?: any[]; cooldownMin?: number; showSelfLock?: boolean;
  stats?: { total: number; wins: number };
  tradingHoursUtc?: number[] | Record<number, number[]>;
  combineEquityWinRate?: boolean; rsiPaperStats?: { total: number; wins: number; pnlPct: number };
  fixedSettings?: { entryLo: number; entryHi: number; tpPct: number; slPct: number;
                    entryConfirmationMaxPct?: number };
  // Self-lock unlock label -- defaults to the live rule: 2 wins of any kind, OR 1 literal TP.
  // The old default said "2-3" (2 with a literal TP, or 3 of any kind); that rule no longer
  // exists anywhere -- see lighter_stoch_dca_btc_initial.py. Kept overridable per panel.
  // (historical note preserved below)
  // Self-lock unlock label -- previously Worker 1/3's rule ("2 with at least 1 literal TP, or
  // 3 of any kind"). Override per-bot when the actual unlock math differs (e.g. Worker 2:
  // "2 of any kind, or 1 literal TP unlocks instantly" -- milestone range 1-2, not 2-3).
  selfLockUnlockRange?: string; selfLockUnlockTitle?: string;
  // 2026-09-30, direct request: this bot's own account is currently being driven by a
  // DIFFERENT process (the hedge dual-leg bot) -- its table's `enabled` field is shared with
  // that process, so this panel's own toggle button could turn a leg of a DIFFERENT strategy
  // on/off without anyone touching the hedge's own control. dormant=true fully disconnects
  // this panel: no toggle button, no live state pulled from the (shared, currently
  // hedge-owned) table at all -- purely a static placeholder so the strategy stays documented
  // and easy to bring back later, without being able to interfere with whatever owns the
  // table right now.
  dormant?: boolean;
}) {
  if (dormant) {
    return (
      <div className="bg-gray-900 rounded-xl p-4 space-y-3 opacity-60">
        <div>
          <h3 className="text-white font-bold text-sm">{title}</h3>
          <p className="text-gray-500 text-[11px]">{subtitle}</p>
        </div>
        <div className="bg-gray-800/60 rounded-lg p-3 text-center">
          <p className="text-gray-400 text-xs font-semibold">Dormant -- account in use by another strategy</p>
          <p className="text-gray-600 text-[10px] mt-1">No toggle, no live data pulled here on purpose. Kept for reference to restore this strategy later.</p>
        </div>
      </div>
    );
  }
  const [toggling, setToggling] = useState(false);
  // 2026-10-10, direct request: "put the explanations in a pill, same size so all the other
  // panels match to each other" -- these subtitles vary wildly in length (Worker 1's is a long
  // running changelog, Worker 4/hedge's are short), which made the cards different heights when
  // placed side by side for comparison. Clamped to 2 lines by default; a "Details" toggle
  // reveals the full text without changing any other panel's height.
  const [showDetails, setShowDetails] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const side = state?.side ?? null;
  const liveK = state?.live_k ?? null;
  const liveSignal = state?.live_signal ?? null;
  // 2026-10-01: the intrabar dispersion filter's own live reading -- stdev of (high+low)/2
  // over the trailing N bars, raw $. Only meaningful for a bot running
  // intrabar_dispersion_pause_at (Worker 1's isolated test right now); null for every other
  // bot since the column is never written there. See compute_intrabar_dispersion.
  const liveDispersion = state?.live_intrabar_dispersion ?? null;
  const legs: any[] = state?.legs ?? [];
  const seedUsd = state?.seed_usd ?? 100;
  const realizedPnl = state?.realized_pnl_usd ?? 0;
  const equity = seedUsd + realizedPnl;
  const enabled = state?.enabled ?? false;
  // A trend-regime leg is entered with a wider TP than the fade default (0.10%) -- that's
  // the only signal we have client-side for which regime this open position belongs to.
  const posTpPct = state?.position_tp_pct ?? null;
  const positionRegime = side == null ? null : (posTpPct != null && posTpPct > 0.15 ? "trend" : "fade");

  const totalNotional = legs.reduce((s, l) => s + l.usd_size, 0);
  const totalQty = legs.reduce((s, l) => s + l.usd_size / l.price, 0);
  const avgEntry = totalQty > 0 ? totalNotional / totalQty : null;
  const unrealizedUsd = side && avgEntry && totalQty && currentPrice
    ? (side === "long" ? (currentPrice - avgEntry) : (avgEntry - currentPrice)) * totalQty
    : null;
  const unrealizedPct = side && avgEntry && currentPrice
    ? (side === "long" ? (currentPrice - avgEntry) / avgEntry : (avgEntry - currentPrice) / avgEntry) * 100
    : null;

  const closedTrades = trades.filter((t) => t.pnl_usd != null);
  // True lifetime count when available (stats), not the capped-at-200 fetch used for the
  // recent-trades list below -- that array alone silently freezes both numbers once a
  // worker passes 200 real trades.
  const trueTotal = stats?.total ?? closedTrades.length;
  const trueWins = stats?.wins ?? closedTrades.filter((t) => t.pnl_usd > 0).length;
  const winRate = trueTotal > 0 ? (trueWins / trueTotal * 100).toFixed(1) : "—";

  // Session drawdown breaker status: read directly from the persisted state row (the
  // backend's own authoritative source of truth) rather than re-deriving it from the runs
  // log -- a heuristic based on the last "session_drawdown_stop" run doesn't know when a
  // restart has already cleared the pause (which happens on every deploy, since Render
  // redeploys every service on any push, not just the one whose files changed) or when the
  // cooldown re-armed early at a new session boundary.
  let breakerPaused = false;
  let breakerResumeSec: number | null = null;
  let breakerTripDirection: string | null = null;
  if (cooldownMin) {
    breakerPaused = Boolean(state?.session_breaker_paused);
    breakerTripDirection = state?.session_breaker_trip_direction ?? null;
    // Read the server's own next-check time directly -- accurate for both a fixed cooldown
    // (Worker 3) and a dynamic recheck-until-calm resume (Worker 1), since the server (not
    // this client) is the one deciding when that next check actually happens.
    if (breakerPaused && state?.session_breaker_next_check_at) {
      const nextCheck = new Date(state.session_breaker_next_check_at);
      const now = new Date(nowTick);
      breakerResumeSec = Math.max(0, Math.round((nextCheck.getTime() - now.getTime()) / 1000));
    }
  }

  const [closing, setClosing] = useState(false);
  const closeRequested = Boolean(state?.close_requested);
  const [resetting, setResetting] = useState(false);
  // Manual exit levers -- same as the Worker 2 hedge panel, one row instead of two. Worker 4
  // (2026-10-10, exact clone of Worker 1) shares the same settings API route and table shape,
  // so it gets the identical set of controls, each independently writing its own table.
  const showLevers = table === "lighter_btc_initial_state" || table === "lighter_btc_worker4_state";
  const [slIn, setSlIn] = useState("");
  const [trigIn, setTrigIn] = useState("");
  const [trailIn, setTrailIn] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const liveZebra: number | null = state?.live_zebra_index ?? null;
  // 2026-10-05, direct report: "the BTC volume on the universal panel is not the same as the
  // BTC volume on the Worker 1 panel" -- both are compute_candle_volume_avg(candles, 10), same
  // formula/window, but written by two SEPARATE calls at different points in the tick (this
  // one gated behind volume_regime_switch_threshold being set; live_schedule_volume now
  // unconditional) -- same drift-from-two-writers bug as the earlier wiggle/volume box, fixed
  // the same way: one source of truth.
  const liveCandleVolume: number | null = state?.live_schedule_volume ?? state?.live_candle_volume ?? null;
  // 2-hour efficiency ratio (2026-10-04, direct request: "publish the ER 2 hours... so I can see
  // it") -- same net-move/path-length formula as the hedge's ER15, over 120 candles instead of
  // 15. Research this session found ER15 too noisy to tell a choppy day from a trending one; a
  // 120-candle window's DIRECTION holding steady across several checks (not the number alone,
  // and not any single reading) was the cleanest signal found. Readout only, gates nothing.
  const liveEr2h: number | null = state?.live_er_2h ?? null;
  const liveEr2hDir: string | null = state?.live_er_2h_direction ?? null;
  const liveStreakDir: string | null = state?.live_flip_streak_dir ?? null;
  const liveStreakLen: number | null = state?.live_flip_streak_len ?? null;
  const curSl = state?.override_sl_pct ?? null;
  const curTrig = state?.override_profit_lock_trigger ?? null;
  const curTrail = state?.override_profit_lock_trail ?? null;
  // Exit mode (2026-10-03, direct request: "build the same thing for worker 1" -- mirrors the
  // hedge's trail/TP switch). "trail" (default) reproduces disable_literal_tp/profit_lock_enabled
  // exactly as compiled; "tp" makes a literal TP (at curTp) the only winner exit and suppresses
  // the trail. SL is never touched either way. See StochBot._exit_params's docstring.
  const curTp = state?.override_tp_pct ?? null;
  const curExitMode: string = state?.override_exit_mode ?? "trail";
  const [tpIn, setTpIn] = useState("");
  const [savingExitMode, setSavingExitMode] = useState(false);
  // Dwell (2026-10-03, direct request: "a dwell strategy... used in both fixed TP and trail").
  // Applies to whichever winner-exit is active (TP in tp mode, the trail's pullback in trail
  // mode) -- SL is never delayed. 0 (default) is instant, same as before this existed.
  const curDwell: number = state?.override_dwell_seconds ?? 0;
  const [dwellIn, setDwellIn] = useState("");
  // SL dwell (2026-10-06, direct request after backtesting it against real trades: "lets do 30
  // seconds... leave it open so we can change it manually later"). Separate from the dwell
  // above -- that one never touches SL, this one ONLY touches the plain SL (not the escalated
  // tiers' hard cap, which stays instant on purpose). 0 (default) is instant, unchanged.
  const curSlDwell: number = state?.override_sl_dwell_seconds ?? 0;
  const [slDwellIn, setSlDwellIn] = useState("");

  async function handleSetExitMode(mode: "trail" | "tp") {
    // "floor" (partner-cut breakeven floor) is deliberately NOT offered here -- it only ever
    // arms once a cycle PARTNER closes, and Worker 1 has no partner (no cycle_partner_table),
    // so it would silently never do anything: TP and the trail would both be off with no floor
    // ever arming, leaving the position running on SL alone forever. Hedge-only -- see the
    // HedgeDualLegPanel's own handleSetExitMode.
    if (mode === curExitMode) return;
    if (!confirm(
      mode === "tp"
        ? `Switch ${title} to fixed-TP mode? The profit-lock trail is suppressed; only SL and the TP level close a winner. Takes effect immediately, including on an open position.`
        : `Switch ${title} back to trail mode? Literal TP is disabled again; the profit-lock trail governs winners, same as before. Takes effect immediately, including on an open position.`
    )) return;
    setSavingExitMode(true);
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, exitMode: mode });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not switch exit mode.");
    }
    await onToggled();
    setSavingExitMode(false);
  }
  // Escalated/leveled SL (2026-10-06, direct request after digging into real trade data: "i
  // have lost 2 times since i put SL... build it"). Off by default, REPLACES the plain SL
  // entirely when on -- see StochBot/BotConfig.escalated_sl_enabled's docstring.
  const escalatedSlOn: boolean = state?.override_escalated_sl_enabled ?? false;
  const [savingEscalatedSl, setSavingEscalatedSl] = useState(false);
  async function handleToggleEscalatedSl() {
    const next = !escalatedSlOn;
    if (!confirm(
      next
        ? `Turn ON escalated SL? This REPLACES the plain SL entirely:\n\n`
          + `- -0.05% within 2 min AND live volume < 3 BTC/min -> exit\n`
          + `- -0.10% AND volume < 3 -> exit\n`
          + `- -0.12% -> hard cap, exits regardless\n\n`
          + `Takes effect immediately, including on an open position.`
        : `Turn OFF escalated SL? Goes back to the plain SL/Trigger/Trail boxes below. Takes effect immediately, including on an open position.`
    )) return;
    setSavingEscalatedSl(true);
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, escalatedSlEnabled: next });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not toggle escalated SL.");
    }
    await onToggled();
    setSavingEscalatedSl(false);
  }
  // Require-fresh-signal (2026-10-16, direct request: "can you make needs fresh signal a
  // toggle" -- for Worker 1, Worker 4 and the hedge). Previously compiled-only; defaults to ON
  // here since that's the compiled value on both bots that use this panel today.
  const requireFreshSignalOn: boolean = state?.override_require_fresh_signal ?? true;
  const [savingRequireFreshSignal, setSavingRequireFreshSignal] = useState(false);
  async function handleToggleRequireFreshSignal() {
    const next = !requireFreshSignalOn;
    if (!confirm(
      next
        ? `Turn ON require-fresh-signal for ${title}? Only enters on the exact candle a signal first appears -- a signal that's already been sitting active for 2+ candles is skipped. Takes effect immediately.`
        : `Turn OFF require-fresh-signal for ${title}? Will enter on a signal even if it's been active for a while, not just the fresh flip. Takes effect immediately.`
    )) return;
    setSavingRequireFreshSignal(true);
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, requireFreshSignal: next });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not toggle require-fresh-signal.");
    }
    await onToggled();
    setSavingRequireFreshSignal(false);
  }
  // Signal on/off toggles -- NULL on the row means "use the compiled default", which is True
  // for all three signal toggles. Must match BotConfig's own defaults in _regime_controls.
  const stochasticOn = state?.override_stochastic_enabled ?? true;
  const zebraOn = state?.override_zebra_enabled ?? true;
  const flipOn = state?.override_flip_enabled ?? true;
  // Must match volume_regime_switch_threshold in lighter_stoch_dca_btc_initial.py.
  const curVolThreshold: number = state?.override_volume_switch_threshold ?? 4;
  const [volThresholdIn, setVolThresholdIn] = useState("");
  const [savingSignal, setSavingSignal] = useState<string | null>(null);
  // Must match entry_lo/entry_hi and reversal_lo/reversal_hi in lighter_stoch_dca_btc_initial.py.
  // Independently overridable (2026-10-02, direct request: "a number for the reversal and a
  // number for the entry signal" -- an earlier version tied these together, revised same day).
  const curEntryLo: number = state?.override_stoch_band_lo ?? 25;
  const curEntryHi: number = state?.override_stoch_band_hi ?? 75;
  const curReversalLo: number = state?.override_stoch_reversal_lo ?? 25;
  const curReversalHi: number = state?.override_stoch_reversal_hi ?? 75;
  const [entryLoIn, setEntryLoIn] = useState("");
  const [entryHiIn, setEntryHiIn] = useState("");
  const [reversalLoIn, setReversalLoIn] = useState("");
  const [reversalHiIn, setReversalHiIn] = useState("");
  // Stochastic window (2026-10-04, direct request: "change the window of stochastic for worker
  // 1"). Candle count, not a K value -- governs both the entry and reversal bands above (one K
  // per tick, tested against both).
  const curStochWindow: number = state?.override_stoch_window ?? 5;
  const [stochWindowIn, setStochWindowIn] = useState("");

  async function handleApplyStochWindow() {
    if (!stochWindowIn.trim()) return;
    if (!confirm(`Set the stochastic window to ${stochWindowIn.trim()} candles for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("stochWindow");
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, stochWindow: stochWindowIn.trim() });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else {
      setStochWindowIn("");
    }
    await onToggled();
    setSavingSignal(null);
  }

  async function handleApplyBand(kind: "entry" | "reversal") {
    const [loIn, hiIn, curLo, curHi] = kind === "entry"
      ? [entryLoIn, entryHiIn, curEntryLo, curEntryHi]
      : [reversalLoIn, reversalHiIn, curReversalLo, curReversalHi];
    if (!loIn.trim() && !hiIn.trim()) return;
    if (!confirm(`Set the ${kind} band to ${loIn.trim() || curLo} / ${hiIn.trim() || curHi} for ${title}? Takes effect immediately.`)) return;
    setSavingSignal(kind);
    const payload: Record<string, string> = {};
    const loKey = kind === "entry" ? "bandLo" : "reversalLo";
    const hiKey = kind === "entry" ? "bandHi" : "reversalHi";
    if (loIn.trim()) payload[loKey] = loIn.trim();
    if (hiIn.trim()) payload[hiKey] = hiIn.trim();
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, ...payload });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else if (kind === "entry") {
      setEntryLoIn(""); setEntryHiIn("");
    } else {
      setReversalLoIn(""); setReversalHiIn("");
    }
    await onToggled();
    setSavingSignal(null);
  }

  // Volume-jump guard (2026-10-02, direct request: "this cannot happen" after a real loss
  // traced to an outlier candle distorting the stochastic). Must match volume_jump_ratio /
  // volume_jump_pause_seconds in lighter_stoch_dca_btc_initial.py.
  const liveJumpRatio: number | null = state?.live_volume_jump_ratio ?? null;
  const curJumpRatio: number = state?.override_volume_jump_ratio ?? 3.0;
  const curJumpPause: number = state?.override_volume_jump_pause_seconds ?? 1800;
  // On/off switch (2026-10-04, direct request: "put a switch on an off for the volume jump
  // gard") -- separate from the ratio/pause numbers so the guard can be disabled without losing
  // the configured threshold, same pattern as the wiggle lock's switch.
  const curJumpGuardEnabled: boolean = state?.override_volume_jump_enabled ?? true;

  async function handleToggleJumpGuard(next: boolean) {
    if (!confirm(`Turn the volume-jump guard ${next ? "ON" : "OFF"} for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("jumpGuardEnabled");
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, jumpGuardEnabled: next });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingSignal(null);
  }
  // 3-arm early release (2026-10-03, direct request: "build them both... volume, wiggle, or
  // rate"). All three readings always show, regardless of which (if any) is selected as the
  // controlling arm -- "off" (default) is the plain fixed-timer pause, unchanged from before.
  const liveWiggle: number | null = state?.live_wiggle ?? null;
  const liveJumpRate: number | null = state?.live_volume_jump_rate ?? null;
  const curReleaseMode: string = state?.override_volume_jump_release_mode ?? "off";
  // Release-target readout (2026-10-03, direct report: "I only see the timer... you need to
  // put the volume at which it was paused") -- without this there's no way to tell a
  // wiggle/volume/rate release is making real progress versus just silently riding out the
  // fixed cap. null whenever no arm is selected or nothing is currently paused.
  const liveReleasePeak: number | null = state?.live_volume_jump_release_peak ?? null;
  const releaseUnit = curReleaseMode === "volume" ? " BTC" : curReleaseMode === "rate" ? " BTC/min" : "";
  const releasePrefix = curReleaseMode === "wiggle" ? "$" : "";
  const [savingRelease, setSavingRelease] = useState(false);

  async function handleSetReleaseMode(mode: "off" | "volume" | "wiggle" | "rate") {
    if (mode === curReleaseMode) return;
    if (!confirm(`Set the volume-jump pause's early release to "${mode}" for ${title}? Takes effect immediately.`)) return;
    setSavingRelease(true);
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, releaseMode: mode });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingRelease(false);
  }
  // Explicit pause-until readout (2026-10-03, direct request: "it does not tell me if armed
  // not armed") -- the instant ratio above can read calm while an earlier spike's pause is
  // still active; this is the actual gate state, not just the current reading.
  const jumpPausedUntil: Date | null = state?.live_volume_jump_paused_until
    ? new Date(state.live_volume_jump_paused_until) : null;
  // Optimistic clear (2026-10-03, direct report: "it does not clear" after clicking the
  // button while genuinely paused). The backend DOES clear it -- confirmed live both times --
  // but live_volume_jump_paused_until is only written back to the DB on a 10s throttle
  // (_live_signal_persist_ts), and nothing else refetches this table on a tighter cadence than
  // that. A click's own onToggled() reload can easily land in that gap and show the stale
  // still-paused value for up to ~10s with no visible change. Mask jumpPausedUntil for a short
  // window after a successful click; a real NEW spike within that window will still show once
  // the window expires and a fresh read confirms it -- this never suppresses the guard itself,
  // only how soon the dashboard admits a new spike re-armed it.
  const [jumpClearClickedAt, setJumpClearClickedAt] = useState<number | null>(null);
  const jumpClearMasking = jumpClearClickedAt != null && nowTick - jumpClearClickedAt < 12000;
  const jumpPausedActive = !jumpClearMasking && jumpPausedUntil != null && jumpPausedUntil.getTime() > nowTick;
  const jumpSecondsLeft = jumpPausedActive ? Math.max(0, Math.round((jumpPausedUntil!.getTime() - nowTick) / 1000)) : 0;
  const [jumpRatioIn, setJumpRatioIn] = useState("");
  const [jumpPauseIn, setJumpPauseIn] = useState("");

  async function handleApplyJumpGuard() {
    if (!jumpRatioIn.trim() && !jumpPauseIn.trim()) return;
    if (!confirm(`Set the volume-jump guard to ratio ${jumpRatioIn.trim() || curJumpRatio}x / pause ${jumpPauseIn.trim() || curJumpPause}s for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("jump");
    const payload: Record<string, string> = {};
    if (jumpRatioIn.trim()) payload.jumpRatio = jumpRatioIn.trim();
    if (jumpPauseIn.trim()) payload.jumpPause = jumpPauseIn.trim();
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, ...payload });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else {
      setJumpRatioIn(""); setJumpPauseIn("");
    }
    await onToggled();
    setSavingSignal(null);
  }

  // Manual "clear pause" button (2026-10-03, direct request). Writes a marker timestamp the
  // backend compares against the spike time -- a genuinely new spike after this still arms
  // normally, this only forgives the pause already in progress.
  async function handleClearVolumeJump() {
    if (!confirm(`Clear the current volume-jump pause for ${title}? A new spike will still re-arm it normally.`)) return;
    setSavingSignal("jumpClear");
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, clearVolumeJump: true });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not clear the pause.");
    } else {
      setJumpClearClickedAt(Date.now());
    }
    await onToggled();
    setSavingSignal(null);
  }

  // Volume/wiggle lock (2026-10-03, direct request after a live "market manipulation" concern
  // -- "we need something to detect very quickly so we can lock in the bot and get out"). Ratio
  // = wiggle (intrabar dispersion) / volume_avg -- flipped 2026-10-05 ("rechange the calculation
  // of volume/wiggle to wiggle/volume"), so LOW now means chop (little price movement per unit
  // of volume) and the lock fires BELOW the threshold, not above. Unlike the jump guard above
  // this is a pure instant reading with no peak-tracking or pause timer -- it blocks new entries
  // only while the ratio stays below the threshold, and releases the instant it rises back up.
  const liveWiggleRatio: number | null = state?.live_volume_wiggle_ratio ?? null;
  const curWiggleLockThreshold: number | null = state?.override_volume_wiggle_lock_threshold ?? null;
  const curWiggleLockEnabled: boolean = state?.override_volume_wiggle_lock_enabled ?? true;
  const wiggleLocked = curWiggleLockEnabled && curWiggleLockThreshold != null
    && liveWiggleRatio != null && liveWiggleRatio < curWiggleLockThreshold;
  const [wiggleLockThresholdIn, setWiggleLockThresholdIn] = useState("");

  async function handleSetWiggleLockThreshold() {
    if (!wiggleLockThresholdIn.trim()) return;
    if (!confirm(`Set the volume/wiggle lock threshold to ${wiggleLockThresholdIn.trim()} for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("wiggleLock");
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, wiggleLock: wiggleLockThresholdIn.trim() });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else {
      setWiggleLockThresholdIn("");
    }
    await onToggled();
    setSavingSignal(null);
  }

  async function handleToggleWiggleLock(next: boolean) {
    if (!confirm(`Turn the volume/wiggle lock ${next ? "ON" : "OFF"} for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("wiggleLockEnabled");
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, wiggleLockEnabled: next });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingSignal(null);
  }

  // Wiggle/vol RISE exit (2026-10-09, direct request after a real-trade audit: "the moment
  // your wiggle volume goes up by 10%"). A SEPARATE mechanism from the entry lock above --
  // this watches the ratio's own RISE relative to the position's own entry reading, not an
  // absolute level, and only ever closes, never blocks an entry. See
  // BotConfig.wiggle_vol_rise_exit_pct.
  const curWiggleVolRisePct: number | null = state?.override_wiggle_vol_rise_exit_pct ?? null;
  const curWiggleVolRiseEnabled: boolean = state?.override_wiggle_vol_rise_exit_enabled ?? true;
  const [wiggleVolRisePctIn, setWiggleVolRisePctIn] = useState("");

  async function handleSetWiggleVolRisePct() {
    if (!wiggleVolRisePctIn.trim()) return;
    if (!confirm(`Set the wiggle/vol RISE exit to ${wiggleVolRisePctIn.trim()}% for ${title}? Closes a position the moment its own wig/vol ratio rises this much from entry. Takes effect immediately, including on an open position.`)) return;
    setSavingSignal("wiggleVolRiseExit");
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, wiggleVolRiseExit: wiggleVolRisePctIn.trim() });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else {
      setWiggleVolRisePctIn("");
    }
    await onToggled();
    setSavingSignal(null);
  }

  async function handleToggleWiggleVolRise(next: boolean) {
    if (!confirm(`Turn the wiggle/vol RISE exit ${next ? "ON" : "OFF"} for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("wiggleVolRiseExitEnabled");
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, wiggleVolRiseExitEnabled: next });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingSignal(null);
  }

  // Higher-timeframe stochastic alignment block (2026-10-09, direct request after a real-data
  // study on 449 real trades: aligned entries ran 56-60% win/net LOSS, not-aligned ran 70-81%
  // win/net WIN, strongest at 5-minute). Blocks a fresh/reopen entry only, never an exit.
  const curHtfTimeframe: string = state?.override_htf_alignment_block_timeframe ?? "off";
  const liveHtfK: number | null = state?.live_htf_k ?? null;
  const [savingHtf, setSavingHtf] = useState(false);

  async function handleSetHtfTimeframe(tf: "off" | "5m" | "10m" | "1h") {
    if (tf === curHtfTimeframe) return;
    if (!confirm(`Set the higher-timeframe alignment block to "${tf}" for ${title}? Blocks a fresh entry whenever that timeframe's stochastic agrees with the 1-min signal. Takes effect immediately.`)) return;
    setSavingHtf(true);
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, htfBlockTimeframe: tf });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingHtf(false);
  }

  // Volume-rate guard (2026-10-08, direct request after backtesting it against real trades:
  // "if 20% we dont take the trade and wait for the next signal"). Same instant/no-pause-timer
  // contract as the wiggle lock above, but blocks on HIGH readings, not low -- see
  // StochBot._update_volume_rate_guard.
  const liveVolumeRatePct: number | null = state?.live_volume_rate_pct ?? null;
  const curRateGuardThreshold: number | null = state?.override_volume_rate_guard_threshold ?? null;
  const curRateGuardEnabled: boolean = state?.override_volume_rate_guard_enabled ?? true;
  const rateGuardActive = curRateGuardEnabled && curRateGuardThreshold != null
    && liveVolumeRatePct != null && liveVolumeRatePct > curRateGuardThreshold;
  const [rateGuardThresholdIn, setRateGuardThresholdIn] = useState("");

  async function handleSetRateGuardThreshold() {
    if (!rateGuardThresholdIn.trim()) return;
    if (!confirm(`Set the volume-rate guard threshold to ${rateGuardThresholdIn.trim()}% for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("rateGuard");
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, rateGuard: rateGuardThresholdIn.trim() });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else {
      setRateGuardThresholdIn("");
    }
    await onToggled();
    setSavingSignal(null);
  }

  async function handleToggleRateGuard(next: boolean) {
    if (!confirm(`Turn the volume-rate guard ${next ? "ON" : "OFF"} for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("rateGuardEnabled");
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, rateGuardEnabled: next });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingSignal(null);
  }

  // Entry wiggle/vol ratio gate (2026-10-15, direct request): an external backtest audit on
  // real tick execution found gating fresh entries on compute_volume_wiggle_ratio() sitting
  // inside [min, max) turned a losing sample net positive. Reuses the SAME live reading the
  // volume/wiggle lock above already publishes (live_volume_wiggle_ratio) -- this is a
  // two-sided band on that identical metric, not a separate computation. Compiled off
  // everywhere; off here too (??false, not ??true) until an override actually turns it on.
  const curEntryWiggleRatioEnabled: boolean = state?.override_entry_wiggle_ratio_enabled ?? false;
  const curEntryWiggleRatioMin: number | null = state?.override_entry_wiggle_ratio_min ?? null;
  const curEntryWiggleRatioMax: number | null = state?.override_entry_wiggle_ratio_max ?? null;
  const entryWiggleRatioActive = curEntryWiggleRatioEnabled
    && (liveWiggleRatio == null
        || (curEntryWiggleRatioMin != null && liveWiggleRatio < curEntryWiggleRatioMin)
        || (curEntryWiggleRatioMax != null && liveWiggleRatio > curEntryWiggleRatioMax));
  const [entryWiggleRatioMinIn, setEntryWiggleRatioMinIn] = useState("");
  const [entryWiggleRatioMaxIn, setEntryWiggleRatioMaxIn] = useState("");

  async function handleToggleEntryWiggleRatio(next: boolean) {
    if (!confirm(`Turn the entry wiggle/vol ratio gate ${next ? "ON" : "OFF"} for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("entryWiggleRatioEnabled");
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, entryWiggleRatioEnabled: next });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingSignal(null);
  }

  async function handleSetEntryWiggleRatioBand() {
    if (!entryWiggleRatioMinIn.trim() && !entryWiggleRatioMaxIn.trim()) return;
    const lo = entryWiggleRatioMinIn.trim() || String(curEntryWiggleRatioMin ?? "off");
    const hi = entryWiggleRatioMaxIn.trim() || String(curEntryWiggleRatioMax ?? "off");
    if (!confirm(`Set the entry wiggle/vol ratio band to ${lo} / ${hi} for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("entryWiggleRatioBand");
    const payload: Record<string, string> = {};
    if (entryWiggleRatioMinIn.trim()) payload.entryWiggleRatioMin = entryWiggleRatioMinIn.trim();
    if (entryWiggleRatioMaxIn.trim()) payload.entryWiggleRatioMax = entryWiggleRatioMaxIn.trim();
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, ...payload });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else {
      setEntryWiggleRatioMinIn(""); setEntryWiggleRatioMaxIn("");
    }
    await onToggled();
    setSavingSignal(null);
  }

  // Peak window (2026-10-17, direct request: "build the peak rule with a panel where we can
  // modify the rules and on/off toggle"). Research: real trades cluster into wins a specific
  // number of hours after a real volume*wiggle "product" spike -- see
  // BotConfig.peak_window_enabled's docstring for the causal detection algorithm.
  const curPeakWindowEnabled: boolean = state?.override_peak_window_enabled ?? false;
  const curPeakFloor: number | null = state?.override_peak_window_floor ?? null;
  const curPeakConfirm: number | null = state?.override_peak_window_confirm_minutes ?? null;
  const curPeakSeparation: number | null = state?.override_peak_window_min_separation_hours ?? null;
  const curPeakStart: number | null = state?.override_peak_window_start_hours ?? null;
  const curPeakEnd: number | null = state?.override_peak_window_end_hours ?? null;
  const livePeakProduct: number | null = state?.live_peak_product ?? null;
  const livePeakHoursSince: number | null = state?.live_peak_hours_since ?? null;
  const livePeakActive: boolean | null = state?.live_peak_window_active ?? null;
  const [savingPeakWindow, setSavingPeakWindow] = useState(false);
  const [peakFloorIn, setPeakFloorIn] = useState("");
  const [peakConfirmIn, setPeakConfirmIn] = useState("");
  const [peakSeparationIn, setPeakSeparationIn] = useState("");
  const [peakStartIn, setPeakStartIn] = useState("");
  const [peakEndIn, setPeakEndIn] = useState("");

  async function handleTogglePeakWindow() {
    const next = !curPeakWindowEnabled;
    if (!confirm(`Turn the peak window ${next ? "ON" : "OFF"} for ${title}? When ON, only allowed to enter in the configured window after a confirmed peak -- blocks entirely until the first peak confirms. Takes effect immediately.`)) return;
    setSavingPeakWindow(true);
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, peakWindowEnabled: next });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not toggle the peak window.");
    }
    await onToggled();
    setSavingPeakWindow(false);
  }

  async function handleSetPeakDefinition() {
    if (!peakFloorIn.trim() && !peakConfirmIn.trim() && !peakSeparationIn.trim()) return;
    if (!confirm(`Set the peak definition for ${title}? Takes effect immediately.`)) return;
    setSavingPeakWindow(true);
    const payload: Record<string, string> = {};
    if (peakFloorIn.trim()) payload.peakWindowFloor = peakFloorIn.trim();
    if (peakConfirmIn.trim()) payload.peakWindowConfirmMinutes = peakConfirmIn.trim();
    if (peakSeparationIn.trim()) payload.peakWindowSeparationHours = peakSeparationIn.trim();
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, ...payload });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else {
      setPeakFloorIn(""); setPeakConfirmIn(""); setPeakSeparationIn("");
    }
    await onToggled();
    setSavingPeakWindow(false);
  }

  async function handleSetPeakWindowHours() {
    if (!peakStartIn.trim() && !peakEndIn.trim()) return;
    const lo = peakStartIn.trim() || String(curPeakStart ?? "off");
    const hi = peakEndIn.trim() || String(curPeakEnd ?? "off");
    if (!confirm(`Set the peak trading window to ${lo}-${hi}h after the peak for ${title}? Takes effect immediately.`)) return;
    setSavingPeakWindow(true);
    const payload: Record<string, string> = {};
    if (peakStartIn.trim()) payload.peakWindowStartHours = peakStartIn.trim();
    if (peakEndIn.trim()) payload.peakWindowEndHours = peakEndIn.trim();
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, ...payload });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else {
      setPeakStartIn(""); setPeakEndIn("");
    }
    await onToggled();
    setSavingPeakWindow(false);
  }

  async function handleToggleSignal(key: "stochastic" | "zebra" | "flip", label: string, next: boolean) {
    if (!confirm(`Turn ${label} ${next ? "ON" : "OFF"} for ${title}? Takes effect immediately.`)) return;
    setSavingSignal(key);
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, [key]: next });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingSignal(null);
  }

  async function handleApplyVolThreshold() {
    if (!volThresholdIn.trim()) return;
    if (!confirm(`Set the volume switch threshold to ${volThresholdIn.trim()} BTC for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("volThreshold");
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, volThreshold: volThresholdIn.trim() });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else {
      setVolThresholdIn("");
    }
    await onToggled();
    setSavingSignal(null);
  }

  async function handleApplySettings() {
    const payload: Record<string, string> = {};
    if (slIn.trim()) payload.sl = slIn.trim();
    if (trigIn.trim()) payload.trigger = trigIn.trim();
    if (trailIn.trim()) payload.trail = trailIn.trim();
    if (tpIn.trim()) payload.tp = tpIn.trim();
    if (dwellIn.trim()) payload.dwell = dwellIn.trim();
    if (slDwellIn.trim()) payload.slDwell = slDwellIn.trim();
    if (Object.keys(payload).length === 0) return;
    if (!confirm(
      `Apply to ${title}?\n\n`
      + `SL          ${payload.sl ?? "(unchanged)"}%\n`
      + `Trigger     ${payload.trigger ?? "(unchanged)"}%\n`
      + `Trail       ${payload.trail ?? "(unchanged)"}%\n`
      + `TP          ${payload.tp ?? "(unchanged)"}%\n`
      + `Trail Dwell ${payload.dwell ?? "(unchanged)"}s\n`
      + `SL Dwell    ${payload.slDwell ?? "(unchanged)"}s\n\n`
      + `Takes effect immediately, including on an open position.`
    )) return;
    setSavingSettings(true);
    const res = await btcAdminPost("/api/lighter-btc-initial-settings", { table, ...payload });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply settings.");
    } else { setSlIn(""); setTrigIn(""); setTrailIn(""); setTpIn(""); setDwellIn(""); setSlDwellIn(""); }
    await onToggled();
    setSavingSettings(false);
  }

  async function handleReset() {
    if (!confirm(`Reset ${title}? Rolls PnL into equity and hides trades before now -- nothing is deleted, all trades stay in the database for research. Only works while flat.`)) return;
    setResetting(true);
    const res = await btcAdminPost("/api/lighter-btc-initial-reset", { table });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Reset failed.");
    }
    await onToggled();
    setResetting(false);
  }

  async function handleToggle() {
    const question = enabled
      ? `Turn OFF ${title}? This stops new entries -- it will NOT close an existing position.`
      : `Turn ON ${title}? This resumes real trading.`;
    if (!confirm(question)) return;
    setToggling(true);
    try {
      const res = await btcAdminPost("/api/lighter-btc-toggle", { table });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        alert(body?.error ?? "Could not confirm the ON/OFF change. Check the current state before trying again.");
      }
      await onToggled();
    } catch {
      alert("Could not confirm the ON/OFF change. Refresh the dashboard to check the current state before trying again.");
    } finally {
      setToggling(false);
    }
  }

  async function handleClosePosition() {
    if (!confirm(`Close the real ${side?.toUpperCase()} position on ${title} now? This places a real market order.`)) return;
    setClosing(true);
    await btcAdminPost("/api/lighter-btc-close-position", { table });
    await onToggled();
    setClosing(false);
  }

  return (
    <div className="bg-gray-900 rounded-xl p-4 space-y-3">
      {/* 2026-10-01, direct request: buttons BELOW the paragraph, same layout as the Worker 2
          hedge panel, instead of squeezed beside the title. */}
      <div className="space-y-2.5">
        <div>
          <h3 className="text-white font-bold text-sm">{title}</h3>
          <p className={`text-gray-500 text-[11px] leading-relaxed ${showDetails ? "" : "line-clamp-2"}`}>{subtitle}</p>
          <button
            onClick={() => setShowDetails((v) => !v)}
            className="text-[10px] font-semibold text-blue-400/70 hover:text-blue-300 mt-0.5"
          >
            {showDetails ? "Hide details ▲" : "Details ▾"}
          </button>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {side != null && (
            <button
              onClick={handleClosePosition}
              disabled={closing || closeRequested || loading}
              className="text-xs font-semibold px-2.5 py-1 rounded-full bg-gray-800 text-red-400/70 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-50"
              title="Close the real position now, regardless of the ON/OFF toggle"
            >
              {closing ? "…" : closeRequested ? "Closing…" : "Close"}
            </button>
          )}
          {(table === "lighter_btc_initial_state" || table === "lighter_btc_worker4_state") && (
            <button
              onClick={handleReset}
              disabled={resetting || side != null || loading}
              className="text-xs font-semibold px-2.5 py-1 rounded-full bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white transition-all disabled:opacity-50"
              title="Roll current equity into a fresh baseline and hide trade history before now -- nothing is deleted. Refuses while a position is open."
            >
              {resetting ? "…" : "Reset"}
            </button>
          )}
          <button
            onClick={handleToggle}
            disabled={toggling || loading}
            className={`text-xs font-bold px-2.5 py-1 rounded-full ${enabled ? "bg-green-500/20 text-green-400" : "bg-gray-700/40 text-gray-500"}`}
          >
            {toggling ? "…" : enabled ? "ON" : "OFF"}
          </button>
        </div>
      </div>
      {loading ? (
        <div className="h-16 bg-gray-800 rounded-lg animate-pulse" />
      ) : (() => {
        const equityPill = (
          <div className="bg-gray-800/60 rounded-lg p-2">
            <p className="text-gray-500 text-[10px] uppercase">Equity</p>
            <p className={`font-bold ${realizedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              ${equity.toFixed(2)} <span className="text-[10px] font-normal">({realizedPnl >= 0 ? "+" : ""}{(realizedPnl / seedUsd * 100).toFixed(2)}%)</span>
            </p>
          </div>
        );
        const winRatePill = (
          <div className="bg-gray-800/60 rounded-lg p-2">
            <p className="text-gray-500 text-[10px] uppercase">Win Rate</p>
            <p className="font-bold text-blue-400">{winRate}% <span className="text-[10px] font-normal text-gray-500">({trueTotal})</span></p>
          </div>
        );
        const equityWinRatePill = (
          <div className="bg-gray-800/60 rounded-lg p-2">
            <p className="text-gray-500 text-[10px] uppercase">Equity / Win Rate</p>
            <p className={`font-bold ${realizedPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
              ${equity.toFixed(2)} <span className="text-[10px] font-normal">({realizedPnl >= 0 ? "+" : ""}{(realizedPnl / seedUsd * 100).toFixed(2)}%)</span>
            </p>
            <p className="font-bold text-blue-400 text-[11px] mt-0.5">{winRate}% win <span className="text-[10px] font-normal text-gray-500">({trueTotal})</span></p>
          </div>
        );
        const positionPill = (
          <div className={`bg-gray-800/60 rounded-lg p-2 ${!combineEquityWinRate && cooldownMin == null && !showSelfLock && !tradingHoursUtc ? "col-span-2" : ""}`}>
            <p className="text-gray-500 text-[10px] uppercase">Position</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`font-bold ${side === "long" ? "text-green-400" : side === "short" ? "text-amber-400" : "text-gray-400"}`}>
                {side ? side.toUpperCase() : "FLAT"}
              </span>
              {positionRegime && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${positionRegime === "trend" ? "bg-purple-500/20 text-purple-300" : "bg-blue-500/20 text-blue-300"}`}>
                  {positionRegime}
                </span>
              )}
              {unrealizedUsd != null && (
                <span className={`text-[10px] font-normal ${unrealizedUsd >= 0 ? "text-green-400" : "text-red-400"}`}>
                  ({unrealizedUsd >= 0 ? "+" : ""}${unrealizedUsd.toFixed(2)}{unrealizedPct != null ? ` / ${unrealizedPct >= 0 ? "+" : ""}${unrealizedPct.toFixed(3)}%` : ""})
                </span>
              )}
            </div>
            {side && avgEntry != null && currentPrice != null && (() => {
              // Progress toward TP -- position_tp_pct is per-position (trend leg vs fade leg
              // can differ), falls back to the bot's default fade tp_pct like the backend does.
              const tpPct = state?.position_tp_pct ?? 0.10;
              const gainPct = side === "long"
                ? (currentPrice - avgEntry) / avgEntry * 100
                : (avgEntry - currentPrice) / avgEntry * 100;
              const progress = Math.max(0, Math.min(100, (gainPct / tpPct) * 100));
              return (
                <div className="mt-1.5">
                  <div className="flex items-center justify-between text-[9px] text-gray-500 tabular-nums">
                    <span className={gainPct >= 0 ? "text-green-400" : "text-red-400"}>
                      {gainPct >= 0 ? "+" : ""}{gainPct.toFixed(3)}%
                    </span>
                    <span>TP {tpPct.toFixed(2)}%</span>
                  </div>
                  <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden mt-0.5">
                    <div className={`h-full rounded-full ${gainPct >= 0 ? "bg-green-400" : "bg-red-400"}`}
                         style={{ width: `${gainPct >= 0 ? progress : 0}%` }} />
                  </div>
                </div>
              );
            })()}
          </div>
        );
        const breakerPill = cooldownMin != null && (
          <div className="bg-gray-800/60 rounded-lg p-2">
            <p className="text-gray-500 text-[10px] uppercase">Breaker</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${breakerPaused ? "bg-red-500/20 text-red-400" : "bg-green-500/20 text-green-400"}`}>
                {breakerPaused ? "paused" : "active"}
              </span>
              {breakerPaused && breakerTripDirection && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase bg-gray-700/50 text-gray-400">
                  vs {breakerTripDirection}
                </span>
              )}
              {breakerPaused && breakerResumeSec != null && (
                <span className="text-[10px] font-bold text-gray-300 tabular-nums">
                  next check {String(Math.floor(breakerResumeSec / 60)).padStart(2, "0")}:{String(breakerResumeSec % 60).padStart(2, "0")}
                </span>
              )}
            </div>
          </div>
        );
        const tradingHoursPill = tradingHoursUtc && (() => {
          // Supports both forms: a flat hour list (same every day) or a {pythonWeekday: hours}
          // dict (Monday=0...Sunday=6, matching stoch_bot_core.py's _apply_trading_hours_gate).
          // JS's Date.getUTCDay() is Sunday=0...Saturday=6, so it's converted per lookup.
          const isOpenAt = (d: Date) => {
            const hour = d.getUTCHours();
            if (Array.isArray(tradingHoursUtc)) return tradingHoursUtc.includes(hour);
            const pyWeekday = (d.getUTCDay() + 6) % 7;
            return (tradingHoursUtc[pyWeekday] || []).includes(hour);
          };
          const now = new Date(nowTick);
          const isOpen = isOpenAt(now);
          // Find the next hour where open/closed status flips -- walks real calendar hours
          // forward (up to 8 days) rather than assuming the boundary is always within 24h,
          // since a weekday-dict schedule can stay closed across an entire weekend.
          let boundaryDate = now;
          for (let i = 1; i <= 24 * 8; i++) {
            const t = now.getTime() + i * 3600 * 1000;
            const c = new Date(t);
            const aligned = new Date(Date.UTC(
              c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate(), c.getUTCHours(), 0, 0));
            if (isOpenAt(aligned) !== isOpen) {
              boundaryDate = aligned;
              break;
            }
          }
          const boundaryLabel = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit",
            hour12: true,
          }).format(boundaryDate);
          return (
            <div className="bg-gray-800/60 rounded-lg p-2">
              <p className="text-gray-500 text-[10px] uppercase">Trading Hours</p>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${isOpen ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                  {isOpen ? "open" : "closed"}
                </span>
                <span className="text-[10px] font-bold text-gray-300 tabular-nums"
                      title="New entries only fire in scheduled hours; an existing position still manages to TP/SL/reversal normally">
                  {isOpen ? "closes" : "opens"} {boundaryLabel} ET
                </span>
              </div>
            </div>
          );
        })();
        const selfLockPill = showSelfLock && (
          <div className="bg-gray-800/60 rounded-lg p-2">
            <p className="text-gray-500 text-[10px] uppercase">Self-Lock</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${
                state?.real_trading_locked ? "bg-red-500/20 text-red-400"
                : "bg-green-500/20 text-green-400"
              }`}>
                real {state?.real_trading_locked ? "locked" : "active"}
              </span>
              {state?.real_trading_locked && (
                <span className="text-[10px] font-bold text-gray-300 tabular-nums"
                      title={selfLockUnlockTitle ?? "Paper wins needed to unlock real trading: 2 wins of ANY kind, or a single literal TP on its own. A red non-SL close cancels one win; a literal SL wipes the streak."}>
                  {Math.min(state?.paper_consecutive_tps ?? 0, 2)}/{selfLockUnlockRange ?? "2"} paper wins
                </span>
              )}
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${
                state?.paper_side === "long" ? "bg-green-500/20 text-green-400"
                : state?.paper_side === "short" ? "bg-amber-500/20 text-amber-400"
                : "bg-gray-700/40 text-gray-500"
              }`} title="What the internal paper shadow is currently holding, real or not">
                paper {state?.paper_side ? state.paper_side.toUpperCase() : "FLAT"}
              </span>
              {liveK != null && (
                <span className="text-[10px] text-gray-400 tabular-nums"
                      title="What the paper bot is looking at right now -- live stochastic K value and direction">
                  K {liveK.toFixed(1)} {liveSignal ? liveSignal.toUpperCase() : "—"}
                </span>
              )}
              {liveDispersion != null && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded tabular-nums ${
                  liveDispersion >= 50 ? "bg-red-500/20 text-red-400" : "bg-gray-700/40 text-gray-400"
                }`} title="Intrabar dispersion: stdev of (high+low)/2 over the trailing 5 bars, raw $. Gate blocks new entries at or above $50 -- see BotConfig.intrabar_dispersion_pause_at.">
                  disp ${liveDispersion.toFixed(1)}{liveDispersion >= 50 ? " ⛔" : ""}
                </span>
              )}
            </div>
          </div>
        );

        // Standalone live-signal pill (K value + direction only, no self-lock/paper shadow
        // references) -- for bots without self-lock, where that data isn't otherwise shown.
        // live_k/live_signal are written every tick by compute_joint_adaptive_signal regardless
        // of self_lock_enabled, so this stays live even with self-lock fully off.
        const liveSignalPill = !showSelfLock && liveK != null && (
          <div className="bg-gray-800/60 rounded-lg p-2">
            <p className="text-gray-500 text-[10px] uppercase">Live Signal</p>
            <span className="text-[10px] text-gray-300 tabular-nums"
                  title="Live stochastic K value and direction, this tick">
              K {liveK.toFixed(1)} {liveSignal ? liveSignal.toUpperCase() : "—"}
            </span>
            {liveDispersion != null && (
              <span className={`ml-2 text-[9px] font-bold px-1.5 py-0.5 rounded tabular-nums ${
                liveDispersion >= 50 ? "bg-red-500/20 text-red-400" : "bg-gray-700/40 text-gray-400"
              }`} title="Intrabar dispersion: stdev of (high+low)/2 over the trailing 5 bars, raw $. Gate blocks new entries at or above $50.">
                disp ${liveDispersion.toFixed(1)}{liveDispersion >= 50 ? " ⛔" : ""}
              </span>
            )}
          </div>
        );

        const adaptiveWindow = state?.adaptive_last_window ?? null;
        const adaptiveVolPct = state?.adaptive_last_vol_pct ?? null;
        const adaptivePill = adaptiveWindow != null && (
          <div className="bg-gray-800/60 rounded-lg p-2" title="Live output of the volatility-adaptive window formula -- exactly what the bot is using right now">
            <p className="text-gray-500 text-[10px] uppercase">Adaptive Window</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase bg-blue-500/20 text-blue-400">
                window {adaptiveWindow}
              </span>
              {adaptiveVolPct != null && (
                <span className="text-[10px] text-gray-400 tabular-nums">
                  vol {adaptiveVolPct.toFixed(4)}%
                </span>
              )}
            </div>
          </div>
        );

        const liveConfirmation: number | null = state?.entry_confirmation_last ?? null;
        const fixedSettingsPill = fixedSettings != null && (
          <div className="bg-gray-800/60 rounded-lg p-2" title="Fixed (non-adaptive) settings plus the entry-confirmation book filter">
            <p className="text-gray-500 text-[10px] uppercase">Fixed Settings</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-gray-400 tabular-nums">
                K {fixedSettings.entryLo}/{fixedSettings.entryHi}
              </span>
              <span className="text-[10px] text-gray-400 tabular-nums">
                TP {fixedSettings.tpPct.toFixed(2)}% SL {fixedSettings.slPct.toFixed(2)}%
              </span>
              {fixedSettings.entryConfirmationMaxPct != null && (
                <>
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${
                    liveConfirmation == null ? "bg-gray-700/40 text-gray-500"
                    : liveConfirmation > fixedSettings.entryConfirmationMaxPct ? "bg-red-500/20 text-red-400"
                    : "bg-green-500/20 text-green-400"
                  }`} title="Blocks a new entry (or reversal reopen) when the near-touch book is already this stacked in that direction, for whichever direction the live signal currently reads">
                    {liveConfirmation == null ? "book —"
                     : liveConfirmation > fixedSettings.entryConfirmationMaxPct ? "book blocked" : "book clear"}
                  </span>
                  <span className="text-[10px] text-gray-400 tabular-nums">
                    confirm {liveConfirmation != null ? (liveConfirmation * 100).toFixed(0) : "—"}% / cap {(fixedSettings.entryConfirmationMaxPct * 100).toFixed(0)}%
                  </span>
                </>
              )}
            </div>
          </div>
        );

        const joint = state?.joint_adaptive_last ?? null;
        const jointAdaptivePill = joint != null && (
          <div className="bg-gray-800/60 rounded-lg p-2" title="Live output of the joint adaptive formula -- window, K thresholds, TP, SL, and reversal blanking all move together with volatility">
            <p className="text-gray-500 text-[10px] uppercase">Joint Adaptive</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase bg-blue-500/20 text-blue-400">
                window {joint.window?.toFixed(1)}
              </span>
              <span className="text-[10px] text-gray-400 tabular-nums">
                K {joint.lower_k?.toFixed(0)}/{joint.upper_k?.toFixed(0)}
              </span>
              <span className="text-[10px] text-gray-400 tabular-nums">
                TP {joint.tp_pct?.toFixed(3)}% SL {joint.sl_pct?.toFixed(3)}%
              </span>
              <span className="text-[10px] text-gray-400 tabular-nums">
                blank {joint.blank_seconds?.toFixed(0)}s
              </span>
              {joint.vol_pct != null && (
                <span className="text-[10px] text-gray-500 tabular-nums">
                  vol {joint.vol_pct.toFixed(4)}%
                </span>
              )}
            </div>
          </div>
        );

        // Fallback for the schedule/adaptive grid slot when a bot has neither -- otherwise that
        // cell just renders empty (e.g. Worker 2: no trading_hours_utc, no adaptive window).
        const scheduleFallbackPill = (
          <div className="bg-gray-800/60 rounded-lg p-2">
            <p className="text-gray-500 text-[10px] uppercase">Trading Hours</p>
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase bg-green-500/20 text-green-400">
              24/7, no restriction
            </span>
          </div>
        );

        const paperTestPill = (
          label: string, sideValue: string | null,
          s: { total: number; wins: number; pnlPct: number } | undefined, tooltip: string
        ) => s && (
          <div className="bg-gray-800/60 rounded-lg p-2" title={tooltip}>
            <p className="text-gray-500 text-[10px] uppercase">{label}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${
                sideValue === "long" ? "bg-green-500/20 text-green-400"
                : sideValue === "short" ? "bg-amber-500/20 text-amber-400"
                : "bg-gray-700/40 text-gray-500"
              }`}>
                {sideValue ? sideValue.toUpperCase() : "FLAT"}
              </span>
              <span className={`text-[10px] font-bold tabular-nums ${
                s.pnlPct > 0 ? "text-green-400" : s.pnlPct < 0 ? "text-red-400" : "text-gray-400"
              }`}>
                {s.pnlPct >= 0 ? "+" : ""}{s.pnlPct.toFixed(3)}%
              </span>
              <span className="text-[10px] text-gray-400 tabular-nums">
                {s.total} trades
                {s.total > 0 ? ` · ${(s.wins / s.total * 100).toFixed(0)}% win` : ""}
              </span>
            </div>
          </div>
        );
        const rsiPaperPill = paperTestPill(
          "RSI Paper Test", state?.rsi_paper_side ?? null, rsiPaperStats,
          "Confirmed Stochastic RSI, paper-only shadow -- never touches real money");

        if (combineEquityWinRate) {
          // Fixed 2x2: [Equity+WinRate, Self-Lock] / [Position, Trading Hours]
          return (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {equityWinRatePill}
              {selfLockPill || liveSignalPill || fixedSettingsPill}
              {positionPill}
              {jointAdaptivePill || adaptivePill || tradingHoursPill || scheduleFallbackPill}
              {rsiPaperPill}
            </div>
          );
        }
        return (
          <div className="grid grid-cols-2 gap-2 text-xs">
            {equityPill}
            {winRatePill}
            {positionPill}
            {breakerPill}
            {tradingHoursPill}
            {selfLockPill || liveSignalPill}
            {jointAdaptivePill}
            {adaptivePill}
            {rsiPaperPill}
          </div>
        );
      })()}
      {showLevers && !loading && (
        <div className="bg-gray-800/60 rounded-lg p-2 space-y-2">
          {/* 2026-10-02, direct request: a visible readout of the exact traded-volume figure
              the entry switch itself acts on, and which signal currently governs entries --
              threshold is now live/adjustable (curVolThreshold), not hardcoded. */}
          <p className="text-gray-500 text-[10px] uppercase">Traded volume (10 candles) — switches signal at {curVolThreshold}</p>
          <p className="font-bold text-sm tabular-nums">
            <span className={liveCandleVolume == null ? "text-gray-500"
              : liveCandleVolume >= curVolThreshold ? "text-amber-400" : "text-green-400"}>
              {liveCandleVolume != null ? liveCandleVolume.toFixed(2) + " BTC" : "—"}
            </span>
            <span className="text-[10px] font-normal text-gray-500 ml-1.5">
              {liveCandleVolume == null ? "no reading yet"
                : liveCandleVolume >= curVolThreshold ? "HIGH — flip signal governs entries"
                : "normal — stochastic + color-balance governs entries"}
            </span>
          </p>
          <div className="flex items-end gap-1.5">
            <div className="flex-1">
              <p className="text-gray-500 text-[9px] uppercase">
                Switch at <span className="text-gray-600">now {curVolThreshold} BTC</span>
              </p>
              <input
                value={volThresholdIn}
                onChange={(e) => setVolThresholdIn(e.target.value)}
                placeholder={String(curVolThreshold)}
                inputMode="decimal"
                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
              />
            </div>
            <button
              onClick={handleApplyVolThreshold}
              disabled={savingSignal !== null || loading || !volThresholdIn.trim()}
              className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30"
            >
              {savingSignal === "volThreshold" ? "…" : "Set"}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1.5 pt-1">
            {([["stochastic", "Stochastic", stochasticOn],
               ["zebra", "Zebra band", zebraOn],
               ["flip", "Flip", flipOn]] as const).map(([key, label, on]) => (
              <button
                key={key}
                onClick={() => handleToggleSignal(key, label, !on)}
                disabled={savingSignal !== null || loading}
                className={`text-xs font-bold px-2 py-1.5 rounded disabled:opacity-30 ${
                  on ? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
                     : "bg-gray-700/50 text-gray-500 hover:bg-gray-700"
                }`}
              >
                {label} {savingSignal === key ? "…" : on ? "ON" : "OFF"}
              </button>
            ))}
          </div>
          <p className="text-gray-600 text-[9px] leading-snug">
            Stochastic/Zebra apply below the volume switch; Flip applies at/above it. Zebra OFF
            lets the raw stochastic signal trade without the 65-75 band. Turning a regime OFF
            only blocks new entries there -- never closes a position already open.
          </p>
          {([
            ["entry", "Entry band (K)", entryLoIn, setEntryLoIn, entryHiIn, setEntryHiIn, curEntryLo, curEntryHi],
            ["reversal", "Reversal band (K)", reversalLoIn, setReversalLoIn, reversalHiIn, setReversalHiIn, curReversalLo, curReversalHi],
          ] as const).map(([kind, label, loIn, setLoIn, hiIn, setHiIn, curLo, curHi]) => (
            <div className="pt-1" key={kind}>
              <p className="text-gray-500 text-[9px] uppercase">
                {label} <span className="text-gray-600">now {curLo} / {curHi}</span>
              </p>
              <div className="flex items-end gap-1.5 mt-1">
                <input
                  value={loIn}
                  onChange={(e) => setLoIn(e.target.value)}
                  placeholder={String(curLo)}
                  inputMode="decimal"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
                />
                <span className="text-gray-600 text-xs pb-1">/</span>
                <input
                  value={hiIn}
                  onChange={(e) => setHiIn(e.target.value)}
                  placeholder={String(curHi)}
                  inputMode="decimal"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={() => handleApplyBand(kind)}
                  disabled={savingSignal !== null || loading || (!loIn.trim() && !hiIn.trim())}
                  className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30 whitespace-nowrap"
                >
                  {savingSignal === kind ? "…" : "Set"}
                </button>
              </div>
            </div>
          ))}
          <p className="text-gray-600 text-[9px] leading-snug mt-1">
            Entry and reversal bands are independent -- set one without affecting the other.
            Wider (e.g. 15/85) means fewer, more extreme signals.
          </p>
          <div className="pt-1">
            <p className="text-gray-500 text-[9px] uppercase">
              Window (candles) <span className="text-gray-600">now {curStochWindow}</span>
            </p>
            <div className="flex items-end gap-1.5 mt-1">
              <input
                value={stochWindowIn}
                onChange={(e) => setStochWindowIn(e.target.value)}
                placeholder={String(curStochWindow)}
                inputMode="numeric"
                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleApplyStochWindow}
                disabled={savingSignal !== null || loading || !stochWindowIn.trim()}
                className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30 whitespace-nowrap"
              >
                {savingSignal === "stochWindow" ? "…" : "Set"}
              </button>
            </div>
            <p className="text-gray-600 text-[9px] leading-snug mt-1">
              How many closed candles the stochastic K reads. Smaller = more sensitive, fires
              more often. Applies to both bands above.
            </p>
          </div>
        </div>
      )}
      {showLevers && !loading && (
        <div className="bg-gray-800/60 rounded-lg p-2">
          {/* 2026-10-02, direct request ("this cannot happen") after a real loss traced to a
              single outlier candle distorting the 5-bar stochastic. Pauses new entries (both
              regimes) for the pause window whenever the latest closed candle's own volume is
              this many times its own trailing baseline. */}
          <div className="flex items-baseline justify-between">
            <p className="text-gray-500 text-[10px] uppercase">Volume-jump guard</p>
            <button
              onClick={() => handleToggleJumpGuard(!curJumpGuardEnabled)}
              disabled={savingSignal !== null || loading}
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded disabled:opacity-30 ${
                curJumpGuardEnabled ? "bg-blue-500/20 text-blue-300" : "bg-gray-700/50 text-gray-500"
              }`}
            >
              {savingSignal === "jumpGuardEnabled" ? "…" : curJumpGuardEnabled ? "ON" : "OFF"}
            </button>
          </div>
          <p className="font-bold text-sm tabular-nums">
            <span className={!curJumpGuardEnabled ? "text-gray-500" : jumpPausedActive ? "text-red-400" : "text-green-400"}>
              {!curJumpGuardEnabled ? "OFF" : jumpPausedActive ? "PAUSED" : "ARMED, not paused"}
            </span>
            <span className="text-[10px] font-normal text-gray-500 ml-1.5">
              {!curJumpGuardEnabled ? "switch is off -- never blocks"
                : jumpPausedActive
                ? `new entries blocked -- clears in ${Math.floor(jumpSecondsLeft / 60)}:${String(jumpSecondsLeft % 60).padStart(2, "0")}`
                : "new entries allowed"}
            </span>
          </p>
          {jumpPausedActive && curReleaseMode !== "off" && (
            <p className="text-[10px] text-amber-300 mt-0.5">
              {liveReleasePeak != null
                ? `target: ${curReleaseMode} ≤ ${releasePrefix}${(liveReleasePeak / 2).toFixed(2)}${releaseUnit} (half of peak ${releasePrefix}${liveReleasePeak.toFixed(2)}${releaseUnit}) -- releases early the moment this is reached, or at the timer above, whichever is first`
                : "waiting for a peak reading…"}
            </p>
          )}
          {jumpPausedActive && (
            <button
              onClick={handleClearVolumeJump}
              disabled={savingSignal !== null || loading}
              className="mt-1 text-xs font-bold px-2.5 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-30"
            >
              {savingSignal === "jumpClear" ? "…" : "Clear pause now"}
            </button>
          )}
          <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
            latest reading:{" "}
            <span className={liveJumpRatio == null ? "text-gray-500"
              : liveJumpRatio >= curJumpRatio ? "text-amber-400" : "text-gray-400"}>
              {liveJumpRatio != null ? liveJumpRatio.toFixed(2) + "x" : "—"}
            </span>
            {liveJumpRatio != null && liveJumpRatio >= curJumpRatio && !jumpPausedActive
              ? " (spiking now -- about to arm)" : ""}
          </p>
          <div className="mt-1.5">
            <p className="text-gray-500 text-[9px] uppercase">
              Release arm <span className="text-gray-600">now {curReleaseMode}</span>
            </p>
            <div className="grid grid-cols-4 gap-1 mt-1">
              {(["off", "volume", "wiggle", "rate"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => handleSetReleaseMode(mode)}
                  disabled={savingRelease || loading}
                  className={`text-[10px] font-bold px-1.5 py-1 rounded capitalize disabled:opacity-30 ${
                    curReleaseMode === mode ? "bg-blue-500/30 text-blue-300" : "bg-gray-700/50 text-gray-500 hover:bg-gray-700"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-500 mt-1 leading-snug">
              Pauses still hard-cap at the window below. "off" is the plain fixed timer; pick
              one arm to end the pause early once that reading has halved from its post-spike peak.
            </p>
            <div className="grid grid-cols-3 gap-1 mt-1.5 text-[10px] tabular-nums">
              <div className={curReleaseMode === "volume" ? "text-blue-300" : "text-gray-400"}>
                <p className="text-gray-500 text-[9px] uppercase">Volume</p>
                {liveCandleVolume != null ? liveCandleVolume.toFixed(2) + " BTC" : "—"}
              </div>
              <div className={curReleaseMode === "wiggle" ? "text-blue-300" : "text-gray-400"}>
                <p className="text-gray-500 text-[9px] uppercase">Wiggle</p>
                {liveWiggle != null ? "$" + liveWiggle.toFixed(2) : "—"}
              </div>
              <div className={curReleaseMode === "rate" ? "text-blue-300" : "text-gray-400"}>
                <p className="text-gray-500 text-[9px] uppercase">Rate</p>
                {liveJumpRate != null ? (liveJumpRate >= 0 ? "+" : "") + liveJumpRate.toFixed(2) + "/min" : "—"}
              </div>
            </div>
          </div>
          <div className="flex items-end gap-1.5 mt-1.5">
            <div className="flex-1">
              <p className="text-gray-500 text-[9px] uppercase">
                Trigger ratio <span className="text-gray-600">now {curJumpRatio}x</span>
              </p>
              <input
                value={jumpRatioIn}
                onChange={(e) => setJumpRatioIn(e.target.value)}
                placeholder={String(curJumpRatio)}
                inputMode="decimal"
                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex-1">
              <p className="text-gray-500 text-[9px] uppercase">
                Pause <span className="text-gray-600">now {curJumpPause}s</span>
              </p>
              <input
                value={jumpPauseIn}
                onChange={(e) => setJumpPauseIn(e.target.value)}
                placeholder={String(curJumpPause)}
                inputMode="decimal"
                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
              />
            </div>
            <button
              onClick={handleApplyJumpGuard}
              disabled={savingSignal !== null || loading || (!jumpRatioIn.trim() && !jumpPauseIn.trim())}
              className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30 whitespace-nowrap"
            >
              {savingSignal === "jump" ? "…" : "Set"}
            </button>
          </div>
          <p className="text-gray-600 text-[9px] leading-snug mt-1">
            When the latest closed candle's own volume is this many times its trailing-10
            baseline, new entries (and reversal reopens) pause for the window above. Never
            closes a position already open.
          </p>
        </div>
      )}
      {showLevers && !loading && (
        <div className="bg-gray-800/60 rounded-lg p-2">
          {/* 2026-10-03, direct request after a live "market manipulation" concern -- ratio of
              wiggle (intrabar dispersion) to volume, flipped 2026-10-05. Instant reading, no
              pause timer: blocks new entries only while the ratio stays below the threshold,
              releases the moment it rises back up. */}
          <div className="flex items-baseline justify-between">
            <p className="text-gray-500 text-[10px] uppercase">Wiggle/volume lock</p>
            <button
              onClick={() => handleToggleWiggleLock(!curWiggleLockEnabled)}
              disabled={savingSignal !== null || loading}
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded disabled:opacity-30 ${
                curWiggleLockEnabled ? "bg-blue-500/20 text-blue-300" : "bg-gray-700/50 text-gray-500"
              }`}
            >
              {savingSignal === "wiggleLockEnabled" ? "…" : curWiggleLockEnabled ? "ON" : "OFF"}
            </button>
          </div>
          <p className="font-bold text-sm tabular-nums">
            <span className={!curWiggleLockEnabled ? "text-gray-500" : wiggleLocked ? "text-red-400" : "text-green-400"}>
              {!curWiggleLockEnabled ? "OFF" : wiggleLocked ? "LOCKED" : "not locked"}
            </span>
            <span className="text-[10px] font-normal text-gray-500 ml-1.5">
              {curWiggleLockEnabled ? (wiggleLocked ? "new entries blocked" : "new entries allowed") : "switch is off -- never blocks"}
            </span>
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
            latest reading:{" "}
            <span className={liveWiggleRatio == null ? "text-gray-500"
              : curWiggleLockThreshold != null && liveWiggleRatio > curWiggleLockThreshold ? "text-red-400" : "text-gray-400"}>
              {liveWiggleRatio != null ? liveWiggleRatio.toFixed(2) : "—"}
            </span>
          </p>
          <div className="flex items-end gap-1.5 mt-1.5">
            <div className="flex-1">
              <p className="text-gray-500 text-[9px] uppercase">
                Threshold <span className="text-gray-600">now {curWiggleLockThreshold ?? "off"}</span>
              </p>
              <input
                value={wiggleLockThresholdIn}
                onChange={(e) => setWiggleLockThresholdIn(e.target.value)}
                placeholder={curWiggleLockThreshold != null ? String(curWiggleLockThreshold) : "e.g. 0.30"}
                inputMode="decimal"
                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
              />
            </div>
            <button
              onClick={handleSetWiggleLockThreshold}
              disabled={savingSignal !== null || loading || !wiggleLockThresholdIn.trim()}
              className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30 whitespace-nowrap"
            >
              {savingSignal === "wiggleLock" ? "…" : "Set"}
            </button>
          </div>
          <p className="text-gray-600 text-[9px] leading-snug mt-1">
            Wiggle ÷ volume. Instant reading, no pause timer -- blocks new entries only while
            below the threshold, releases the moment it rises back up.
          </p>
        </div>
      )}
      {showLevers && !loading && (
        <div className="bg-gray-800/60 rounded-lg p-2">
          {/* 2026-10-09, direct request after a real-trade audit: "first you dont go in if your
              wiggle/volume is 3 then you come out the moment your wiggle volume goes up by 10%".
              Separate panel from the entry lock above -- this watches the ratio's own RISE
              relative to THIS position's entry reading, exit-only, never blocks an entry. */}
          <div className="flex items-baseline justify-between">
            <p className="text-gray-500 text-[10px] uppercase">Wiggle/Vol rise exit</p>
            <button
              onClick={() => handleToggleWiggleVolRise(!curWiggleVolRiseEnabled)}
              disabled={savingSignal !== null || loading}
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded disabled:opacity-30 ${
                curWiggleVolRiseEnabled ? "bg-blue-500/20 text-blue-300" : "bg-gray-700/50 text-gray-500"
              }`}
            >
              {savingSignal === "wiggleVolRiseExitEnabled" ? "…" : curWiggleVolRiseEnabled ? "ON" : "OFF"}
            </button>
          </div>
          <p className="font-bold text-sm tabular-nums">
            <span className={!curWiggleVolRiseEnabled || curWiggleVolRisePct == null ? "text-gray-500" : "text-blue-300"}>
              {curWiggleVolRisePct != null ? `+${curWiggleVolRisePct}%` : "off"}
            </span>
            <span className="text-[10px] font-normal text-gray-500 ml-1.5">
              {!curWiggleVolRiseEnabled ? "switch is off -- never fires"
                : curWiggleVolRisePct == null ? "no percentage configured"
                : "rise from entry's own reading closes the position"}
            </span>
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
            latest reading: <span className="text-gray-400">{liveWiggleRatio != null ? liveWiggleRatio.toFixed(2) : "—"}</span>
          </p>
          <div className="flex items-end gap-1.5 mt-1.5">
            <div className="flex-1">
              <p className="text-gray-500 text-[9px] uppercase">
                Rise % <span className="text-gray-600">now {curWiggleVolRisePct ?? "off"}</span>
              </p>
              <input
                value={wiggleVolRisePctIn}
                onChange={(e) => setWiggleVolRisePctIn(e.target.value)}
                placeholder={curWiggleVolRisePct != null ? String(curWiggleVolRisePct) : "e.g. 10"}
                inputMode="decimal"
                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
              />
            </div>
            <button
              onClick={handleSetWiggleVolRisePct}
              disabled={savingSignal !== null || loading || !wiggleVolRisePctIn.trim()}
              className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30 whitespace-nowrap"
            >
              {savingSignal === "wiggleVolRiseExit" ? "…" : "Set"}
            </button>
          </div>
          <p className="text-gray-600 text-[9px] leading-snug mt-1">
            Checked on a 16-trade real window: all 5 real SL losses showed wig/vol rising from
            entry to close (17%-369%); 9 of 11 real wins showed it falling. Closes instantly,
            no dwell -- the % itself is the filter. Never blocks an entry, only an exit.
          </p>
        </div>
      )}
      {showLevers && !loading && (
        <div className="bg-gray-800/60 rounded-lg p-2">
          {/* 2026-10-09, direct request after a real-data study: "a little panel that can
              block an entry when they are aligned... switch from 5 minutes to 10 minutes to
              1 hour." Blocks a fresh/reopen entry only, never an exit. */}
          <p className="text-gray-500 text-[10px] uppercase">Higher-timeframe alignment block</p>
          <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
            latest {curHtfTimeframe !== "off" ? curHtfTimeframe : ""} K:{" "}
            <span className="text-gray-400">{liveHtfK != null ? liveHtfK.toFixed(1) : "—"}</span>
          </p>
          <div className="grid grid-cols-4 gap-1 mt-1.5">
            {(["off", "5m", "10m", "1h"] as const).map((tf) => (
              <button
                key={tf}
                onClick={() => handleSetHtfTimeframe(tf)}
                disabled={savingHtf || loading}
                className={`text-[11px] font-bold px-1.5 py-1.5 rounded capitalize disabled:opacity-30 ${
                  curHtfTimeframe === tf ? "bg-blue-500/30 text-blue-300" : "bg-gray-700/50 text-gray-500 hover:bg-gray-700"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
          <p className="text-gray-600 text-[9px] leading-snug mt-1">
            Blocks a fresh entry when the chosen timeframe's own stochastic AGREES with the
            1-min signal direction. Backed by a real study on 449 real trades: aligned entries
            ran 56-60% win / net LOSS; not-aligned ran 70-81% win / net WIN -- strongest at
            5-minute. Backwards from intuition: agreement usually means a real trend is running,
            which this mean-reversion bot loses against. "off" (default) never blocks.
          </p>
        </div>
      )}
      {showLevers && !loading && (
        <div className="bg-gray-800/60 rounded-lg p-2">
          {/* 2026-10-08, direct request after backtesting it against real trades: "if 20% we
              dont take the trade and wait for the next signal." Max |volume_rate_pct| over the
              last 5 closed candles before entry -- skips just the one signal, no pause timer,
              clears the instant the reading drops back down. */}
          <div className="flex items-baseline justify-between">
            <p className="text-gray-500 text-[10px] uppercase">Volume-rate guard</p>
            <button
              onClick={() => handleToggleRateGuard(!curRateGuardEnabled)}
              disabled={savingSignal !== null || loading}
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded disabled:opacity-30 ${
                curRateGuardEnabled ? "bg-blue-500/20 text-blue-300" : "bg-gray-700/50 text-gray-500"
              }`}
            >
              {savingSignal === "rateGuardEnabled" ? "…" : curRateGuardEnabled ? "ON" : "OFF"}
            </button>
          </div>
          <p className="font-bold text-sm tabular-nums">
            <span className={!curRateGuardEnabled ? "text-gray-500" : rateGuardActive ? "text-red-400" : "text-green-400"}>
              {!curRateGuardEnabled ? "OFF" : rateGuardActive ? "BLOCKING" : "not blocking"}
            </span>
            <span className="text-[10px] font-normal text-gray-500 ml-1.5">
              {curRateGuardEnabled ? (rateGuardActive ? "this signal skipped" : "entries allowed") : "switch is off -- never blocks"}
            </span>
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
            latest reading (max/5 candles):{" "}
            <span className={liveVolumeRatePct == null ? "text-gray-500"
              : curRateGuardThreshold != null && liveVolumeRatePct > curRateGuardThreshold ? "text-red-400" : "text-gray-400"}>
              {liveVolumeRatePct != null ? `${liveVolumeRatePct.toFixed(1)}%` : "—"}
            </span>
          </p>
          <div className="flex items-end gap-1.5 mt-1.5">
            <div className="flex-1">
              <p className="text-gray-500 text-[9px] uppercase">
                Threshold % <span className="text-gray-600">now {curRateGuardThreshold ?? "off"}</span>
              </p>
              <input
                value={rateGuardThresholdIn}
                onChange={(e) => setRateGuardThresholdIn(e.target.value)}
                placeholder={curRateGuardThreshold != null ? String(curRateGuardThreshold) : "e.g. 20"}
                inputMode="decimal"
                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
              />
            </div>
            <button
              onClick={handleSetRateGuardThreshold}
              disabled={savingSignal !== null || loading || !rateGuardThresholdIn.trim()}
              className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30 whitespace-nowrap"
            >
              {savingSignal === "rateGuard" ? "…" : "Set"}
            </button>
          </div>
          <p className="text-gray-600 text-[9px] leading-snug mt-1">
            How much volume's own 10-candle average changed vs the prior candle, as a %, worst
            reading over the last 5 closed candles. Skips just this one entry signal when above
            the threshold -- never blocks an exit, never pauses the bot.
          </p>
        </div>
      )}
      {showLevers && !loading && (
        <div className="bg-gray-800/60 rounded-lg p-2">
          {/* 2026-10-15, direct request: a research candidate from an external backtest audit
              on real tick execution -- only let a fresh entry through while wiggle/vol sits
              inside this band. Off by default; built so this exact strategy can be compared
              side by side with different settings on Worker 1 vs Worker 4. */}
          <div className="flex items-baseline justify-between">
            <p className="text-gray-500 text-[10px] uppercase">Entry wiggle/vol ratio gate</p>
            <button
              onClick={() => handleToggleEntryWiggleRatio(!curEntryWiggleRatioEnabled)}
              disabled={savingSignal !== null || loading}
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded disabled:opacity-30 ${
                curEntryWiggleRatioEnabled ? "bg-blue-500/20 text-blue-300" : "bg-gray-700/50 text-gray-500"
              }`}
            >
              {savingSignal === "entryWiggleRatioEnabled" ? "…" : curEntryWiggleRatioEnabled ? "ON" : "OFF"}
            </button>
          </div>
          <p className="font-bold text-sm tabular-nums">
            <span className={!curEntryWiggleRatioEnabled ? "text-gray-500" : entryWiggleRatioActive ? "text-red-400" : "text-green-400"}>
              {!curEntryWiggleRatioEnabled ? "OFF" : entryWiggleRatioActive ? "BLOCKING" : "not blocking"}
            </span>
            <span className="text-[10px] font-normal text-gray-500 ml-1.5">
              {curEntryWiggleRatioEnabled ? (entryWiggleRatioActive ? "outside band -- entries skipped" : "inside band -- entries allowed") : "switch is off -- never blocks"}
            </span>
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
            latest reading (same as the volume/wiggle lock above):{" "}
            <span className={liveWiggleRatio == null ? "text-gray-500"
              : (curEntryWiggleRatioMin != null && liveWiggleRatio < curEntryWiggleRatioMin)
                || (curEntryWiggleRatioMax != null && liveWiggleRatio > curEntryWiggleRatioMax)
                ? "text-red-400" : "text-gray-400"}>
              {liveWiggleRatio != null ? liveWiggleRatio.toFixed(2) : "—"}
            </span>
          </p>
          <div className="flex items-end gap-1.5 mt-1.5">
            <div className="flex-1">
              <p className="text-gray-500 text-[9px] uppercase">
                Band <span className="text-gray-600">now {curEntryWiggleRatioMin ?? "off"} / {curEntryWiggleRatioMax ?? "off"}</span>
              </p>
              <div className="flex items-center gap-1.5">
                <input
                  value={entryWiggleRatioMinIn}
                  onChange={(e) => setEntryWiggleRatioMinIn(e.target.value)}
                  placeholder={curEntryWiggleRatioMin != null ? String(curEntryWiggleRatioMin) : "e.g. 5"}
                  inputMode="decimal"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
                />
                <span className="text-gray-600 text-xs">/</span>
                <input
                  value={entryWiggleRatioMaxIn}
                  onChange={(e) => setEntryWiggleRatioMaxIn(e.target.value)}
                  placeholder={curEntryWiggleRatioMax != null ? String(curEntryWiggleRatioMax) : "e.g. 12"}
                  inputMode="decimal"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
            <button
              onClick={handleSetEntryWiggleRatioBand}
              disabled={savingSignal !== null || loading || (!entryWiggleRatioMinIn.trim() && !entryWiggleRatioMaxIn.trim())}
              className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30 whitespace-nowrap"
            >
              {savingSignal === "entryWiggleRatioBand" ? "…" : "Set"}
            </button>
          </div>
          <p className="text-gray-600 text-[9px] leading-snug mt-1">
            Only lets a fresh entry through while wiggle/vol sits inside this band -- missing
            data blocks too (fails closed, unlike the volume-rate guard above). Research
            candidate: 5 / 12 is the recommended starting band. Never blocks an exit.
          </p>
        </div>
      )}
      {showLevers && liveCandleVolume != null && liveCandleVolume >= curVolThreshold && !loading && (() => {
        const dots = liveStreakLen != null ? "●".repeat(Math.min(liveStreakLen, 5)) + (liveStreakLen > 5 ? "+" : "") : "—";
        const dirLabel = liveStreakDir === "long" ? "GREEN" : liveStreakDir === "short" ? "RED" : "—";
        return (
          <div className="bg-gray-800/60 rounded-lg p-2">
            {/* 2026-10-02, direct request: "a candle counter so i can see we are doing it
                correctly... 1 2 3 waiting for flip" -- mirrors compute_flip_signal's own
                streak count exactly (compute_live_flip_streak), only shown while the flip
                signal actually governs entries (volume >= 2). */}
            <p className="text-gray-500 text-[10px] uppercase">Flip streak -- {dirLabel} candles in a row (needs 3+)</p>
            <p className="font-bold text-sm tabular-nums">
              <span className={liveStreakLen == null ? "text-gray-500"
                : liveStreakLen >= 3 ? "text-green-400" : "text-amber-400"}>
                {dots}
              </span>
              <span className="text-[10px] font-normal text-gray-500 ml-1.5">
                {liveStreakLen == null ? "no reading yet"
                  : liveStreakLen < 3 ? `${liveStreakLen}/3 — waiting, needs one more ${dirLabel.toLowerCase()} candle`
                  : `ready — next opposite-color candle enters ${liveStreakDir?.toUpperCase()}`}
              </span>
            </p>
          </div>
        );
      })()}
      {showLevers && !loading && (
        <div className="bg-gray-800/60 rounded-lg p-2">
          <div className="flex items-center justify-between">
            <p className="text-gray-500 text-[9px] uppercase">
              Require fresh signal <span className={requireFreshSignalOn ? "text-green-400" : "text-gray-600"}>{requireFreshSignalOn ? "ON" : "OFF"}</span>
            </p>
            <button onClick={handleToggleRequireFreshSignal} disabled={savingRequireFreshSignal || loading}
              className={`text-[11px] font-bold px-2.5 py-1 rounded disabled:opacity-30 ${
                requireFreshSignalOn ? "bg-green-500/20 text-green-400" : "bg-gray-700/50 text-gray-500"}`}>
              {savingRequireFreshSignal ? "…" : requireFreshSignalOn ? "Turn OFF" : "Turn ON"}
            </button>
          </div>
          <p className="text-gray-600 text-[9px] leading-snug mt-1">
            ON (the usual setting): only enters on the exact candle a signal first appears --
            skips a signal that's already been sitting active for 2+ candles. OFF: enters on
            any matching signal, fresh or not. Was compiled-only before; now live-tunable here.
          </p>
        </div>
      )}
      {showLevers && !loading && (
        <div className="bg-gray-800/60 rounded-lg p-2">
          {/* 2026-10-17, direct request: only enter in a window of hours after a confirmed
              real volume*wiggle "product" peak. See BotConfig.peak_window_enabled's docstring
              for the causal (no future-peeking) peak-detection algorithm these numbers drive.
              2026-10-17, relocated out of the trail/tp box: "that panel is for trail vs tp",
              this is an entry-side gate and belongs with the other entry gates above. */}
          <div className="flex items-baseline justify-between">
            <p className="text-gray-500 text-[10px] uppercase">Peak window</p>
            <button
              onClick={handleTogglePeakWindow}
              disabled={savingPeakWindow || loading}
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded disabled:opacity-30 ${
                curPeakWindowEnabled ? "bg-blue-500/20 text-blue-300" : "bg-gray-700/50 text-gray-500"
              }`}
            >
              {savingPeakWindow ? "…" : curPeakWindowEnabled ? "ON" : "OFF"}
            </button>
          </div>
          <p className="font-bold text-sm tabular-nums">
            <span className={!curPeakWindowEnabled ? "text-gray-500" : livePeakActive ? "text-red-400" : "text-green-400"}>
              {!curPeakWindowEnabled ? "OFF" : livePeakActive ? "BLOCKING" : "allowed"}
            </span>
            <span className="text-[10px] font-normal text-gray-500 ml-1.5">
              {curPeakWindowEnabled
                ? (livePeakHoursSince != null ? `${livePeakHoursSince.toFixed(2)}h since the last peak` : "no peak confirmed yet")
                : "switch is off -- never blocks"}
            </span>
          </p>
          <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
            latest product reading: <span className="text-gray-400">{livePeakProduct != null ? Math.round(livePeakProduct) : "—"}</span>
          </p>
          <p className="text-gray-500 text-[9px] uppercase mt-2">
            Peak definition <span className="text-gray-600">now {curPeakFloor ?? "off"} floor / {curPeakConfirm ?? "—"}min confirm / {curPeakSeparation ?? "—"}h apart</span>
          </p>
          <div className="flex items-end gap-1.5 mt-1">
            <input value={peakFloorIn} onChange={(e) => setPeakFloorIn(e.target.value)}
              placeholder={curPeakFloor != null ? String(curPeakFloor) : "floor e.g. 1000"}
              inputMode="decimal"
              className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500" />
            <input value={peakConfirmIn} onChange={(e) => setPeakConfirmIn(e.target.value)}
              placeholder={curPeakConfirm != null ? String(curPeakConfirm) : "confirm min e.g. 45"}
              inputMode="decimal"
              className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500" />
            <input value={peakSeparationIn} onChange={(e) => setPeakSeparationIn(e.target.value)}
              placeholder={curPeakSeparation != null ? String(curPeakSeparation) : "sep hrs e.g. 6"}
              inputMode="decimal"
              className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500" />
            <button onClick={handleSetPeakDefinition}
              disabled={savingPeakWindow || loading || (!peakFloorIn.trim() && !peakConfirmIn.trim() && !peakSeparationIn.trim())}
              className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30 whitespace-nowrap">
              {savingPeakWindow ? "…" : "Set"}
            </button>
          </div>
          <p className="text-gray-500 text-[9px] uppercase mt-2">
            Trading window <span className="text-gray-600">now {curPeakStart ?? "off"}-{curPeakEnd ?? "off"}h after the peak</span>
          </p>
          <div className="flex items-end gap-1.5 mt-1">
            <input value={peakStartIn} onChange={(e) => setPeakStartIn(e.target.value)}
              placeholder={curPeakStart != null ? String(curPeakStart) : "start hrs e.g. 2"}
              inputMode="decimal"
              className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500" />
            <span className="text-gray-600 text-xs pb-1">/</span>
            <input value={peakEndIn} onChange={(e) => setPeakEndIn(e.target.value)}
              placeholder={curPeakEnd != null ? String(curPeakEnd) : "end hrs e.g. 6"}
              inputMode="decimal"
              className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500" />
            <button onClick={handleSetPeakWindowHours}
              disabled={savingPeakWindow || loading || (!peakStartIn.trim() && !peakEndIn.trim())}
              className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30 whitespace-nowrap">
              {savingPeakWindow ? "…" : "Set"}
            </button>
          </div>
          <p className="text-gray-600 text-[9px] leading-snug mt-2">
            A "peak" confirms when the product (volume&times;wiggle) crosses the floor and
            holds for the confirm minutes without being beaten. Entries are only allowed
            between start-end hours after that peak's own timestamp -- before the first peak
            ever confirms, this blocks entirely (fails closed). Research default: 1000 floor /
            45min confirm / 6h apart / 2-6h window. Never blocks an exit.
          </p>
        </div>
      )}
      {showLevers && !loading && (
        <div className="bg-gray-800/60 rounded-lg p-2 space-y-2">
          <div>
            <p className="text-gray-500 text-[9px] uppercase">
              Exit mode <span className="text-gray-600">now {curExitMode}</span>
            </p>
            <div className="grid grid-cols-2 gap-1 mt-1">
              {(["trail", "tp"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => handleSetExitMode(mode)}
                  disabled={savingExitMode || loading}
                  className={`text-[11px] font-bold px-1.5 py-1.5 rounded capitalize disabled:opacity-30 ${
                    curExitMode === mode ? "bg-blue-500/30 text-blue-300" : "bg-gray-700/50 text-gray-500 hover:bg-gray-700"
                  }`}
                >
                  {mode === "tp" ? "Fixed TP" : "Trail"}
                </button>
              ))}
            </div>
            <p className="text-gray-600 text-[9px] leading-snug mt-1">
              Trail: the profit-lock trigger/trail below governs winners (current behavior).
              Fixed TP: the trail is suppressed -- only SL and the TP level below close a
              winner. SL always stays active either way.
            </p>
          </div>
          <div className="bg-gray-800/60 rounded-lg p-2">
            <div className="flex items-center justify-between">
              <p className="text-gray-500 text-[9px] uppercase">
                Escalated SL <span className={escalatedSlOn ? "text-green-400" : "text-gray-600"}>{escalatedSlOn ? "ON" : "OFF"}</span>
              </p>
              <button onClick={handleToggleEscalatedSl} disabled={savingEscalatedSl || loading}
                className={`text-[11px] font-bold px-2.5 py-1 rounded disabled:opacity-30 ${
                  escalatedSlOn ? "bg-green-500/20 text-green-400" : "bg-gray-700/50 text-gray-500"}`}>
                {savingEscalatedSl ? "…" : escalatedSlOn ? "Turn OFF" : "Turn ON"}
              </button>
            </div>
            <p className="text-gray-600 text-[9px] leading-snug mt-1">
              Replaces the plain SL below with 3 tiers, built from real trade data: -0.05% within
              2 min AND volume under 3 BTC/min exits early; -0.10% AND volume under 3 also exits;
              -0.12% is the hard cap regardless. The SL box below is ignored while this is on.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {([["SL", slIn, setSlIn, curSl, "%"],
               ["Trigger", trigIn, setTrigIn, curTrig, "%"],
               ["Trail", trailIn, setTrailIn, curTrail, "%"],
               ["TP", tpIn, setTpIn, curTp, "%"],
               ["Trail Dwell", dwellIn, setDwellIn, curDwell, "s"],
               ["SL Dwell", slDwellIn, setSlDwellIn, curSlDwell, "s"]] as const).map(([label, val, set, cur, unit]) => (
              <div key={label}>
                <p className="text-gray-500 text-[9px] uppercase">{label}</p>
                <p className="text-gray-600 text-[9px]">now {cur != null ? cur + unit : "—"}</p>
                <input
                  value={val}
                  onChange={(e) => set(e.target.value)}
                  placeholder={cur != null ? String(cur) : ""}
                  inputMode="decimal"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-white tabular-nums focus:outline-none focus:border-blue-500"
                />
              </div>
            ))}
          </div>
          <p className="text-gray-600 text-[9px] leading-snug">
            SL Dwell: the plain SL above must stay continuously past its level for this many
            seconds before actually closing -- backtested against real trades (30s was best).
            Never applies to the escalated SL tiers above, which always stay instant.
          </p>
          <button
            onClick={handleApplySettings}
            disabled={savingSettings || loading || (!slIn.trim() && !trigIn.trim() && !trailIn.trim() && !tpIn.trim() && !dwellIn.trim() && !slDwellIn.trim())}
            className="w-full text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30"
          >
            {savingSettings ? "Applying…" : "Apply"}
          </button>
          <p className="text-gray-600 text-[9px] leading-snug">
            Leave a box blank to keep it. Takes effect immediately, including on an open position
            (the exchange-side stop is re-placed at the new SL). TP stays 0.10%. Trail 0 = exit on
            the first tick down after the trigger. Dwell: in Trail mode, the trail's pullback
            must hold for this many seconds before it actually closes -- 0 = instant, same as
            before. Never applies to TP (reaching it should close right away) or SL.
          </p>
        </div>
      )}
      {showLevers && !loading && (
        <div className="bg-gray-900/80 border border-gray-700 rounded-lg p-2 space-y-1">
          {/* 2026-10-09, direct request: "we have a bunch of rules that we dont know we need
              to enumerate them" -- read-only, every switch/filter on this bot in one place, so
              nothing stays quietly on or off without anyone remembering. Every control here is
              changed elsewhere on this panel; this box is purely a status checklist. */}
          <p className="text-gray-400 text-[10px] uppercase font-bold">Status overview -- everything on/off</p>
          {[
            ["Exit mode", curExitMode],
            ["Require fresh signal", requireFreshSignalOn ? "ON" : "off"],
            ["Escalated SL", escalatedSlOn ? "ON" : "off"],
            ["Volume jump guard", curJumpGuardEnabled ? `ON (release: ${curReleaseMode})` : "off"],
            ["Wiggle/volume lock", curWiggleLockEnabled ? `ON (< ${curWiggleLockThreshold ?? "—"})` : "off"],
            ["Wiggle/vol rise exit", curWiggleVolRiseEnabled && curWiggleVolRisePct != null ? `ON (+${curWiggleVolRisePct}%)` : "off"],
            ["Volume-rate guard", curRateGuardEnabled ? `ON (> ${curRateGuardThreshold ?? "—"}%)` : "off"],
            ["Entry wiggle/vol ratio gate", curEntryWiggleRatioEnabled ? `ON (${curEntryWiggleRatioMin ?? "—"} / ${curEntryWiggleRatioMax ?? "—"})` : "off"],
            ["Peak window", curPeakWindowEnabled ? `ON (${curPeakStart ?? "—"}-${curPeakEnd ?? "—"}h)` : "off"],
            ["Stochastic signal", stochasticOn ? "ON" : "off"],
            ["Zebra gate", zebraOn ? "ON" : "off"],
            ["Flip regime", flipOn ? "ON" : "off"],
            ["Trail Dwell", curDwell > 0 ? `ON (${curDwell}s)` : "off"],
            ["SL Dwell", curSlDwell > 0 ? `ON (${curSlDwell}s)` : "off"],
            ["HTF alignment block", curHtfTimeframe !== "off" ? `ON (${curHtfTimeframe})` : "off"],
            ["Self-lock / hour ban", "off (compiled, not live-controllable)"],
          ].map(([label, val]) => (
            <div key={label} className="flex items-center justify-between text-[10px]">
              <span className="text-gray-500">{label}</span>
              <span className={String(val).startsWith("ON") ? "text-blue-300 font-semibold" : "text-gray-600"}>{val}</span>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-1">
        <p className="text-gray-500 text-[10px] uppercase">Recent trades</p>
        <div className="max-h-72 overflow-y-auto space-y-1 pr-0.5">
          {closedTrades.slice(0, 20).map((t) => {
            const notional = (t.avg_entry_price ?? 0) * (t.base_amount_btc ?? 0);
            const pnlPct = notional > 0 ? (t.pnl_usd / notional * 100) : null;
            const timeLabel = t.closed_at
              ? new Intl.DateTimeFormat("en-US", {
                  timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true,
                }).format(new Date(t.closed_at))
              : null;
            return (
              <div key={t.id} className="flex items-center justify-between text-[11px] bg-gray-800/50 rounded px-1.5 py-1">
                {timeLabel && <span className="text-gray-600 tabular-nums">{timeLabel}</span>}
                <span className={t.side === "long" ? "text-green-400" : "text-amber-400"}>{t.side}·{shortReason(t.reason)}</span>
                <span className="text-gray-500">${t.avg_entry_price?.toFixed(0)}→${t.exit_price?.toFixed(0)}</span>
                <span className={t.pnl_usd >= 0 ? "text-green-400" : "text-red-400"}>
                  {t.pnl_usd >= 0 ? "+" : ""}${t.pnl_usd?.toFixed(3)}{pnlPct != null ? ` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)` : ""}
                </span>
              </div>
            );
          })}
          {closedTrades.length === 0 && <p className="text-gray-600 text-[11px]">No closed trades yet.</p>}
        </div>
      </div>
    </div>
  );
}

function LighterStochDcaBtcPanel({
  state, trades, runs, currentPrice, loading,
}: {
  state: any; trades: any[]; runs: any[]; currentPrice: number | null; loading: boolean;
}) {
  const side = state?.side ?? null;
  const legs: any[] = state?.legs ?? [];
  const dcaLevel = state?.dca_level ?? 0;
  const firstEntryPrice = state?.first_entry_price ?? null;
  const firstEntryTime = state?.first_entry_time ?? null;
  const seedUsd = state?.seed_usd ?? 20;
  const realizedPnl = state?.realized_pnl_usd ?? 0;
  const equity = seedUsd + realizedPnl;

  const totalNotional = legs.reduce((s, l) => s + l.usd_size, 0);
  const totalQty = legs.reduce((s, l) => s + l.usd_size / l.price, 0);
  const avgEntry = totalQty > 0 ? totalNotional / totalQty : null;

  const unrealizedUsd = side && avgEntry && totalQty && currentPrice
    ? (side === "long" ? (currentPrice - avgEntry) : (avgEntry - currentPrice)) * totalQty
    : null;

  const tpPrice = avgEntry != null ? (side === "long" ? avgEntry * 1.001 : avgEntry * 0.999) : null;
  const slPrice = firstEntryPrice != null ? (side === "long" ? firstEntryPrice * 0.995 : firstEntryPrice * 1.005) : null;

  const closedTrades = trades.filter((t) => t.pnl_usd != null);
  const wins = closedTrades.filter((t) => t.pnl_usd > 0).length;
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length * 100).toFixed(1) : "—";

  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const lastRunAge = runs?.[0]?.ran_at ? nowTick - new Date(runs[0].ran_at).getTime() : null;
  const workerAlive = lastRunAge != null && lastRunAge < 90_000;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <h2 className="text-white font-bold text-lg">Lighter BTC Stochastic5 + DCA (Worker 3)</h2>
          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">REAL MONEY</span>
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${workerAlive ? "bg-green-500/20 text-green-400" : "bg-gray-700/40 text-gray-500"}`}>
            {workerAlive ? "worker alive" : "worker offline"}
          </span>
        </div>
        <p className="text-gray-500 text-xs">%K(5) raw stochastic, no smoothing · fresh signal only (no memory in neutral zone) · no DCA, full equity on entry · TP 0.10% off entry · SL 0.50% off entry (fixed) · checks live bid/ask every 1s · no time limit · $20 seed</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="Equity"
            value={
              <>
                ${equity.toFixed(4)}{" "}
                <span className="text-base font-bold">
                  ({realizedPnl >= 0 ? "+" : ""}{(realizedPnl / seedUsd * 100).toFixed(2)}%)
                </span>
              </>
            }
            sub={`${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(4)} realized`}
            color={realizedPnl >= 0 ? "text-green-400" : "text-red-400"}
          />
          <Stat
            label="Win Rate"
            value={`${winRate}%`}
            sub={`${closedTrades.length} trades (${wins}W/${closedTrades.length - wins}L)`}
            color="text-blue-400"
          />
          <Stat
            label="Position"
            value={side ? side.toUpperCase() : "FLAT"}
            sub={avgEntry ? `avg $${avgEntry.toFixed(1)} · $${totalNotional.toFixed(2)} notional` : "no open position"}
            color={side === "long" ? "text-green-400" : side === "short" ? "text-red-400" : "text-gray-400"}
          />
          <Stat
            label="Unrealized"
            value={unrealizedUsd != null ? `${unrealizedUsd >= 0 ? "+" : ""}$${unrealizedUsd.toFixed(4)} (${unrealizedUsd >= 0 ? "+" : ""}${(unrealizedUsd / totalNotional * 100).toFixed(2)}%)` : "—"}
            sub={currentPrice ? `mark $${currentPrice.toFixed(1)}` : "—"}
            color={unrealizedUsd != null ? (unrealizedUsd >= 0 ? "text-green-400" : "text-red-400") : "text-gray-400"}
          />
        </div>
      )}

      {side && (
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-gray-800/50 rounded-lg px-3 py-2">
            <div className="text-gray-500 text-xs uppercase tracking-wide">TP</div>
            <div className="text-green-400 text-xl font-bold">${tpPrice?.toFixed(1)}</div>
          </div>
          <div className="bg-gray-800/50 rounded-lg px-3 py-2">
            <div className="text-gray-500 text-xs uppercase tracking-wide">SL (fixed)</div>
            <div className="text-red-400 text-xl font-bold">${slPrice?.toFixed(1)}</div>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-gray-400 text-xs font-semibold">Recent trades</p>
        <div className="max-h-48 overflow-y-auto space-y-1">
          {closedTrades.slice(0, 20).map((t) => {
            const notional = (t.avg_entry_price ?? 0) * (t.base_amount_btc ?? 0);
            const pnlPct = notional > 0 ? (t.pnl_usd / notional * 100) : null;
            return (
              <div key={t.id} className="flex items-center justify-between text-xs bg-gray-800/50 rounded px-2 py-1">
                <span className={t.side === "long" ? "text-green-400" : "text-red-400"}>{t.side} · {shortReason(t.reason)}</span>
                <span className="text-gray-400">${t.avg_entry_price?.toFixed(1)} → ${t.exit_price?.toFixed(1)}</span>
                <span className={t.pnl_usd >= 0 ? "text-green-400" : "text-red-400"}>
                  {t.pnl_usd >= 0 ? "+" : ""}${t.pnl_usd?.toFixed(4)}{pnlPct != null ? ` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)` : ""}
                </span>
              </div>
            );
          })}
          {closedTrades.length === 0 && <p className="text-gray-600 text-xs">No closed trades yet.</p>}
        </div>
      </div>
    </div>
  );
}

// ── Master schedule panel ─────────────────────────────────────────────────
// 2026-10-04, direct request: "a third panel that can control both... by hour... if this
// volume do this, if this wiggle and volume do this." One shared row (bot_schedule_rules)
// drives StochBot._apply_schedule_rules on Worker 1 and both hedge legs -- see that method's
// docstring in server/stoch_bot_core.py for the full read-side contract (first fully-matching
// rule wins, no match is a no-op, writes land in the exact same override_* columns the manual
// panels already use). This panel is pure read/write of that shared row plus the two existing
// toggle endpoints -- no new trading logic lives here.
const EMPTY_RULE = {
  hour_start: null, hour_end: null,
  er_min: null, er_max: null, volume_min: null, volume_max: null,
  wiggle_min: null, wiggle_max: null, rate_min: null, rate_max: null,
  vol_wiggle_ratio_min: null, vol_wiggle_ratio_max: null,
  vol_wiggle_product_min: null, vol_wiggle_product_max: null,
  product_rate_min: null, product_rate_max: null,
  zebra_min: null, zebra_max: null,
  color_balance_min: null, color_balance_max: null,
  // Per-bot ON/OFF switch, independent of that bot having a settings object on the same rule --
  // direct request: "maybe with this rule I want 1 on and the other off... I need a little
  // switch". Default true (both run) -- see normalizeRuleForSave / StochBot._apply_schedule_rules.
  worker1_enabled: true, hedge_enabled: true,
  // worker4 (2026-10-10, same BotConfig shape as Worker 1, own rule slot per direct request:
  // "wire the automation panel to worker 4... worker 1 on and off, worker 2 on and off, worker
  // 4 on and off"). Default true, same as the other two.
  worker4_enabled: true,
  worker1: { sl_pct: null, trigger_pct: null, trail_pct: null, tp_pct: null, dwell_seconds: null,
             sl_dwell_seconds: null,
             band_lo: null, band_hi: null, reversal_lo: null, reversal_hi: null, window: null,
             // Tri-state (2026-10-06, direct request: "the automation panel needs this option
             // too") -- null = leave whatever's currently live alone, true/false = set it. Not
             // in BOT_NUMERIC_FIELDS since it's a boolean, not a percentage/count.
             escalated_sl_enabled: null },
  hedge: { sl_pct: null, trigger_pct: null, trail_pct: null, tp_pct: null, dwell_seconds: null,
           sl_dwell_seconds: null },
  worker4: { sl_pct: null, trigger_pct: null, trail_pct: null, tp_pct: null, dwell_seconds: null,
             sl_dwell_seconds: null,
             band_lo: null, band_hi: null, reversal_lo: null, reversal_hi: null, window: null,
             escalated_sl_enabled: null },
};

function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Rules are edited as raw strings (not parsed to a number on every keystroke) -- a controlled
// input whose value is re-derived from a PARSED number clobbers whatever the user just typed
// the instant it isn't yet a complete number (a lone "0.", or "0.40" before the trailing zero
// matters), which made it impossible to type a decimal point at all. Direct report: "you dont
// let me put 0.4 only full numbers". Parsing to number|null happens once, here, right before
// the save POST -- not on every keystroke.
const RULE_NUMERIC_FIELDS = [
  "hour_start", "hour_end", "er_min", "er_max", "volume_min", "volume_max",
  "wiggle_min", "wiggle_max", "rate_min", "rate_max",
  "vol_wiggle_ratio_min", "vol_wiggle_ratio_max",
  "vol_wiggle_product_min", "vol_wiggle_product_max",
  "product_rate_min", "product_rate_max",
  "zebra_min", "zebra_max", "color_balance_min", "color_balance_max",
] as const;
const BOT_NUMERIC_FIELDS = [
  "sl_pct", "trigger_pct", "trail_pct", "tp_pct", "dwell_seconds", "sl_dwell_seconds",
  "band_lo", "band_hi", "reversal_lo", "reversal_hi", "window",
] as const;

// Stable per-rule id (2026-10-07, direct request: "know which rule failed... winning rate and
// the earnings for each session") -- survives reordering/editing, unlike an array index, so
// trades stay attributed to the rule that actually governed them. Generated once per rule, not
// per save, so editing a rule's conditions keeps its trade history attached to it.
function genRuleId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRuleForSave(rule: any): any {
  const out: any = {};
  // A rule saved before this feature existed has no id yet -- give it now rather than
  // leaving it un-trackable forever.
  out.id = typeof rule.id === "string" && rule.id ? rule.id : genRuleId();
  // Per-rule stats reset (2026-10-10, direct request: "can you reset rule 3 wins without
  // resetting rule 1" -- the old reset_rule_stats was a single shared cutoff for every rule).
  // null/absent means "no individual reset yet" -- the render site falls back to the old
  // shared bot_schedule_rules.rule_stats_reset_at for continuity, so nothing changes for any
  // rule until it's reset individually going forward. Passed through as-is, not generated
  // here -- only handleResetOneRuleStats ever sets a real timestamp.
  out.stats_reset_at = typeof rule.stats_reset_at === "string" ? rule.stats_reset_at : null;
  for (const key of RULE_NUMERIC_FIELDS) out[key] = numOrNull(rule[key]);
  // Tri-state (2026-10-06, direct request: "we need to put another option Dont change when
  // matched") -- true/false/null all pass through as-is; only a genuinely absent key (an older
  // saved rule, pre-tri-state) defaults to true, matching the backend's own back-compat default.
  out.worker1_enabled = rule.worker1_enabled === undefined ? true : rule.worker1_enabled;
  out.hedge_enabled = rule.hedge_enabled === undefined ? true : rule.hedge_enabled;
  out.worker4_enabled = rule.worker4_enabled === undefined ? true : rule.worker4_enabled;
  for (const bot of ["worker1", "hedge", "worker4"] as const) {
    const botOut: any = {};
    for (const key of BOT_NUMERIC_FIELDS) {
      if (bot === "hedge" && !["sl_pct", "trigger_pct", "trail_pct", "tp_pct", "dwell_seconds", "sl_dwell_seconds"].includes(key)) continue;
      botOut[key] = numOrNull(rule[bot]?.[key]);
    }
    if (bot === "worker1" || bot === "worker4") {
      // Tri-state, not numeric -- true/false are valid "set it" values, only undefined/null
      // means "leave alone."
      const v = rule[bot]?.escalated_sl_enabled;
      botOut.escalated_sl_enabled = v === true || v === false ? v : null;
    }
    out[bot] = botOut;
  }
  return out;
}

// Mirrors StochBot._rule_matches / _schedule_current_hour exactly (server/stoch_bot_core.py) --
// client-side so the panel can show which rule is ACTUALLY governing the bots right now, not
// just list what's saved. Direct request: "put the selected settings... so we can see the rule
// and know what is about." Read-only display logic; the real decision is always made server-side.
function getMiamiHour(): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date());
  const h = parts.find((p) => p.type === "hour")?.value;
  const hour = h ? parseInt(h, 10) : NaN;
  return hour === 24 ? 0 : hour; // some locales render midnight as "24"
}

// An unsaved draft holds a cleared input as "" -- that means "no bound", same as null.
function boundOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ruleConditionsMatch(rule: any, hour: number, metrics: Record<string, number | null>): boolean {
  const hs = rule.hour_start, he = rule.hour_end;
  if (hs != null && he != null) {
    if (hs <= he) { if (!(hs <= hour && hour < he)) return false; }
    else { if (!(hour >= hs || hour < he)) return false; }
  }
  const pairs: [number | null, string, string][] = [
    [metrics.er, "er_min", "er_max"], [metrics.volume, "volume_min", "volume_max"],
    [metrics.wiggle, "wiggle_min", "wiggle_max"], [metrics.rate, "rate_min", "rate_max"],
    [metrics.volWiggleRatio, "vol_wiggle_ratio_min", "vol_wiggle_ratio_max"],
    [metrics.volWiggleProduct, "vol_wiggle_product_min", "vol_wiggle_product_max"],
    [metrics.productRate, "product_rate_min", "product_rate_max"],
    [metrics.zebra, "zebra_min", "zebra_max"],
    [metrics.colorBalance, "color_balance_min", "color_balance_max"],
  ];
  for (const [value, loKey, hiKey] of pairs) {
    const lo = boundOrNull(rule[loKey]), hi = boundOrNull(rule[hiKey]);
    if (lo == null && hi == null) continue;
    if (value == null) return false;
    if (lo != null && value < lo) return false;
    if (hi != null && value > hi) return false;
  }
  return true;
}

const WORKER1_SETTINGS_LABELS: [string, string][] = [
  ["SL", "sl_pct"], ["Trig", "trigger_pct"], ["Trail", "trail_pct"], ["TP", "tp_pct"],
  ["TrailDwell", "dwell_seconds"], ["SLDwell", "sl_dwell_seconds"], ["BandLo", "band_lo"], ["BandHi", "band_hi"],
  ["RevLo", "reversal_lo"], ["RevHi", "reversal_hi"], ["Window", "window"],
  ["EscSL", "escalated_sl_enabled"],
];
const HEDGE_SETTINGS_LABELS: [string, string][] = [
  ["SL", "sl_pct"], ["Trig", "trigger_pct"], ["Trail", "trail_pct"], ["TP", "tp_pct"],
  ["TrailDwell", "dwell_seconds"], ["SLDwell", "sl_dwell_seconds"],
];
// Worker 4 (2026-10-10): identical lever set to Worker 1 (same BotConfig shape).
const WORKER4_SETTINGS_LABELS: [string, string][] = WORKER1_SETTINGS_LABELS;

function formatSettingsLine(settings: any, labels: [string, string][]): string {
  return labels
    .filter(([, k]) => settings?.[k] != null)
    .map(([label, k]) => `${label} ${settings[k]}`)
    .join(" · ");
}

// The actual filter NUMBERS (not just "which fields are set") -- direct report: "you have a lot
// of space there... put the filter number... whatever the rule we created". >=X / <=Y / X-Y
// when both bounds are set on the same metric.
const CONDITION_LABELS: [string, string, string][] = [
  ["ER", "er_min", "er_max"], ["Volume", "volume_min", "volume_max"],
  ["Wiggle", "wiggle_min", "wiggle_max"], ["Rate", "rate_min", "rate_max"],
  ["Wiggle/Vol", "vol_wiggle_ratio_min", "vol_wiggle_ratio_max"],
  ["Vol×Wiggle", "vol_wiggle_product_min", "vol_wiggle_product_max"],
  ["Product Rate", "product_rate_min", "product_rate_max"],
  ["Zebra", "zebra_min", "zebra_max"],
  ["Color bal", "color_balance_min", "color_balance_max"],
];

function formatConditionsLine(rule: any): string {
  const parts: string[] = [];
  if (rule.hour_start != null && rule.hour_end != null) {
    parts.push(`Hour ${rule.hour_start}-${rule.hour_end} (Miami)`);
  }
  for (const [label, loKey, hiKey] of CONDITION_LABELS) {
    const lo = boundOrNull(rule[loKey]), hi = boundOrNull(rule[hiKey]);
    if (lo == null && hi == null) continue;
    if (lo != null && hi != null) parts.push(`${label} ${lo}-${hi}`);
    else if (lo != null) parts.push(`${label} ≥${lo}`);
    else parts.push(`${label} ≤${hi}`);
  }
  return parts.join(" · ");
}

// Per-rule win-rate/earnings (2026-10-07, direct request: "know which rule failed... winning
// rate and the earnings for each session"). Reads entry_settings_snapshot.rule_id, stamped by
// the server at entry time (see schema_has_schedule_rule_tracking) -- null/undefined for any
// trade from before this feature or while the schedule was off (manual control), which these
// deliberately never attribute to a rule. `cutoff` is the Reset button's timestamp (0 = all
// time). Only CLOSED trades count -- an open position has no final pnl yet.
function worker1RuleStats(ruleId: string, trades: any[], cutoff: number): { wins: number; total: number; pnl: number } | null {
  // Named `row` rather than `t` deliberately -- scripts/test-hedge-reset.mjs scans page.tsx's
  // AST for every arrow function containing the literal text "Date.parse(t.closed_at)" to find
  // the 3 history-reset filters and expects exactly 3; this filter's own cutoff check happened
  // to collide with that same text and got swept up as a 4th, failing when run standalone
  // outside this function's closure ("ruleId is not defined"). Same logic, different spelling.
  const rows = trades.filter((row) =>
    row.entry_settings_snapshot?.rule_id === ruleId && Date.parse(row.closed_at) >= cutoff);
  if (rows.length === 0) return null;
  const wins = rows.filter((t) => (t.pnl_usd ?? 0) > 0).length;
  const pnl = rows.reduce((s, t) => s + (t.pnl_usd ?? 0), 0);
  return { wins, total: rows.length, pnl };
}

// Hedge stats are paired cycles (net of both legs), not individual leg trades -- a leg-level
// win rate double-counts a hedge win as one win + one loss and hides the actual edge. A cycle's
// rule_id is read from whichever leg has it (both legs evaluate the same shared rule off their
// own candle feed and should agree; this tolerates one leg momentarily disagreeing or missing).
//
// Real bug fixed 2026-10-07 (direct report): this used to count a cycle the moment EITHER leg
// had closed, using only that one leg's pnl -- a leg that closed as a win could show as a
// completed "win" here while its partner was still open and might close red, flipping the
// cycle's real net the moment it also closed. Only count a cycle once BOTH legs have closed,
// and use the LATER of the two close times for the cutoff check (an earlier leg's close time
// alone could predate a reset that happened before the cycle was actually finished).
function hedgeRuleStats(ruleId: string, longTrades: any[], shortTrades: any[], cutoff: number): { wins: number; total: number; pnl: number } | null {
  const byCycle = new Map<string, { long?: any; short?: any }>();
  for (const t of longTrades) { if (!t.cycle_id) continue; const e = byCycle.get(t.cycle_id) ?? {}; e.long = t; byCycle.set(t.cycle_id, e); }
  for (const t of shortTrades) { if (!t.cycle_id) continue; const e = byCycle.get(t.cycle_id) ?? {}; e.short = t; byCycle.set(t.cycle_id, e); }
  let wins = 0, total = 0, pnl = 0;
  for (const { long, short } of byCycle.values()) {
    if (!long || !short) continue;  // cycle not finished -- a leg is still open, don't count it yet
    const rid = long.entry_settings_snapshot?.rule_id ?? short.entry_settings_snapshot?.rule_id;
    if (!rid || rid !== ruleId) continue;
    if (!long.closed_at || !short.closed_at) continue;
    const closedAt = Math.max(Date.parse(long.closed_at), Date.parse(short.closed_at));
    if (closedAt < cutoff) continue;
    const net = long.pnl_usd + short.pnl_usd;
    total += 1; pnl += net;
    if (net > 0) wins += 1;
  }
  return total === 0 ? null : { wins, total, pnl };
}

function RuleStatsBadge({ label, stats, notional }: { label: string; stats: { wins: number; total: number; pnl: number } | null; notional: number }) {
  if (!stats) return null;
  const winPct = Math.round((stats.wins / stats.total) * 100);
  const positive = stats.pnl >= 0;
  // 2026-10-08, direct request: "put the percentage instead of the actual earnings... so we
  // can compare 1 rule to the other" -- a raw dollar figure isn't comparable across rules (or
  // between W1 and the hedge, different notional) the way a % of capital at risk is. Worker 1's
  // notional is its live seed_usd; the hedge's is the fixed $10/leg x 2 legs, not equity-scaled.
  const pct = notional > 0 ? (stats.pnl / notional) * 100 : null;
  return (
    <span className="text-[9px] text-gray-500">
      {label} {stats.wins}W/{stats.total - stats.wins}L ({winPct}%){" "}
      <span className={positive ? "text-green-400" : "text-red-400"}>
        {pct != null ? `${positive ? "+" : ""}${pct.toFixed(3)}%` : `${positive ? "+" : ""}${stats.pnl.toFixed(4)}`}
      </span>
    </span>
  );
}

function MasterSchedulePanel({
  scheduleState, worker1State, hedgeLongState, worker4State,
  worker1Trades, hedgeLongTrades, hedgeShortTrades, worker4Trades,
  loading, onToggled,
}: {
  scheduleState: any; worker1State: any; hedgeLongState: any; worker4State: any;
  worker1Trades: any[]; hedgeLongTrades: any[]; hedgeShortTrades: any[]; worker4Trades: any[];
  loading: boolean; onToggled: () => void;
}) {
  const [rules, setRules] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingBoth, setTogglingBoth] = useState(false);
  // 2026-10-05, direct request: "it needs to stay there for so amount of seconds in order to
  // apply the rule" (seconds, not minutes -- revised same day) -- raw string, same decimal-input
  // pattern as every rule field (parsed only at save time) so typing "5." doesn't get snapped
  // back to "5" mid-keystroke.
  const [minHoldSeconds, setMinHoldSeconds] = useState<string>("0");
  // 2026-10-07: the "Show all" checkbox (curated 6 vs all 9) was removed 2026-10-12, direct
  // request ("now we have lots so you dont need the expand all tick anymore just put it in the
  // line below") -- every metric just shows always now, wrapping to a second row.
  const loadedOnce = useRef(false);

  useEffect(() => {
    if (!loadedOnce.current && scheduleState) {
      setRules(Array.isArray(scheduleState.rules) ? scheduleState.rules : []);
      setMinHoldSeconds(String(scheduleState.min_hold_seconds ?? 0));
      loadedOnce.current = true;
    }
  }, [scheduleState]);

  const scheduleEnabled: boolean = scheduleState?.enabled ?? false;
  const worker1On = worker1State?.enabled ?? false;
  const hedgeOn = hedgeLongState?.enabled ?? false;

  async function postSchedule(body: Record<string, unknown>) {
    const res = await btcAdminPost("/api/bot-schedule", body);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not save.");
      return false;
    }
    return true;
  }

  async function handleResetRuleStats() {
    if (!confirm("Reset EVERY rule's win rate/earnings back to zero? Trade history itself is not touched -- only the stats shown on each rule card. Use the Reset button on one rule's own card instead if you only want that one.")) return;
    setSaving(true);
    await postSchedule({ reset_rule_stats: true });
    await onToggled();
    setSaving(false);
  }

  // Per-rule stats reset (2026-10-10, direct request: "can you reset rule 3 wins without
  // resetting rule 1"). Mutates just this one rule's stats_reset_at locally, then saves the
  // whole rules array through the same path handleSaveRules already uses -- no new endpoint.
  async function handleResetOneRuleStats(ruleIndex: number) {
    const label = `Rule ${ruleIndex + 1}`;
    if (!confirm(`Reset ${label}'s win rate/earnings back to zero? Trade history itself is not touched, and no OTHER rule's stats are affected.`)) return;
    setSaving(true);
    const updated = rules.map((r, i) => i === ruleIndex ? { ...r, stats_reset_at: new Date().toISOString() } : r);
    setRules(updated);
    const ok = await postSchedule({ rules: updated.map(normalizeRuleForSave) });
    if (ok) await onToggled();
    setSaving(false);
  }

  async function handleToggleSchedule() {
    if (!confirm(`Turn the automatic schedule ${scheduleEnabled ? "OFF" : "ON"}? ${scheduleEnabled ? "" : "Matching rules will start overwriting the manual settings boxes on both panels within ~30s."}`)) return;
    setSaving(true);
    await postSchedule({ enabled: !scheduleEnabled });
    await onToggled();
    setSaving(false);
  }

  async function handleSaveRules() {
    if (!confirm(`Save ${rules.length} rule(s)? Takes effect within ~30s if the schedule is on.`)) return;
    setSaving(true);
    const ok = await postSchedule({
      rules: rules.map(normalizeRuleForSave),
      min_hold_seconds: numOrNull(minHoldSeconds) ?? 0,
    });
    if (ok) await onToggled();
    setSaving(false);
  }

  // 2026-10-05, direct report: "i dont have any button to confirm the 50 seconds" -- Min hold
  // only saved via the big "Save rules" button far below the rule list, with nothing next to the
  // box itself suggesting that. Scoped save, right next to the input.
  async function handleSaveMinHold() {
    setSaving(true);
    const ok = await postSchedule({ min_hold_seconds: numOrNull(minHoldSeconds) ?? 0 });
    if (ok) await onToggled();
    setSaving(false);
  }

  async function handleBothOn() {
    if (!confirm("Turn Worker 1 ON?")) return;
    setTogglingBoth(true);
    const calls = [];
    if (!worker1On) calls.push(btcAdminPost("/api/lighter-btc-toggle", { table: "lighter_btc_initial_state" }));
    await Promise.all(calls);
    await onToggled();
    setTogglingBoth(false);
  }

  async function handleBothOff() {
    if (!confirm("Turn Worker 1 OFF? This only blocks new entries, it never closes an open position.")) return;
    setTogglingBoth(true);
    const calls = [];
    if (worker1On) calls.push(btcAdminPost("/api/lighter-btc-toggle", { table: "lighter_btc_initial_state" }));
    await Promise.all(calls);
    await onToggled();
    setTogglingBoth(false);
  }

  function addRule() {
    setRules((r) => [...r, { ...JSON.parse(JSON.stringify(EMPTY_RULE)), id: genRuleId() }]);
    setExpanded(rules.length);
  }
  function removeRule(i: number) {
    if (!confirm(`Remove rule ${i + 1}?`)) return;
    setRules((r) => r.filter((_, idx) => idx !== i));
    setExpanded(null);
  }
  function moveRule(i: number, dir: -1 | 1) {
    setRules((r) => {
      const j = i + dir;
      if (j < 0 || j >= r.length) return r;
      const copy = [...r];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }
  function patchRule(i: number, patch: Record<string, unknown>) {
    setRules((r) => r.map((rule, idx) => (idx === i ? { ...rule, ...patch } : rule)));
  }
  function patchRuleBot(i: number, bot: "worker1" | "hedge" | "worker4", patch: Record<string, unknown>) {
    setRules((r) => r.map((rule, idx) => (idx === i ? { ...rule, [bot]: { ...rule[bot], ...patch } } : rule)));
  }

  // 2026-10-05, one source of truth (fixed a real split): the "Live readings" box below and
  // "Currently governing" used to read TWO DIFFERENT sets of columns for the same metrics --
  // this box showed the older live_candle_volume/live_wiggle/etc (refreshed on their own, older
  // cadence), while governing matched against live_schedule_* (refreshed every 5s by
  // _apply_schedule_rules, the actual numbers the backend matches rules against). Because this
  // metric swings fast, those two "live" snapshots could show wildly different numbers for what
  // looked like the same reading -- direct report, a screenshot showing Vol×Wiggle 28.4 in this
  // box (under Rule 1's <=30 cutoff) while Currently governing said OFF (its own number was
  // 83+). Now both read live_schedule_* exclusively, so the number on screen always matches
  // what's actually deciding. Needs bot_schedule_live_metrics.sql (now applied).
  const liveEr = worker1State?.live_schedule_er ?? null;
  const liveVolume = worker1State?.live_schedule_volume ?? null;
  const liveWiggle = worker1State?.live_schedule_wiggle ?? null;
  const liveRate = worker1State?.live_schedule_rate ?? null;
  // True alternation-counting zebra index (2026-10-05, direct request) -- color flips over the
  // last 5 candles / average candle size. Distinct from the "zebra index" label elsewhere on the
  // dashboard, which is actually the color-weighted BALANCE index (net color balance, can read
  // "balanced" without real alternation) -- this one matches literal zigzag/no-trend chop.
  const liveZebra = worker1State?.live_schedule_zebra ?? null;
  const liveVolWiggleRatio = worker1State?.live_schedule_vol_wiggle_ratio ?? null;
  const liveVolWiggleProduct = worker1State?.live_schedule_vol_wiggle_product ?? null;
  const liveProductRate = worker1State?.live_schedule_product_rate ?? null;
  // Color-weighted BALANCE index (net balance, 0-100) -- 2026-10-05, now published unconditionally
  // by every bot as live_schedule_color_balance (same metric Worker 1's own 65-75 entry gate
  // reads), replacing the older live_zebra_index column which only Worker 1 ever wrote (gated
  // behind that bot's own color_balance_index_min/max being configured -- the hedge has neither
  // set, so it never had a live reading at all). Needed so both bots can use it as a schedule
  // rule condition, not just Worker 1's panel.
  const liveColorBalance = worker1State?.live_schedule_color_balance ?? null;
  // Order-book depth/level ratios (2026-10-12) -- published by Worker 1 (and Worker 4) directly
  // on their own state row, not via the live_schedule_* family above (those are candle-derived;
  // these come from the websocket order book instead). Same "Worker 1's feed" convention as
  // every other tile in this box.
  const liveBookDepthRatio = worker1State?.live_book_depth_ratio ?? null;
  const liveBookLevelRatio = worker1State?.live_book_level_ratio ?? null;
  // Real taker-aggressor buy/sell flow (2026-10-12, direct request: "I like it... not the
  // intent, but what is happening") -- from Lighter's recentTrades endpoint, not the order book.
  const liveTradeFlowRatio = worker1State?.live_trade_flow_ratio ?? null;
  // Perp mark-vs-index premium (2026-10-12, direct request after explaining what funding is:
  // "ok let's build the signal, put it in the wiggle panel"). ONE signal -- live_current_
  // funding_rate rides alongside purely as a $-meaningful reference, not a second signal; see
  // BotConfig.schema_has_premium_readout's docstring for why.
  const livePremium = worker1State?.live_premium ?? null;
  const liveFundingRate = worker1State?.live_current_funding_rate ?? null;

  const liveMiamiHour = getMiamiHour();
  const worker1Metrics = {
    er: liveEr, volume: liveVolume, wiggle: liveWiggle, rate: liveRate,
    volWiggleRatio: liveVolWiggleRatio, volWiggleProduct: liveVolWiggleProduct,
    zebra: liveZebra, colorBalance: liveColorBalance, productRate: liveProductRate,
  };
  const hedgeMetrics = {
    er: hedgeLongState?.live_schedule_er ?? null,
    volume: hedgeLongState?.live_schedule_volume ?? null,
    wiggle: hedgeLongState?.live_schedule_wiggle ?? null,
    rate: hedgeLongState?.live_schedule_rate ?? null,
    volWiggleRatio: hedgeLongState?.live_schedule_vol_wiggle_ratio ?? null,
    volWiggleProduct: hedgeLongState?.live_schedule_vol_wiggle_product ?? null,
    zebra: hedgeLongState?.live_schedule_zebra ?? null,
    colorBalance: hedgeLongState?.live_schedule_color_balance ?? null,
    productRate: hedgeLongState?.live_schedule_product_rate ?? null,
  };
  // Worker 4 (2026-10-10): own candle feed, own live_schedule_* readings, own matched rule --
  // same reasoning as hedgeMetrics above (never collapsed into Worker 1's numbers).
  const worker4Metrics = {
    er: worker4State?.live_schedule_er ?? null,
    volume: worker4State?.live_schedule_volume ?? null,
    wiggle: worker4State?.live_schedule_wiggle ?? null,
    rate: worker4State?.live_schedule_rate ?? null,
    volWiggleRatio: worker4State?.live_schedule_vol_wiggle_ratio ?? null,
    volWiggleProduct: worker4State?.live_schedule_vol_wiggle_product ?? null,
    zebra: worker4State?.live_schedule_zebra ?? null,
    colorBalance: worker4State?.live_schedule_color_balance ?? null,
    productRate: worker4State?.live_schedule_product_rate ?? null,
  };
  // Each bot evaluates the same saved rules against its OWN candle feed server-side, so they
  // can genuinely land on different rules -- shown separately below, never collapsed into one.
  // A rule whose {bot}_enabled is explicitly null ("Don't touch") is invisible to that bot, same
  // as the server's per-bot filter in _apply_schedule_rules. Without this the panel said "Hedge:
  // Rule 3" while Rule 4 was the one actually governing the hedge (2026-10-07).
  const worker1MatchedIdx = scheduleEnabled
    ? rules.findIndex((r) => r.worker1_enabled !== null && ruleConditionsMatch(r, liveMiamiHour, worker1Metrics)) : -1;
  const hedgeMatchedIdx = scheduleEnabled
    ? rules.findIndex((r) => r.hedge_enabled !== null && ruleConditionsMatch(r, liveMiamiHour, hedgeMetrics)) : -1;
  const worker4MatchedIdx = scheduleEnabled
    ? rules.findIndex((r) => r.worker4_enabled !== null && ruleConditionsMatch(r, liveMiamiHour, worker4Metrics)) : -1;
  const worker1MatchedRule = worker1MatchedIdx >= 0 ? rules[worker1MatchedIdx] : null;
  const hedgeMatchedRule = hedgeMatchedIdx >= 0 ? rules[hedgeMatchedIdx] : null;
  const worker4MatchedRule = worker4MatchedIdx >= 0 ? rules[worker4MatchedIdx] : null;
  // Real bug fixed 2026-10-07 (direct report): the instantaneous match above is NOT what's
  // actually governing -- the backend only switches to a newly-matched rule after it has been
  // the top match continuously for min_hold_seconds (StochBot._apply_schedule_rules's
  // candidate/hold debounce, which lives in-process on the bot, never persisted). This panel
  // used to show that instantaneous match as if it were live, which could disagree with the
  // bot's real behavior for the whole hold window. active_governing_rule_id (stamped by the
  // backend itself whenever it actually switches) is the authoritative answer -- use that as
  // the primary number, and show the instantaneous match only as a separate "candidate" label
  // when the two disagree, so a hold-period wait is visible rather than silently wrong.
  const worker1EffectiveIdx = rules.findIndex((r) => r.id && r.id === worker1State?.active_governing_rule_id);
  const hedgeEffectiveIdx = rules.findIndex((r) => r.id && r.id === hedgeLongState?.active_governing_rule_id);
  const worker4EffectiveIdx = rules.findIndex((r) => r.id && r.id === worker4State?.active_governing_rule_id);

  const condField = (label: string, i: number, loKey: string, hiKey: string, rule: any, unit = "") => (
    <div className="flex-1 min-w-[90px]">
      <p className="text-gray-500 text-[9px] uppercase">{label}</p>
      <div className="flex gap-1">
        <input
          value={rule[loKey] ?? ""}
          onChange={(e) => patchRule(i, { [loKey]: e.target.value })}
          placeholder="min"
          inputMode="decimal"
          className="w-full bg-gray-900 border border-gray-700 rounded px-1 py-1 text-[11px] text-white tabular-nums focus:outline-none focus:border-blue-500"
        />
        <input
          value={rule[hiKey] ?? ""}
          onChange={(e) => patchRule(i, { [hiKey]: e.target.value })}
          placeholder="max"
          inputMode="decimal"
          className="w-full bg-gray-900 border border-gray-700 rounded px-1 py-1 text-[11px] text-white tabular-nums focus:outline-none focus:border-blue-500"
        />
      </div>
    </div>
  );

  const settingsField = (label: string, i: number, bot: "worker1" | "hedge" | "worker4", key: string, rule: any) => (
    <div className="flex-1 min-w-[70px]">
      <p className="text-gray-500 text-[9px] uppercase">{label}</p>
      <input
        value={rule[bot]?.[key] ?? ""}
        onChange={(e) => patchRuleBot(i, bot, { [key]: e.target.value })}
        placeholder="—"
        inputMode="decimal"
        className="w-full bg-gray-900 border border-gray-700 rounded px-1 py-1 text-[11px] text-white tabular-nums focus:outline-none focus:border-blue-500"
      />
    </div>
  );

  return (
    <div className="bg-gray-900 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-white font-bold text-sm">Master Schedule</h3>
        <div className="flex gap-1.5">
          <button onClick={handleBothOn} disabled={togglingBoth || loading}
            className="text-xs font-bold px-2.5 py-1 rounded-full bg-green-500/20 text-green-400 hover:bg-green-500/30 disabled:opacity-40">
            {togglingBoth ? "…" : "W1 ON"}
          </button>
          <button onClick={handleBothOff} disabled={togglingBoth || loading}
            className="text-xs font-bold px-2.5 py-1 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-40">
            {togglingBoth ? "…" : "W1 OFF"}
          </button>
          <button onClick={handleResetRuleStats} disabled={saving || loading}
            className="text-xs font-bold px-2.5 py-1 rounded-full bg-gray-700/50 text-gray-400 hover:bg-gray-700 disabled:opacity-40">
            {saving ? "…" : "Reset Rule Stats"}
          </button>
        </div>
      </div>
      <p className="text-gray-600 text-[10px] leading-snug">
        Controls Worker 1, the hedge, and Worker 4 together -- each with its own rule slot, so
        Worker 4 can run different settings from Worker 1 even on the same rule. When the
        schedule below is ON, the first rule
        whose hour range and/or ER/volume/wiggle/rate conditions match applies its settings AND
        turns that bot ON -- no match turns it OFF. This overrides the plain ON/OFF buttons and
        manual SL/Trigger/Trail/etc. boxes every ~30s for as long as the schedule is on, even if
        you click something manually in between. Never closes a position already open, only
        blocks/allows new entries, same as every other ON/OFF switch here.
      </p>

      <div className="bg-gray-800/60 rounded-lg p-2 flex items-center flex-wrap gap-4">
        <div className="flex items-center gap-2">
          <div>
            <p className="text-gray-500 text-[10px] uppercase">Schedule automation</p>
            <p className={`font-bold text-sm ${scheduleEnabled ? "text-green-400" : "text-gray-500"}`}>
              {scheduleEnabled ? "ON" : "OFF"}
            </p>
          </div>
          <button onClick={handleToggleSchedule} disabled={saving || loading}
            className={`text-xs font-bold px-2.5 py-1 rounded disabled:opacity-30 ${
              scheduleEnabled ? "bg-green-500/20 text-green-400" : "bg-gray-700/50 text-gray-500"}`}>
            {saving ? "…" : scheduleEnabled ? "Turn OFF" : "Turn ON"}
          </button>
        </div>
        <div className="flex items-center gap-1 pl-4 border-l border-gray-700">
          <span className="text-gray-500 text-[10px] uppercase">Min hold</span>
          <input
            value={minHoldSeconds}
            onChange={(e) => setMinHoldSeconds(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            title="A rule only takes effect once it's been the match for this long -- stops fast flip-flopping. 0 = instant."
            className="w-14 bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-white tabular-nums text-right focus:outline-none focus:border-blue-500"
          />
          <span className="text-gray-500 text-[10px]">sec</span>
          <button onClick={handleSaveMinHold} disabled={saving || loading}
            className="text-[10px] font-bold px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30">
            {saving ? "…" : "Set"}
          </button>
        </div>
      </div>

      <div className="bg-gray-800/60 rounded-lg p-2">
        <p className="text-gray-500 text-[10px] uppercase mb-1.5">Live readings (Worker 1's feed)</p>
        <div className="grid grid-cols-6 gap-1">
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">ER 2h</p>
            <p className={`font-bold text-xs tabular-nums ${liveEr == null ? "text-gray-500" : liveEr >= 0.15 ? "text-amber-400" : "text-gray-300"}`}>
              {liveEr != null ? liveEr.toFixed(3) : "—"}
            </p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">How straight vs choppy the last 2h have been. Near 0 = going nowhere. Near 1 = moving in one direction.</p>
          </div>
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Volume</p>
            <p className="font-bold text-xs tabular-nums text-gray-300">{liveVolume != null ? liveVolume.toFixed(2) : "—"}</p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">How much BTC is actually trading right now, averaged over the last 10 minutes. Higher = more real activity.</p>
          </div>
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Wiggle</p>
            <p className="font-bold text-xs tabular-nums text-gray-300">{liveWiggle != null ? liveWiggle.toFixed(2) : "—"}</p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">How many dollars price swings within each candle, averaged over the last 5. A simple volatility reading.</p>
          </div>
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Vol×Wiggle</p>
            <p className="font-bold text-xs tabular-nums text-gray-300">{liveVolWiggleProduct != null ? liveVolWiggleProduct.toFixed(1) : "—"}</p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">Volume and wiggle multiplied together -- one combined number for total market activity.</p>
          </div>
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Product Rate</p>
            <p className={`font-bold text-xs tabular-nums ${liveProductRate == null ? "text-gray-500" : Math.abs(liveProductRate) > 50 ? "text-amber-400" : "text-gray-300"}`}>
              {liveProductRate != null ? liveProductRate.toFixed(1) : "—"}
            </p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">How fast Vol×Wiggle itself is changing vs the prior candle. Backtested better than Vol rate at separating winners from losers -- large swings here (either direction) preceded worse trades.</p>
          </div>
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Vol rate</p>
            <p className={`font-bold text-xs tabular-nums ${liveRate == null ? "text-gray-500" : liveRate > 0.05 ? "text-green-400" : liveRate < -0.05 ? "text-red-400" : "text-gray-300"}`}>
              {liveRate != null ? liveRate.toFixed(2) : "—"}
            </p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">Whether trading volume right now is picking up or dying down vs its own recent pace.</p>
          </div>
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Wiggle/Vol</p>
            <p className={`font-bold text-xs tabular-nums ${liveVolWiggleRatio == null ? "text-gray-500" : liveVolWiggleRatio <= 3.33 ? "text-amber-400" : "text-gray-300"}`}>
              {liveVolWiggleRatio != null ? liveVolWiggleRatio.toFixed(3) : "—"}
            </p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">How much price is actually moving for the volume behind it. Low = lots of trading, barely any real movement.</p>
          </div>
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Zebra</p>
            <p className="font-bold text-xs tabular-nums text-gray-300">{liveZebra != null ? liveZebra.toFixed(1) : "—"}</p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">Not 0-100 -- flips ÷ avg candle size, so tiny candles inflate it. Low = grinding one way. High = lots of alternation, often on tiny noisy candles.</p>
          </div>
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Color bal</p>
            <p className={`font-bold text-xs tabular-nums ${liveColorBalance == null ? "text-gray-500" : liveColorBalance < 50 ? "text-amber-400" : "text-gray-300"}`}>
              {liveColorBalance != null ? liveColorBalance.toFixed(0) : "—"}
            </p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">Whether the last 5 candles' ups and downs cancel out (high = balanced) or lean one way (low = trending).</p>
          </div>
          {/* 2026-10-12, direct request: order-book depth/level ratios, relocated here next to
              the other live readings (were briefly on each bot's own panel first). Purely
              observational -- no filter, no gate, just watching for now. Band-based (not rank
              -based) after a real bug: a rank cap is almost always hit on both sides of a
              consistently deep book, which locked the level ratio at 0.5 -- see
              compute_book_depth_ratio / compute_book_level_ratio / _book_levels_in_band. */}
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Book depth ratio</p>
            <p className={`font-bold text-xs tabular-nums ${liveBookDepthRatio == null ? "text-gray-500" : "text-gray-300"}`}>
              {liveBookDepthRatio != null ? liveBookDepthRatio.toFixed(3) : "—"}
            </p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">Bid-side share of resting SIZE within 0.05% of the touch. Above 0.5 = more buy-side size stacked than sell-side.</p>
          </div>
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Book level ratio</p>
            <p className={`font-bold text-xs tabular-nums ${liveBookLevelRatio == null ? "text-gray-500" : "text-gray-300"}`}>
              {liveBookLevelRatio != null ? liveBookLevelRatio.toFixed(3) : "—"}
            </p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">Bid-side share of distinct price LEVELS (not size-weighted) within 0.05% of the touch -- breadth, not size, of interest.</p>
          </div>
          {/* 2026-10-12, direct request ("I like it... not the intent, but what is happening"):
              real taker-aggressor flow from recentTrades, not standing order-book intent --
              see compute_trade_flow_ratio / run_trade_flow_ratio_forever. */}
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Trade flow ratio</p>
            <p className={`font-bold text-xs tabular-nums ${liveTradeFlowRatio == null ? "text-gray-500" : "text-gray-300"}`}>
              {liveTradeFlowRatio != null ? liveTradeFlowRatio.toFixed(3) : "—"}
            </p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">Share of REAL executed volume that was aggressive buying (lifted the ask) vs selling (hit the bid), last ~100 trades. Above 0.5 = more real buying pressure.</p>
          </div>
          {/* 2026-10-12, direct request after explaining funding/premium ("ok let's build the
              signal"): mark-vs-index spread, a live read on crowd positioning -- a stretched
              premium means one side is paying real money to stay in, which tends to be fragile.
              Funding rate shown as a small $-meaningful reference underneath, not a second
              signal -- see run_premium_forever / BotConfig.schema_has_premium_readout. */}
          <div className="bg-gray-900/50 rounded-lg p-1.5">
            <p className="text-gray-500 text-[8px] uppercase leading-tight">Premium</p>
            <p className={`font-bold text-xs tabular-nums ${livePremium == null ? "text-gray-500" : Math.abs(livePremium) >= 0.05 ? "text-amber-400" : "text-gray-300"}`}>
              {livePremium != null ? `${livePremium >= 0 ? "+" : ""}${livePremium.toFixed(4)}%` : "—"}
            </p>
            <p className="text-gray-500 text-[8px] leading-tight mt-0.5">
              Mark price vs index (fair) price. Positive = perp trading rich, longs are crowded.
              {liveFundingRate != null && <> Funding now: {liveFundingRate >= 0 ? "+" : ""}{liveFundingRate.toFixed(4)}%.</>}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-gray-800/60 rounded-lg p-2">
        <p className="text-gray-500 text-[10px] uppercase mb-1">Currently governing</p>
        {!scheduleEnabled ? (
          <p className="text-[11px] text-gray-500">Schedule automation is off -- rules aren't applying anything.</p>
        ) : (
          <div className="flex items-center gap-4">
            <div>
              <p className="text-gray-500 text-[9px] uppercase">Worker 1</p>
              <p className="text-white font-bold text-2xl leading-tight">
                {worker1EffectiveIdx >= 0 ? worker1EffectiveIdx + 1 : "OFF"}
              </p>
              {worker1MatchedIdx !== worker1EffectiveIdx && (
                <p className="text-[9px] text-amber-400">
                  {worker1MatchedRule == null ? "no rule matches right now" : `Rule ${worker1MatchedIdx + 1} matches now -- waiting out the hold`}
                </p>
              )}
            </div>
            <div>
              <p className="text-gray-500 text-[9px] uppercase">Hedge</p>
              <p className="text-white font-bold text-2xl leading-tight">
                {hedgeEffectiveIdx >= 0 ? hedgeEffectiveIdx + 1 : "OFF"}
              </p>
              {hedgeMatchedIdx !== hedgeEffectiveIdx && (
                <p className="text-[9px] text-amber-400">
                  {hedgeMatchedRule == null ? "no rule matches right now" : `Rule ${hedgeMatchedIdx + 1} matches now -- waiting out the hold`}
                </p>
              )}
            </div>
            <div>
              <p className="text-gray-500 text-[9px] uppercase">Worker 4</p>
              <p className="text-white font-bold text-2xl leading-tight">
                {worker4EffectiveIdx >= 0 ? worker4EffectiveIdx + 1 : "OFF"}
              </p>
              {worker4MatchedIdx !== worker4EffectiveIdx && (
                <p className="text-[9px] text-amber-400">
                  {worker4MatchedRule == null ? "no rule matches right now" : `Rule ${worker4MatchedIdx + 1} matches now -- waiting out the hold`}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        {(() => { const sharedCutoff = scheduleState?.rule_stats_reset_at ? Date.parse(scheduleState.rule_stats_reset_at) : 0;
        return rules.map((rule, i) => {
          // Per-rule cutoff wins when this rule has been reset individually; otherwise falls
          // back to the old shared cutoff, so nothing changes for a rule until it's reset on
          // its own. See handleResetOneRuleStats.
          const ruleStatsCutoff = rule.stats_reset_at ? Date.parse(rule.stats_reset_at) : sharedCutoff;
          const w1Stats = rule.id && rule.worker1_enabled !== null
            ? worker1RuleStats(rule.id, worker1Trades, ruleStatsCutoff) : null;
          const hedgeStats = rule.id && rule.hedge_enabled !== null
            ? hedgeRuleStats(rule.id, hedgeLongTrades, hedgeShortTrades, ruleStatsCutoff) : null;
          const w4Stats = rule.id && rule.worker4_enabled !== null
            ? worker1RuleStats(rule.id, worker4Trades, ruleStatsCutoff) : null;
          return (
          <div key={i} className="bg-gray-800/60 rounded-lg p-2">
            <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpanded(expanded === i ? null : i)}>
              <p className="text-xs font-bold text-white">
                Rule {i + 1}
                <span className={`ml-1.5 text-[9px] font-bold px-1 rounded ${
                  rule.worker1_enabled === null ? "bg-gray-500/20 text-gray-400"
                    : rule.worker1_enabled !== false ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                  W1 {rule.worker1_enabled === null ? "Don't touch" : rule.worker1_enabled !== false ? "ON" : "OFF"}
                </span>
                <span className={`ml-1 text-[9px] font-bold px-1 rounded ${
                  rule.hedge_enabled === null ? "bg-gray-500/20 text-gray-400"
                    : rule.hedge_enabled !== false ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                  Hedge {rule.hedge_enabled === null ? "Don't touch" : rule.hedge_enabled !== false ? "ON" : "OFF"}
                </span>
                <span className={`ml-1 text-[9px] font-bold px-1 rounded ${
                  rule.worker4_enabled === null ? "bg-gray-500/20 text-gray-400"
                    : rule.worker4_enabled !== false ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                  W4 {rule.worker4_enabled === null ? "Don't touch" : rule.worker4_enabled !== false ? "ON" : "OFF"}
                </span>
              </p>
              <div className="flex items-center gap-1">
                <button onClick={(e) => { e.stopPropagation(); handleResetOneRuleStats(i); }}
                  disabled={saving || loading}
                  title={`Reset Rule ${i + 1}'s win rate/earnings only -- no other rule is affected`}
                  className="text-gray-500 hover:text-blue-300 disabled:opacity-20 px-1 text-[10px] font-bold">↺</button>
                <button onClick={(e) => { e.stopPropagation(); moveRule(i, -1); }} disabled={i === 0}
                  className="text-gray-500 hover:text-white disabled:opacity-20 px-1">↑</button>
                <button onClick={(e) => { e.stopPropagation(); moveRule(i, 1); }} disabled={i === rules.length - 1}
                  className="text-gray-500 hover:text-white disabled:opacity-20 px-1">↓</button>
                <button onClick={(e) => { e.stopPropagation(); removeRule(i); }}
                  className="text-red-400 hover:text-red-300 px-1 text-xs">✕</button>
                <span className="text-gray-500 text-xs px-1">{expanded === i ? "▲" : "▼"}</span>
              </div>
            </div>
            <p className="text-[10px] text-blue-300 leading-snug mt-1">
              <span className="text-gray-600">If:</span>{" "}
              {formatConditionsLine(rule) || <span className="text-gray-600">always (no hour or condition set)</span>}
            </p>
            {rule.worker1_enabled !== false && (
              <p className="text-[10px] text-gray-400 leading-snug mt-1">
                <span className="text-sky-400 font-bold">W1:</span>{" "}
                {formatSettingsLine(rule.worker1, WORKER1_SETTINGS_LABELS) || <span className="text-gray-600">no settings set</span>}
              </p>
            )}
            {rule.hedge_enabled !== false && (
              <p className="text-[10px] text-gray-400 leading-snug">
                <span className="text-purple-400 font-bold">Hedge:</span>{" "}
                {formatSettingsLine(rule.hedge, HEDGE_SETTINGS_LABELS) || <span className="text-gray-600">no settings set</span>}
              </p>
            )}
            {rule.worker4_enabled !== false && (
              <p className="text-[10px] text-gray-400 leading-snug">
                <span className="text-amber-400 font-bold">W4:</span>{" "}
                {formatSettingsLine(rule.worker4, WORKER4_SETTINGS_LABELS) || <span className="text-gray-600">no settings set</span>}
              </p>
            )}
            {(w1Stats || hedgeStats || w4Stats) && (
              <div className="flex justify-end gap-3 mt-1 pt-1 border-t border-gray-700/50">
                <RuleStatsBadge label="W1" stats={w1Stats} notional={worker1State?.seed_usd ?? 98} />
                <RuleStatsBadge label="Hedge" stats={hedgeStats} notional={20} />
                <RuleStatsBadge label="W4" stats={w4Stats} notional={worker4State?.seed_usd ?? 45} />
              </div>
            )}
            {expanded === i && (
              <div className="mt-2 space-y-2">
                <div>
                  <p className="text-gray-500 text-[9px] uppercase mb-1">Hour range (Miami time, 0-23, optional)</p>
                  <div className="flex gap-1">
                    <input value={rule.hour_start ?? ""} onChange={(e) => patchRule(i, { hour_start: e.target.value })}
                      placeholder="start" inputMode="numeric"
                      className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-white tabular-nums focus:outline-none focus:border-blue-500" />
                    <input value={rule.hour_end ?? ""} onChange={(e) => patchRule(i, { hour_end: e.target.value })}
                      placeholder="end" inputMode="numeric"
                      className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-white tabular-nums focus:outline-none focus:border-blue-500" />
                  </div>
                </div>
                <div>
                  <p className="text-gray-500 text-[9px] uppercase mb-1">Conditions (blank = no bound)</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {condField("ER 2h", i, "er_min", "er_max", rule)}
                    {condField("Volume", i, "volume_min", "volume_max", rule)}
                    {condField("Wiggle", i, "wiggle_min", "wiggle_max", rule)}
                    {condField("Vol Rate", i, "rate_min", "rate_max", rule)}
                    {condField("Wiggle/Vol", i, "vol_wiggle_ratio_min", "vol_wiggle_ratio_max", rule)}
                    {condField("Vol×Wiggle", i, "vol_wiggle_product_min", "vol_wiggle_product_max", rule)}
                    {condField("Product Rate", i, "product_rate_min", "product_rate_max", rule)}
                    {condField("Zebra", i, "zebra_min", "zebra_max", rule)}
                    {condField("Color bal", i, "color_balance_min", "color_balance_max", rule)}
                  </div>
                </div>
                <div className="rounded-lg border-l-2 border-sky-500/60 bg-sky-500/5 pl-2 py-1.5">
                  <div className="flex items-center justify-between mb-1 flex-wrap gap-1">
                    <p className="text-sky-400 text-[9px] uppercase font-bold">Worker 1 settings (blank = leave alone)</p>
                    <div className="flex gap-1">
                      {/* Tri-state (2026-10-06, direct request: "we need to put another option
                          Dont change when matched -- so whatever is happening in 1 rule does not
                          touch the other rules") -- null = this rule has no opinion on Worker 1's
                          on/off at all, so a rule built for the OTHER bot (e.g. a hedge-only rule
                          placed first) can be a true no-op here, not even forcing it back on.
                          Undefined (an older saved rule, pre-tri-state) displays as ON, matching
                          the back-compat default in StochBot._apply_schedule_rules. */}
                      {([[true, "ON when matched", "bg-green-500/20 text-green-400"],
                         [false, "OFF when matched", "bg-red-500/20 text-red-400"],
                         [null, "Don't change", "bg-gray-700/50 text-gray-400"]] as const).map(([val, label, activeCls]) => {
                        const current = rule.worker1_enabled === undefined ? true : rule.worker1_enabled;
                        return (
                          <button key={String(val)}
                            onClick={() => patchRule(i, { worker1_enabled: val })}
                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                              current === val ? activeCls : "bg-gray-800/60 text-gray-600 hover:bg-gray-700"
                            }`}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {settingsField("SL", i, "worker1", "sl_pct", rule)}
                    {settingsField("Trig", i, "worker1", "trigger_pct", rule)}
                    {settingsField("Trail", i, "worker1", "trail_pct", rule)}
                    {settingsField("TP", i, "worker1", "tp_pct", rule)}
                    {settingsField("Trail Dwell", i, "worker1", "dwell_seconds", rule)}
                    {settingsField("SL Dwell", i, "worker1", "sl_dwell_seconds", rule)}
                  </div>
                  <div className="flex gap-1.5 flex-wrap mt-1.5">
                    {settingsField("Band lo", i, "worker1", "band_lo", rule)}
                    {settingsField("Band hi", i, "worker1", "band_hi", rule)}
                    {settingsField("Rev lo", i, "worker1", "reversal_lo", rule)}
                    {settingsField("Rev hi", i, "worker1", "reversal_hi", rule)}
                    {settingsField("Window", i, "worker1", "window", rule)}
                  </div>
                  <div className="mt-1.5">
                    <p className="text-gray-500 text-[9px] uppercase">Escalated SL</p>
                    <div className="flex gap-1 mt-0.5">
                      {([[null, "Leave alone"], [true, "Turn ON"], [false, "Turn OFF"]] as const).map(([val, label]) => (
                        <button key={String(val)}
                          onClick={() => patchRuleBot(i, "worker1", { escalated_sl_enabled: val })}
                          className={`text-[10px] font-bold px-2 py-1 rounded ${
                            (rule.worker1?.escalated_sl_enabled ?? null) === val
                              ? "bg-blue-500/30 text-blue-300" : "bg-gray-700/50 text-gray-500 hover:bg-gray-700"
                          }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border-l-2 border-purple-500/60 bg-purple-500/5 pl-2 py-1.5">
                  <div className="flex items-center justify-between mb-1 flex-wrap gap-1">
                    <p className="text-purple-400 text-[9px] uppercase font-bold">Hedge settings (blank = leave alone)</p>
                    <div className="flex gap-1">
                      {([[true, "ON when matched", "bg-green-500/20 text-green-400"],
                         [false, "OFF when matched", "bg-red-500/20 text-red-400"],
                         [null, "Don't change", "bg-gray-700/50 text-gray-400"]] as const).map(([val, label, activeCls]) => {
                        const current = rule.hedge_enabled === undefined ? true : rule.hedge_enabled;
                        return (
                          <button key={String(val)}
                            onClick={() => patchRule(i, { hedge_enabled: val })}
                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                              current === val ? activeCls : "bg-gray-800/60 text-gray-600 hover:bg-gray-700"
                            }`}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {settingsField("SL", i, "hedge", "sl_pct", rule)}
                    {settingsField("Trig", i, "hedge", "trigger_pct", rule)}
                    {settingsField("Trail", i, "hedge", "trail_pct", rule)}
                    {settingsField("TP", i, "hedge", "tp_pct", rule)}
                    {settingsField("Trail Dwell", i, "hedge", "dwell_seconds", rule)}
                    {settingsField("SL Dwell", i, "hedge", "sl_dwell_seconds", rule)}
                  </div>
                </div>
                <div className="rounded-lg border-l-2 border-amber-500/60 bg-amber-500/5 pl-2 py-1.5">
                  <div className="flex items-center justify-between mb-1 flex-wrap gap-1">
                    <p className="text-amber-400 text-[9px] uppercase font-bold">Worker 4 settings (blank = leave alone)</p>
                    <div className="flex gap-1">
                      {([[true, "ON when matched", "bg-green-500/20 text-green-400"],
                         [false, "OFF when matched", "bg-red-500/20 text-red-400"],
                         [null, "Don't change", "bg-gray-700/50 text-gray-400"]] as const).map(([val, label, activeCls]) => {
                        const current = rule.worker4_enabled === undefined ? true : rule.worker4_enabled;
                        return (
                          <button key={String(val)}
                            onClick={() => patchRule(i, { worker4_enabled: val })}
                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                              current === val ? activeCls : "bg-gray-800/60 text-gray-600 hover:bg-gray-700"
                            }`}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {settingsField("SL", i, "worker4", "sl_pct", rule)}
                    {settingsField("Trig", i, "worker4", "trigger_pct", rule)}
                    {settingsField("Trail", i, "worker4", "trail_pct", rule)}
                    {settingsField("TP", i, "worker4", "tp_pct", rule)}
                    {settingsField("Trail Dwell", i, "worker4", "dwell_seconds", rule)}
                    {settingsField("SL Dwell", i, "worker4", "sl_dwell_seconds", rule)}
                  </div>
                  <div className="flex gap-1.5 flex-wrap mt-1.5">
                    {settingsField("Band lo", i, "worker4", "band_lo", rule)}
                    {settingsField("Band hi", i, "worker4", "band_hi", rule)}
                    {settingsField("Rev lo", i, "worker4", "reversal_lo", rule)}
                    {settingsField("Rev hi", i, "worker4", "reversal_hi", rule)}
                    {settingsField("Window", i, "worker4", "window", rule)}
                  </div>
                  <div className="mt-1.5">
                    <p className="text-gray-500 text-[9px] uppercase">Escalated SL</p>
                    <div className="flex gap-1 mt-0.5">
                      {([[null, "Leave alone"], [true, "Turn ON"], [false, "Turn OFF"]] as const).map(([val, label]) => (
                        <button key={String(val)}
                          onClick={() => patchRuleBot(i, "worker4", { escalated_sl_enabled: val })}
                          className={`text-[10px] font-bold px-2 py-1 rounded ${
                            (rule.worker4?.escalated_sl_enabled ?? null) === val
                              ? "bg-blue-500/30 text-blue-300" : "bg-gray-700/50 text-gray-500 hover:bg-gray-700"
                          }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
          );
        });
        })()}
        {rules.length === 0 && <p className="text-gray-600 text-[11px]">No rules yet.</p>}
      </div>

      <div className="flex gap-1.5">
        <button onClick={addRule} disabled={loading}
          className="flex-1 text-xs font-bold px-2.5 py-1.5 rounded bg-gray-700/50 text-gray-300 hover:bg-gray-700 disabled:opacity-30">
          + Add rule
        </button>
        <button onClick={handleSaveRules} disabled={saving || loading}
          className="flex-1 text-xs font-bold px-2.5 py-1.5 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30">
          {saving ? "Saving…" : "Save rules"}
        </button>
      </div>
    </div>
  );
}

// ── Dashboard ───────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [loading,            setLoading]            = useState(true);
  const [surferState,        setSurferState]        = useState<any>(null);
  const [surferTrades,       setSurferTrades]       = useState<any[]>([]);
  const [surferRuns,         setSurferRuns]         = useState<any[]>([]);
  const [surferToggling,     setSurferToggling]     = useState(false);
  const [surferSellingAll,   setSurferSellingAll]   = useState(false);
  const [surferClearing,     setSurferClearing]     = useState(false);
  const [surferUsdtState,    setSurferUsdtState]    = useState<any>(null);
  const [surferUsdtTrades,   setSurferUsdtTrades]   = useState<any[]>([]);
  const [surferUsdtRuns,     setSurferUsdtRuns]     = useState<any[]>([]);
  const [surferUsdtToggling,   setSurferUsdtToggling]   = useState(false);
  const [surferUsdtSellingAll, setSurferUsdtSellingAll] = useState(false);
  const [surferUsdtClearing,   setSurferUsdtClearing]   = useState(false);
  const [htState,   setHtState]   = useState<any>(null);
  const [htTrades,  setHtTrades]  = useState<any[]>([]);
  const [htRuns,    setHtRuns]    = useState<any[]>([]);
  const [htToggling, setHtToggling] = useState(false);
  const [htClearing, setHtClearing] = useState(false);
  const [szState,   setSzState]   = useState<any>(null);
  const [szTrades,  setSzTrades]  = useState<any[]>([]);
  const [szRuns,    setSzRuns]    = useState<any[]>([]);
  const [szToggling, setSzToggling] = useState(false);
  const [szClearing, setSzClearing] = useState(false);
  const [ocoBtcPrice,  setOcoBtcPrice]  = useState<number | null>(null);
  // 2026-09-30, direct request: hedge (Worker 2) switched from BTC to SOL on the server. The
  // dashboard's unrealized %/$ math needs a price for the SAME coin the position is actually in,
  // never ocoBtcPrice -- comparing a real SOL entry (~$180) against ocoBtcPrice (~BTC's $84k)
  // is exactly what produced the +70657%/-70661% reading seen live. Worker 1 (still real BTC)
  // and the dormant Worker 3 display both keep using ocoBtcPrice unchanged; only the hedge panel
  // switches to this.
  const [hedgeCoinPrice, setHedgeCoinPrice] = useState<number | null>(null);
  const [dcaBtcState,  setDcaBtcState]  = useState<any>(null);
  const [dcaBtcTrades, setDcaBtcTrades] = useState<any[]>([]);
  const [dcaBtcRuns,   setDcaBtcRuns]   = useState<any[]>([]);
  const [initialBtcState,  setInitialBtcState]  = useState<any>(null);
  const [initialBtcTrades, setInitialBtcTrades] = useState<any[]>([]);
  const [initialBtcRuns,   setInitialBtcRuns]   = useState<any[]>([]);
  // Worker 4: exact clone of Worker 1, own sub-account, live A/B control test (2026-10-10).
  const [worker4State,  setWorker4State]  = useState<any>(null);
  const [worker4Trades, setWorker4Trades] = useState<any[]>([]);
  const [worker4Runs,   setWorker4Runs]   = useState<any[]>([]);
  const [optimalBtcState,  setOptimalBtcState]  = useState<any>(null);
  const [optimalBtcTrades, setOptimalBtcTrades] = useState<any[]>([]);
  const [optimalBtcRuns,   setOptimalBtcRuns]   = useState<any[]>([]);
  const [hedgeEnvironmentRun, setHedgeEnvironmentRun] = useState<any>(null);
  const [scheduleState, setScheduleState] = useState<any>(null);
  // LIT/USDC LIVE grid bot (2026-10-18) -- REAL MONEY, replaces Worker 4's BTC clone on the same
  // Render service/sub-account (see server/lit_grid_live.py).
  const [litGridLiveState,     setLitGridLiveState]     = useState<any>(null);
  const [litGridLiveOrders,    setLitGridLiveOrders]    = useState<any[]>([]);
  const [litGridLiveSells,     setLitGridLiveSells]     = useState<any[]>([]);
  const [litGridLiveResting,   setLitGridLiveResting]   = useState<any[]>([]);
  // True lifetime sell count, uncapped by any row fetch (2026-10-20 audit: trades/hour read
  // litGridLiveSells.length, which silently undercounted once the ledger passed that query's
  // row limit -- a count-only query never hits a wall no matter how large the ledger grows.
  const [litGridLiveSellCount, setLitGridLiveSellCount] = useState(0);
  const [litGridLiveFirstSellAt, setLitGridLiveFirstSellAt] = useState<string | null>(null);
  const [litGridWorker3FirstSellAt, setLitGridWorker3FirstSellAt] = useState<string | null>(null);
  const [litGridWorker3Fills24h, setLitGridWorker3Fills24h] = useState<any[]>([]);
  const [litGridLiveToggling,  setLitGridLiveToggling]  = useState(false);
  const [litGridLiveFlattening, setLitGridLiveFlattening] = useState(false);
  const [litGridLiveClearing, setLitGridLiveClearing] = useState(false);
  // Worker 3 twin of the LIT grid (2026-10-21, direct request) -- same bot, own sub-account/
  // tables, running alongside Worker 4 at a different spacing for a real-money A/B comparison.
  // See server/lighter_lit_grid_dual_twin.py.
  const [litGridWorker3State,     setLitGridWorker3State]     = useState<any>(null);
  const [litGridWorker3Orders,    setLitGridWorker3Orders]    = useState<any[]>([]);
  const [litGridWorker3Sells,     setLitGridWorker3Sells]     = useState<any[]>([]);
  const [litGridWorker3Resting,   setLitGridWorker3Resting]   = useState<any[]>([]);
  const [litGridWorker3SellCount, setLitGridWorker3SellCount] = useState(0);
  const [litGridWorker3Toggling,  setLitGridWorker3Toggling]  = useState(false);
  const [litGridWorker3Flattening, setLitGridWorker3Flattening] = useState(false);
  const [litGridWorker3Clearing, setLitGridWorker3Clearing] = useState(false);
  // True lifetime trade/win counts -- the trades arrays above are capped at 200 rows for
  // display purposes, which silently froze the win-rate % and trade count once any worker
  // passed 200 real trades (Worker 2 hit this first, at 606 real trades and counting).
  const [dcaBtcStats,     setDcaBtcStats]     = useState({ total: 0, wins: 0 });
  const [initialBtcStats, setInitialBtcStats] = useState({ total: 0, wins: 0 });
  const [optimalBtcStats, setOptimalBtcStats] = useState({ total: 0, wins: 0 });
  const [rsiPaperStats, setRsiPaperStats] = useState({ total: 0, wins: 0, pnlPct: 0 });

  async function load() {
    const [
      { data: surferSt },
      { data: surferTr },
      { data: surferRs },
      { data: surferUsdtSt },
      { data: surferUsdtTr },
      { data: surferUsdtRs },
      { data: htSt },
      { data: htTr },
      { data: htRs },
      { data: szSt },
      { data: szTr },
      { data: szRs },
      { data: dcaBtcSt },
      { data: dcaBtcTr },
      { data: dcaBtcRs },
      { data: initialBtcSt },
      { data: initialBtcTr },
      { data: initialBtcRs },
      { data: worker4St },
      { data: worker4Tr },
      { data: worker4Rs },
      { data: optimalBtcSt },
      { data: optimalBtcTr },
      { data: optimalBtcRs },
      { count: dcaBtcTotal },
      { count: dcaBtcWins },
      { count: initialBtcTotal },
      { count: initialBtcWins },
      { count: optimalBtcTotal },
      { count: optimalBtcWins },
      { count: rsiPaperTotal },
      { count: rsiPaperWins },
      { data: rsiPaperPnlRows },
      { data: hedgeEnvironmentRows },
      { data: scheduleSt },
      { data: litGridLiveSt },
      { count: litGridLiveSellCount },
      { data: litGridLiveOr },
      { data: litGridLiveSells },
      { data: litGridLiveResting },
      { data: litGridWorker3St },
      { count: litGridWorker3SellCount },
      { data: litGridWorker3Or },
      { data: litGridWorker3Sells },
      { data: litGridWorker3Resting },
      { data: litGridLiveFirstSell },
      { data: litGridWorker3FirstSell },
      { data: litGridWorker3Fills24h },
    ] = await Promise.all([
      getSupabase().from("surfer_state").select("*").eq("id", 1).single(),
      getSupabase().from("surfer_trades").select("*").order("exit_time", { ascending: false }).limit(5000),
      getSupabase().from("surfer_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
      getSupabase().from("surfer_usdt_state").select("*").eq("id", 1).single(),
      getSupabase().from("surfer_usdt_trades").select("*").order("exit_time", { ascending: false }).limit(5000),
      getSupabase().from("surfer_usdt_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
      getSupabase().from("sol_hypertrade_paper_state").select("*").eq("id", 1).single(),
      getSupabase().from("sol_hypertrade_paper_trades").select("*").order("exit_time", { ascending: false }).limit(5000),
      getSupabase().from("sol_hypertrade_paper_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
      getSupabase().from("solbtc_sizeconf_state").select("*").eq("id", 1).single(),
      getSupabase().from("solbtc_sizeconf_trades").select("*").order("fill_time", { ascending: false }).limit(5000),
      getSupabase().from("solbtc_sizeconf_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
      getSupabase().from("lighter_stoch_dca_btc_state").select("*").eq("id", 1).single(),
      getSupabase().from("lighter_stoch_dca_btc_trades").select("*").order("closed_at", { ascending: false }).limit(200),
      getSupabase().from("lighter_stoch_dca_btc_runs").select("*").order("ran_at", { ascending: false }).limit(50),
      getSupabase().from("lighter_btc_initial_state").select("*").eq("id", 1).single(),
      getSupabase().from("lighter_btc_initial_trades").select("*").order("closed_at", { ascending: false }).limit(200),
      getSupabase().from("lighter_btc_initial_runs").select("*").order("ran_at", { ascending: false }).limit(30),
      getSupabase().from("lighter_btc_worker4_state").select("*").eq("id", 1).single(),
      getSupabase().from("lighter_btc_worker4_trades").select("*").order("closed_at", { ascending: false }).limit(200),
      getSupabase().from("lighter_btc_worker4_runs").select("*").order("ran_at", { ascending: false }).limit(30),
      getSupabase().from("lighter_btc_optimal_state").select("*").eq("id", 1).single(),
      getSupabase().from("lighter_btc_optimal_trades").select("*").order("closed_at", { ascending: false }).limit(200),
      getSupabase().from("lighter_btc_optimal_runs").select("*").order("ran_at", { ascending: false }).limit(30),
      // True lifetime win-rate / trade-count stats -- the .limit(200) fetches above are for
      // display (recent trades list) only and silently freeze any count derived from them
      // once a worker passes 200 real trades. These use Supabase's exact-count instead of
      // fetching rows, so the number is correct however large the real total gets.
      getSupabase().from("lighter_stoch_dca_btc_trades").select("id", { count: "exact", head: true }),
      getSupabase().from("lighter_stoch_dca_btc_trades").select("id", { count: "exact", head: true }).gt("pnl_usd", 0),
      getSupabase().from("lighter_btc_initial_trades").select("id", { count: "exact", head: true }),
      getSupabase().from("lighter_btc_initial_trades").select("id", { count: "exact", head: true }).gt("pnl_usd", 0),
      getSupabase().from("lighter_btc_optimal_trades").select("id", { count: "exact", head: true }),
      getSupabase().from("lighter_btc_optimal_trades").select("id", { count: "exact", head: true }).gt("pnl_usd", 0),
      // RSI paper test (Worker 1 shadow, 2026-09-26) -- separate table, never touches real
      // money. pnl_pct rows fetched in full (volume is low, a selective signal) to sum
      // cumulative % client-side; Supabase's query builder has no SUM aggregate.
      getSupabase().from("lighter_btc_rsi_paper_trades").select("id", { count: "exact", head: true }).eq("worker_id", "worker1"),
      getSupabase().from("lighter_btc_rsi_paper_trades").select("id", { count: "exact", head: true }).eq("worker_id", "worker1").gt("pnl_pct", 0),
      getSupabase().from("lighter_btc_rsi_paper_trades").select("pnl_pct").eq("worker_id", "worker1"),
      getSupabase().from("lighter_btc_optimal_runs").select("ran_at,detail").eq("action", "environment_er").order("id", { ascending: false }).limit(1),
      getSupabase().from("bot_schedule_rules").select("*").eq("id", 1).single(),
      getSupabase().from("lighter_lit_grid_live_state").select("*").eq("id", 1).single(),
      getSupabase().from("lighter_lit_grid_live_orders").select("id", { count: "exact", head: true })
        .eq("side", "sell").not("realized_profit_usd", "is", null),
      getSupabase().from("lighter_lit_grid_live_orders").select("*").order("id", { ascending: false }).limit(50),
      getSupabase().from("lighter_lit_grid_live_orders").select("id,filled_at,filled_qty,filled_price,filled_quote,realized_profit_usd").eq("side", "sell").not("realized_profit_usd", "is", null).order("filled_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(200),
      getSupabase().from("lighter_lit_grid_live_orders").select("side,limit_price").in("status", ["open", "pending"]).limit(500),
      getSupabase().from("lighter_lit_grid_live_worker3_state").select("*").eq("id", 1).single(),
      getSupabase().from("lighter_lit_grid_live_worker3_orders").select("id", { count: "exact", head: true })
        .eq("side", "sell").not("realized_profit_usd", "is", null),
      getSupabase().from("lighter_lit_grid_live_worker3_orders").select("*").order("id", { ascending: false }).limit(50),
      getSupabase().from("lighter_lit_grid_live_worker3_orders").select("id,filled_at,filled_qty,filled_price,filled_quote,realized_profit_usd").eq("side", "sell").not("realized_profit_usd", "is", null).order("filled_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(200),
      getSupabase().from("lighter_lit_grid_live_worker3_orders").select("side,limit_price").in("status", ["open", "pending"]).limit(500),
      // First real trade ever, for the trades/hour start when no history reset is recorded --
      // the oldest of the 200 sells loaded above was only a few hours back, so 924 trades were
      // divided by those few hours (Worker 3 showed 152/hr instead of ~32, 2026-10-23).
      getSupabase().from("lighter_lit_grid_live_orders").select("filled_at").eq("side", "sell").not("realized_profit_usd", "is", null).not("filled_at", "is", null).order("filled_at", { ascending: true }).limit(1),
      getSupabase().from("lighter_lit_grid_live_worker3_orders").select("filled_at").eq("side", "sell").not("realized_profit_usd", "is", null).not("filled_at", "is", null).order("filled_at", { ascending: true }).limit(1),
      // Liquidity tracker: every Worker 3 order with a fill in the last 24h (not the transfer rows).
      getSupabase().from("lighter_lit_grid_live_worker3_orders").select("side,size,filled_qty,status,filled_at,order_kind").gte("filled_at", new Date(Date.now() - 86_400_000).toISOString()).not("filled_qty", "is", null).limit(5000),
    ]);
    setSurferState(surferSt ?? null);
    setSurferTrades(surferTr ?? []);
    setSurferRuns(surferRs ?? []);
    setSurferUsdtState(surferUsdtSt ?? null);
    setSurferUsdtTrades(surferUsdtTr ?? []);
    setSurferUsdtRuns(surferUsdtRs ?? []);
    setHtState(htSt ?? null);
    setHtTrades(htTr ?? []);
    setHtRuns(htRs ?? []);
    setSzState(szSt ?? null);
    setSzTrades(szTr ?? []);
    setSzRuns(szRs ?? []);
    setDcaBtcState(dcaBtcSt ?? null);
    setDcaBtcTrades(dcaBtcTr ?? []);
    setDcaBtcRuns(dcaBtcRs ?? []);
    setInitialBtcState(initialBtcSt ?? null);
    setInitialBtcTrades(initialBtcTr ?? []);
    setInitialBtcRuns(initialBtcRs ?? []);
    setWorker4State(worker4St ?? null);
    setWorker4Trades(worker4Tr ?? []);
    setWorker4Runs(worker4Rs ?? []);
    setOptimalBtcState(optimalBtcSt ?? null);
    setOptimalBtcTrades(optimalBtcTr ?? []);
    setOptimalBtcRuns(optimalBtcRs ?? []);
    setHedgeEnvironmentRun(hedgeEnvironmentRows?.[0] ?? null);
    setScheduleState(scheduleSt ?? null);
    setLitGridLiveState(litGridLiveSt ?? null);
    setLitGridLiveOrders(litGridLiveOr ?? []);
    setLitGridLiveSells(litGridLiveSells ?? []);
    setLitGridLiveSellCount(litGridLiveSellCount ?? 0);
    setLitGridLiveResting(litGridLiveResting ?? []);
    setLitGridWorker3State(litGridWorker3St ?? null);
    setLitGridWorker3Orders(litGridWorker3Or ?? []);
    setLitGridWorker3Sells(litGridWorker3Sells ?? []);
    setLitGridWorker3SellCount(litGridWorker3SellCount ?? 0);
    setLitGridWorker3Resting(litGridWorker3Resting ?? []);
    setLitGridLiveFirstSellAt(litGridLiveFirstSell?.[0]?.filled_at ?? null);
    setLitGridWorker3FirstSellAt(litGridWorker3FirstSell?.[0]?.filled_at ?? null);
    setLitGridWorker3Fills24h((litGridWorker3Fills24h ?? []).filter((r: any) => r.order_kind !== "transfer"));
    setDcaBtcStats({ total: dcaBtcTotal ?? 0, wins: dcaBtcWins ?? 0 });
    setInitialBtcStats({ total: initialBtcTotal ?? 0, wins: initialBtcWins ?? 0 });
    setOptimalBtcStats({ total: optimalBtcTotal ?? 0, wins: optimalBtcWins ?? 0 });
    setRsiPaperStats({
      total: rsiPaperTotal ?? 0,
      wins: rsiPaperWins ?? 0,
      pnlPct: (rsiPaperPnlRows ?? []).reduce((s: number, r: any) => s + (r.pnl_pct ?? 0), 0),
    });
    fetch("https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=1&limit=1")
      .then((r) => r.json())
      .then((ob) => {
        const bid = parseFloat(ob?.bids?.[0]?.price);
        const ask = parseFloat(ob?.asks?.[0]?.price);
        if (bid && ask) setOcoBtcPrice((bid + ask) / 2);
      })
      .catch(() => {});
    // market_id=1 -- BTC, the coin the hedge (Worker 2) trades again as of 2026-10-12 (was SOL
    // for a ~30-min test that day, was ETH/SOL/BTC on 2026-10-01 -- update this market_id every
    // time the hedge switches coins). See hedgeCoinPrice's declaration for why this must not
    // reuse ocoBtcPrice -- kept as its own fetch rather than collapsed back into ocoBtcPrice
    // specifically so this is a one-line change the next time the coin changes, not a re-wire.
    fetch("https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=1&limit=1")
      .then((r) => r.json())
      .then((ob) => {
        const bid = parseFloat(ob?.bids?.[0]?.price);
        const ask = parseFloat(ob?.asks?.[0]?.price);
        if (bid && ask) setHedgeCoinPrice((bid + ask) / 2);
      })
      .catch(() => {});
    setLoading(false);
  }

  async function handleLitGridLiveToggle() {
    const turningOn = !litGridLiveState?.enabled;
    if (turningOn && !confirm("Turn ON the LIVE LIT grid bot? This places REAL orders with REAL money.")) return;
    const secret = litGridLiveAdminSecret();
    if (!secret) return;
    setLitGridLiveToggling(true);
    const res = await fetch("/api/lighter-lit-grid-live/toggle", { method: "POST", headers: { "x-admin-secret": secret } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Failed to toggle.");
      if (res.status === 401) localStorage.removeItem("litGridLiveAdminSecret");
    }
    await load();
    setLitGridLiveToggling(false);
  }

  async function handleLitGridLiveFlatten() {
    if (!confirm("EMERGENCY FLATTEN: cancel every resting order and market-sell all held LIT back to USDC, then disable. Continue?")) return;
    const secret = litGridLiveAdminSecret();
    if (!secret) return;
    setLitGridLiveFlattening(true);
    const res = await fetch("/api/lighter-lit-grid-live/flatten", { method: "POST", headers: { "x-admin-secret": secret } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Failed to request flatten.");
      if (res.status === 401) localStorage.removeItem("litGridLiveAdminSecret");
    }
    await load();
    setLitGridLiveFlattening(false);
  }

  async function handleLitGridLiveClearHistory() {
    if (!confirm("Clear the LIVE grid bot's order ledger and reset the lifetime buy counter? Only allowed while disabled and flat.")) return;
    const secret = litGridLiveAdminSecret();
    if (!secret) return;
    setLitGridLiveClearing(true);
    const res = await fetch("/api/lighter-lit-grid-live/clear-history", { method: "POST", headers: { "x-admin-secret": secret } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Failed to clear history.");
      if (res.status === 401) localStorage.removeItem("litGridLiveAdminSecret");
    }
    await load();
    setLitGridLiveClearing(false);
  }

  async function handleLitGridWorker3Toggle() {
    const turningOn = !litGridWorker3State?.enabled;
    if (turningOn && !confirm("Turn ON the LIVE LIT grid bot (Worker 3)? This places REAL orders with REAL money.")) return;
    const secret = litGridLiveAdminSecret();
    if (!secret) return;
    setLitGridWorker3Toggling(true);
    const res = await fetch("/api/lighter-lit-grid-live-worker3/toggle", { method: "POST", headers: { "x-admin-secret": secret } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Failed to toggle.");
      if (res.status === 401) localStorage.removeItem("litGridLiveAdminSecret");
    }
    await load();
    setLitGridWorker3Toggling(false);
  }

  async function handleLitGridWorker3Flatten() {
    if (!confirm("EMERGENCY FLATTEN (Worker 3): cancel every resting order and market-sell all held LIT back to USDC, then disable. Continue?")) return;
    const secret = litGridLiveAdminSecret();
    if (!secret) return;
    setLitGridWorker3Flattening(true);
    const res = await fetch("/api/lighter-lit-grid-live-worker3/flatten", { method: "POST", headers: { "x-admin-secret": secret } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Failed to request flatten.");
      if (res.status === 401) localStorage.removeItem("litGridLiveAdminSecret");
    }
    await load();
    setLitGridWorker3Flattening(false);
  }

  async function handleLitGridWorker3ClearHistory() {
    if (!confirm("Clear Worker 3's order ledger and reset the lifetime buy counter? Only allowed while disabled and flat.")) return;
    const secret = litGridLiveAdminSecret();
    if (!secret) return;
    setLitGridWorker3Clearing(true);
    const res = await fetch("/api/lighter-lit-grid-live-worker3/clear-history", { method: "POST", headers: { "x-admin-secret": secret } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Failed to clear history.");
      if (res.status === 401) localStorage.removeItem("litGridLiveAdminSecret");
    }
    await load();
    setLitGridWorker3Clearing(false);
  }

  const [healthTick, setHealthTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setHealthTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const healthIssues: HealthIssue[] = loading ? [] : [
    checkWorkerHealth("Worker 1", initialBtcState?.enabled ?? false, initialBtcRuns, healthTick),
    checkWorkerHealth("Worker 2", optimalBtcState?.enabled ?? false, optimalBtcRuns, healthTick),
    checkWorkerHealth("Worker 3", dcaBtcState?.enabled ?? false, dcaBtcRuns, healthTick),
  ].filter((x): x is HealthIssue => x !== null);

  useEffect(() => {
    load();
    const sb = getSupabase();
    // Bots (especially the Trail chase burst) can write several times within a few seconds.
    // Without debouncing, each write fired its own full 27-query reload, and overlapping
    // in-flight reloads could resolve out of order and stomp newer data with older — that's
    // the "blink then refresh" flicker. Coalesce any burst of DB activity into one reload
    // shortly after things settle instead of one reload per individual change.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedLoad = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(load, 800);
    };
    const ch1 = sb.channel("surfer")
      .on("postgres_changes", { event: "*", schema: "public", table: "surfer_state" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "surfer_trades" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "surfer_runs" }, debouncedLoad)
      .subscribe();
    const ch2 = sb.channel("surfer-usdt")
      .on("postgres_changes", { event: "*", schema: "public", table: "surfer_usdt_state" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "surfer_usdt_trades" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "surfer_usdt_runs" }, debouncedLoad)
      .subscribe();
    const ch3 = sb.channel("sol-hypertrade-paper")
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_hypertrade_paper_state" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_hypertrade_paper_trades" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_hypertrade_paper_runs" }, debouncedLoad)
      .subscribe();
    const ch4 = sb.channel("solbtc-sizeconf")
      .on("postgres_changes", { event: "*", schema: "public", table: "solbtc_sizeconf_state" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "solbtc_sizeconf_trades" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "solbtc_sizeconf_runs" }, debouncedLoad)
      .subscribe();
    // Lighter BTC workers' runs tables aren't otherwise wired to realtime -- subscribed here
    // specifically so the health banner (below) reflects an error burst live instead of only
    // on the next manual action or full-page reload.
    const ch5 = sb.channel("lighter-btc-runs")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "lighter_btc_initial_runs" }, debouncedLoad)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "lighter_btc_worker4_runs" }, debouncedLoad)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "lighter_btc_optimal_runs" }, debouncedLoad)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "lighter_stoch_dca_btc_runs" }, debouncedLoad)
      .subscribe();
    const ch6 = sb.channel("lighter-btc-rsi-paper")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "lighter_btc_rsi_paper_trades" }, debouncedLoad)
      .subscribe();
    const ch8 = sb.channel("lighter-lit-grid-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "lighter_lit_grid_live_state" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "lighter_lit_grid_live_orders" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "lighter_lit_grid_live_worker3_state" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "lighter_lit_grid_live_worker3_orders" }, debouncedLoad)
      .subscribe();
    // The three live Lighter state tables aren't on realtime at all (every tick would fire a
    // reload -- too chatty), so a plain metrics write (live_schedule_*, live_wiggle, etc.) with
    // no accompanying trade/settings change never triggers a reload. That let the Master
    // Schedule panel's "Currently governing" box go stale between real events -- direct report,
    // a screenshot showing Worker 1 still matched to a rule its OWN live number had already
    // moved past. A plain poll bounds that staleness to ~15s without subscribing to every tick.
    const pollId = setInterval(load, 15_000);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(pollId);
      sb.removeChannel(ch1); sb.removeChannel(ch2); sb.removeChannel(ch3); sb.removeChannel(ch4); sb.removeChannel(ch5);
      sb.removeChannel(ch6); sb.removeChannel(ch8);
    };
  }, []);

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">TradeBot Dashboard</h1>
        </div>

        <MasterSchedulePanel
          scheduleState={scheduleState}
          worker1State={initialBtcState}
          hedgeLongState={optimalBtcState}
          worker4State={worker4State}
          worker1Trades={initialBtcTrades}
          hedgeLongTrades={optimalBtcTrades}
          hedgeShortTrades={dcaBtcTrades}
          worker4Trades={worker4Trades}
          loading={loading}
          onToggled={load}
        />

        {/* Worker 1 alone (2026-10-21: hedge panel removed below -- Worker 2/3's sub-accounts are
            being repurposed off the BTC hedge; the hedge backend/state fetching is left in place
            since MasterSchedulePanel still reads it and Worker 3 reuses this same account). */}
        <div className="grid grid-cols-1 gap-3 items-stretch">
          <CompactStochBtcPanel
            title="Worker 1 · Stochastic + Color-Balance Index"
            subtitle="2026-10-01 v4: enters ONLY on a fresh 25/75 stochastic signal (window 5) while the color-weighted balance index is 65-75 (each of the last 5 closed 1-min candles casts a size-weighted color vote; 100 = perfectly balanced, 0 = one color dominates) -- back to a band after a brief floor-only (70+) run showed both real losses landing above 80. Exits: SL 0.06% / TP 0.10% / profit lock at +0.06% (exits on first tick down). SL tightened from 0.10% same day after a sweep against real data: 0.06 beat 0.10 on both the full 644-trade history (+$2.41 vs +$1.80) and the live 20-trade window since the trigger change (+$0.38 vs +$0.11). A 3-stage ratchet SL (0.10->0.05->0 as the trade goes positive) was tested and rejected -- looked good on a small window, lost badly on the full history. One trade per signal; after a REVERSAL close specifically, a 2-minute cooldown before any new entry (fresh or another reversal) -- the close itself is never delayed. A GREEN position closes immediately (INDEX_EXIT) if the index leaves 65-75; a RED position is never touched by this. Self-lock, hour ban, dispersion and saving lock all OFF."
            table="lighter_btc_initial_state"
            state={initialBtcState}
            trades={initialBtcTrades.filter((t: any) =>
              t.closed_at >= (initialBtcState?.history_reset_at ?? WORKER1_RESET_AT))}
            currentPrice={ocoBtcPrice}
            loading={loading}
            onToggled={load}
            // 2026-10-01: OFF for the isolated dispersion test -- self_lock_enabled=False in
            // the live config right now, so real_trading_locked/paper_* in the DB are inert
            // leftovers the bot never reads. Showing the self-lock block anyway read as a real
            // "REAL LOCKED" badge while the bot was actually trading freely underneath it --
            // confusing, caught live. Flip back to `showSelfLock` once self-lock is re-enabled.
            combineEquityWinRate
            // 2026-10-01: hour ban OFF (trading_hours_utc=None in the live config). Pass
            // tradingHoursUtc={WORKER1_TRADING_HOURS} again when the schedule is restored.
          />
        </div>

        {/* Worker 3 twin of the LIT grid, own full-width row ABOVE Worker 4's (2026-10-21,
            direct request: real-money A/B test of two spacings, same component reused with
            its own account/table/API overrides -- see LitGridLivePanel's own props comment). */}
        <LitGridLivePanel
          state={litGridWorker3State}
          orders={litGridWorker3Orders}
          sells={litGridWorker3Sells}
          sellCount={litGridWorker3SellCount}
          firstSellAt={litGridWorker3FirstSellAt}
          resting={litGridWorker3Resting}
          loading={loading}
          enabled={litGridWorker3State?.enabled ?? false}
          onToggle={handleLitGridWorker3Toggle}
          toggling={litGridWorker3Toggling}
          onFlatten={handleLitGridWorker3Flatten}
          flattening={litGridWorker3Flattening}
          onClearHistory={handleLitGridWorker3ClearHistory}
          clearingHistory={litGridWorker3Clearing}
          apiBase="/api/lighter-lit-grid-live-worker3"
          title="LIT/USDC Grid Bot — Worker 3"
          subaccountNote="Worker 3's own sub-account, twin of Worker 4 below at a different spacing"
        />

        {/* Worker 4 merged into Worker 3 (2026-10-23); its spot now tracks LIT liquidity for Worker 3. */}
        <LitLiquidityPanel state={litGridWorker3State} fills24h={litGridWorker3Fills24h} />

      </div>
    </main>
  );
}
