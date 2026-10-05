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

// ── Surfer USDT panel ────────────────────────────────────────────────────────

function SurferUsdtPanel({
  trades, surferState, runs, loading,
  enabled, onToggle, toggling,
  onSellAll, sellingAll,
  onClearHistory, clearingHistory,
}: {
  trades: any[]; surferState: any; runs: any[]; loading: boolean;
  enabled: boolean; onToggle: () => void; toggling: boolean;
  onSellAll: () => void; sellingAll: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
}) {
  const INITIAL   = 50;
  const st        = surferState;
  const totalPnl  = st?.realized_pnl_usdt ?? 0;
  const totalTrades = st?.total_trades ?? 0;
  const wins      = st?.total_wins ?? 0;
  const losses    = totalTrades - wins;
  const winRate   = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : "—";
  const mode      = st?.mode ?? "USDT";
  const status    = st?.status ?? "idle";
  const armedSol  = st?.armed_for_sol ?? false;

  const latestPrice: number | null = (() => {
    for (const r of runs) {
      const actions: any[] = r.data?.actions ?? [];
      for (let i = actions.length - 1; i >= 0; i--) {
        const p = actions[i].price;
        if (p != null) return parseFloat(p);
      }
    }
    return null;
  })();

  const statusLabel = () => {
    if (status === "chasing_buy")  return { text: "Buying SOL…",  color: "text-blue-400" };
    if (status === "chasing_sell") return { text: "Selling SOL…", color: "text-yellow-400" };
    if (mode === "SOL") {
      return { text: "Holding SOL", color: "text-green-400" };
    }
    if (armedSol) return { text: "Armed — buy SOL", color: "text-blue-400" };
    return { text: "Holding USDT", color: "text-gray-400" };
  };

  const { text: statusText, color: statusColor } = statusLabel();
  const chartTrades = trades.map((t: any) => ({ ...t, pnl: t.pnl_usdt, exit_time: t.exit_time }));

  const entryValue   = mode === "SOL" && st?.entry_usdt  ? parseFloat(st.entry_usdt) : null;
  const currentValue = mode === "SOL" && latestPrice && st?.sol_quantity
    ? parseFloat(st.sol_quantity) * latestPrice : null;
  const openPnl      = entryValue != null && currentValue != null ? currentValue - entryValue : null;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">Surfer USDT</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">LIVE</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onClearHistory}
              disabled={clearingHistory || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before clearing" : "Delete all trade history and run logs"}
            >
              {clearingHistory ? "Clearing…" : "Clear"}
            </button>
            <button
              onClick={onSellAll}
              disabled={sellingAll || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-red-400/70 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before selling" : "Sell all SOL back to USDT"}
            >
              {sellingAll ? "Selling…" : "Sell All"}
            </button>
            <button
              onClick={onToggle}
              disabled={toggling}
              className={`flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                enabled
                  ? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${enabled ? "bg-green-400" : "bg-gray-600"}`} />
              {toggling ? "…" : enabled ? "Running" : "Paused"}
            </button>
          </div>
        </div>
        <p className="text-gray-500 text-xs">SOL/USDT · $50 · 1m · RSI(14) 15m · 12h EMA(7/25) · Filter #3</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="PnL (USDT)"
            value={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`}
            sub={`balance $${(INITIAL + totalPnl).toFixed(2)}`}
            color={totalPnl >= 0 ? "text-green-400" : "text-red-400"}
          />
          <Stat
            label="Win Rate"
            value={`${winRate}%`}
            sub={`${totalTrades} trades (${wins}W/${losses}L)`}
            color="text-blue-400"
          />
          <Stat
            label="Status"
            value={statusText}
            sub={mode === "SOL" && st?.entry_price ? `entry $${parseFloat(st.entry_price).toFixed(2)}` : "watching signal"}
            color={statusColor}
          />
          <Stat
            label="SOL/USDT"
            value={latestPrice != null ? `$${latestPrice.toFixed(2)}` : "—"}
            sub={mode === "SOL" && st?.sol_quantity ? `${parseFloat(st.sol_quantity).toFixed(2)} SOL held` : "no position"}
            color="text-yellow-400"
          />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL (USDT)</p>
        <PnLChart trades={chartTrades} initial={INITIAL} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Position</p>
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-gray-600 border-b border-gray-800">
              <th className="text-left pb-1 font-medium">Field</th>
              <th className="text-right pb-1 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Mode</td>
              <td className={`py-1.5 text-right font-bold ${statusColor}`}>{statusText}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">SOL held</td>
              <td className="py-1.5 text-right text-white">
                {mode === "SOL" && st?.sol_quantity ? `${parseFloat(st.sol_quantity).toFixed(2)} SOL` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Entry price</td>
              <td className="py-1.5 text-right text-white">
                {mode === "SOL" && st?.entry_price ? `$${parseFloat(st.entry_price).toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">USDT in</td>
              <td className="py-1.5 text-right text-white">
                {mode === "SOL" && st?.entry_usdt ? `$${parseFloat(st.entry_usdt).toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr>
              <td className="py-1.5 text-gray-400">Open PnL</td>
              <td className={`py-1.5 text-right font-bold ${
                openPnl == null ? "text-gray-600"
                : openPnl >= 0 ? "text-green-400" : "text-red-400"
              }`}>
                {openPnl != null ? `${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)}` : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Trades</p>
        {loading ? (
          <div className="animate-pulse space-y-2">
            {[...Array(3)].map((_, i) => <div key={i} className="h-8 bg-gray-800 rounded" />)}
          </div>
        ) : trades.length === 0 ? (
          <p className="text-gray-600 text-sm">No completed round trips yet</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left pb-1">Buy</th>
                  <th className="text-left pb-1">Sell</th>
                  <th className="text-right pb-1">PnL</th>
                  <th className="text-right pb-1">%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {trades.slice(0, 8).map((t: any) => {
                  const isWin = (t.pnl_usdt ?? 0) > 0;
                  return (
                    <tr key={t.id} className="hover:bg-gray-800/30">
                      <td className="py-1.5 text-gray-300">${t.entry_price ? parseFloat(t.entry_price).toFixed(2) : "—"}</td>
                      <td className="py-1.5 text-gray-300">${t.exit_price  ? parseFloat(t.exit_price).toFixed(2)  : "—"}</td>
                      <td className={`py-1.5 text-right ${isWin ? "text-green-400" : "text-red-400"}`}>
                        {isWin ? "+" : ""}${(t.pnl_usdt ?? 0).toFixed(2)}
                      </td>
                      <td className={`py-1.5 text-right ${isWin ? "text-green-400" : "text-red-400"}`}>
                        {isWin ? "+" : ""}{(t.pnl_pct ?? 0).toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Activity</p>
        <div className="h-56 overflow-y-auto space-y-0.5 font-mono text-sm pr-1">
          {runs.length === 0 && <p className="text-gray-600">No runs yet.</p>}
          {runs.map((r: any) => {
            const actions: any[] = r.data?.actions ?? [];
            const time = r.run_at
              ? new Date(r.run_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
              : "";
            return (
              <div key={r.id} className="flex gap-2 items-start">
                <span className="text-gray-600 shrink-0">{time}</span>
                <div className="flex flex-col gap-0">
                  {actions.map((a: any, i: number) => (
                    <span key={i} className={actionColor(a.action)}>{formatAction(a)}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Surfer panel ────────────────────────────────────────────────────────────

function SurferPanel({
  trades, surferState, runs, loading,
  enabled, onToggle, toggling,
  onSellAll, sellingAll,
  onClearHistory, clearingHistory,
}: {
  trades: any[]; surferState: any; runs: any[]; loading: boolean;
  enabled: boolean; onToggle: () => void; toggling: boolean;
  onSellAll: () => void; sellingAll: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
}) {
  const INITIAL_BTC  = 0;
  const st = surferState;
  const totalPnlBtc  = st?.realized_pnl_btc ?? 0;
  const totalTrades  = st?.total_trades ?? 0;
  const wins         = st?.total_wins ?? 0;
  const losses       = totalTrades - wins;
  const winRate      = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : "—";
  const mode         = st?.mode ?? "BTC";
  const status       = st?.status ?? "idle";
  const armedSol     = st?.armed_for_sol ?? false;
  const armedBtc     = st?.armed_for_btc ?? false;

  // Derive SOLBTC price + latest signal snapshot from the most recent CHECK action
  const latestCheck: any | null = (() => {
    for (const r of runs) {
      const actions: any[] = r.data?.actions ?? [];
      for (let i = actions.length - 1; i >= 0; i--) {
        if (actions[i].action === "CHECK" && actions[i].R != null) return actions[i];
      }
    }
    return null;
  })();
  const latestSolPrice: number | null = latestCheck ? parseFloat(latestCheck.R) : null;

  // Freshness: cron runs every 5min, so this bot should never go quiet for long while enabled
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const lastRunAt = runs.length > 0 ? runs[0].run_at : null;
  const minsSinceCheck = lastRunAt ? Math.floor((nowTick - new Date(lastRunAt).getTime()) / 60_000) : null;
  const freshnessText = minsSinceCheck == null ? "no data yet"
    : minsSinceCheck <= 0 ? "just now" : `${minsSinceCheck}m ago`;
  const freshnessColor = minsSinceCheck == null ? "text-gray-600"
    : minsSinceCheck <= 10 ? "text-green-400" : minsSinceCheck <= 20 ? "text-yellow-400" : "text-red-400";

  // Distance to the next signal event, so the panel proves the bot is computing correctly without
  // needing to scroll/parse the Activity log.
  const signalText: string | null = (() => {
    if (!latestCheck) return null;
    const pct = (x: number) => (x * 100).toFixed(2);
    if (latestCheck.mode === "BTC") {
      const breakoutPrice = latestCheck.H * (1 + SURFER_BUF_UP);
      return `${pct(latestCheck.R / breakoutPrice - 1)}% to breakout`;
    }
    const anchor = latestCheck.anchor, peak = latestCheck.peak ?? anchor;
    const gg = anchor ? peak / anchor - 1 : 0;
    let stopPrice: number;
    if (gg >= SURFER_ARM) stopPrice = anchor * (1 + (1 - SURFER_GIVEBACK) * gg);
    else stopPrice = latestCheck.L * (1 - SURFER_BUF_DN);
    return anchor ? `${pct(latestCheck.R / stopPrice - 1)}% above stop` : null;
  })();

  const statusLabel = () => {
    if (status === "chasing_buy")  return { text: "Buying SOL…",  color: "text-blue-400" };
    if (status === "chasing_sell") return { text: "Selling SOL…", color: "text-yellow-400" };
    if (mode === "SOL") {
      if (armedBtc) return { text: "Armed — sell SOL", color: "text-orange-400" };
      return { text: "Holding SOL", color: "text-green-400" };
    }
    if (armedSol) return { text: "Armed — buy SOL", color: "text-blue-400" };
    return { text: "Holding BTC", color: "text-gray-400" };
  };

  const { text: statusText, color: statusColor } = statusLabel();

  // Map surfer_trades for PnLChart (needs t.pnl and t.exit_time)
  const chartTrades = trades.map((t: any) => ({ ...t, pnl: t.pnl_btc }));

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      {/* Header */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">The Surfer</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">LIVE</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onClearHistory}
              disabled={clearingHistory || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before clearing" : "Delete all trade history and run logs"}
            >
              {clearingHistory ? "Clearing…" : "Clear"}
            </button>
            <button
              onClick={onSellAll}
              disabled={sellingAll || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-red-400/70 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before selling" : "Sell all SOL back to BTC"}
            >
              {sellingAll ? "Selling…" : "Sell All"}
            </button>
            <button
              onClick={onToggle}
              disabled={toggling}
              className={`flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                enabled
                  ? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${enabled ? "bg-green-400" : "bg-gray-600"}`} />
              {toggling ? "…" : enabled ? "Running" : "Paused"}
            </button>
          </div>
        </div>
        <p className="text-gray-500 text-xs">SOL/BTC · buffered rotation · 4.3d high / 36.7h low / 12.4h lag · never holds USD · 5m cron</p>
      </div>

      {/* Stats */}
      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(6)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="PnL (BTC)"
            value={`${totalPnlBtc >= 0 ? "+" : ""}${totalPnlBtc.toFixed(8)}`}
            sub={`${totalTrades} round trips`}
            color={totalPnlBtc >= 0 ? "text-green-400" : "text-red-400"}
          />
          <Stat
            label="Win Rate"
            value={`${winRate}%`}
            sub={`${totalTrades} trades (${wins}W/${losses}L)`}
            color="text-blue-400"
          />
          <Stat
            label="Status"
            value={statusText}
            sub={mode === "SOL" && st?.entry_price ? `entry ${parseFloat(st.entry_price).toFixed(8)}` : "watching signal"}
            color={statusColor}
          />
          <Stat
            label="SOLBTC"
            value={latestSolPrice != null ? latestSolPrice.toFixed(8) : "—"}
            sub={mode === "SOL" && st?.sol_quantity ? `${parseFloat(st.sol_quantity).toFixed(2)} SOL held` : "no position"}
            color="text-yellow-400"
          />
          <Stat
            label="Last Check"
            value={freshnessText}
            sub={enabled ? "cron runs every 5m" : "paused"}
            color={freshnessColor}
          />
          <Stat
            label="Signal"
            value={signalText ?? "—"}
            sub={mode === "BTC" ? "distance to entry" : "distance to stop"}
            color="text-purple-400"
          />
        </div>
      )}

      {/* PnL Chart */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL (BTC)</p>
        <PnLChart trades={chartTrades} initial={INITIAL_BTC} unit="₿" />
      </div>

      {/* Position */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Position</p>
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-gray-600 border-b border-gray-800">
              <th className="text-left pb-1 font-medium">Field</th>
              <th className="text-right pb-1 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Mode</td>
              <td className={`py-1.5 text-right font-bold ${statusColor}`}>{statusText}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">SOL held</td>
              <td className="py-1.5 text-right text-white">
                {mode === "SOL" && st?.sol_quantity ? `${parseFloat(st.sol_quantity).toFixed(2)} SOL` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Entry price</td>
              <td className="py-1.5 text-right text-white">
                {mode === "SOL" && st?.entry_price ? parseFloat(st.entry_price).toFixed(8) : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">BTC in</td>
              <td className="py-1.5 text-right text-white">
                {mode === "SOL" && st?.entry_btc ? `${parseFloat(st.entry_btc).toFixed(8)} BTC` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Est. BTC now</td>
              <td className={`py-1.5 text-right font-bold ${
                mode === "SOL" && latestSolPrice && st?.sol_quantity
                  ? parseFloat(st.sol_quantity) * latestSolPrice >= parseFloat(st.entry_btc ?? "0")
                    ? "text-green-400" : "text-red-400"
                  : "text-gray-600"
              }`}>
                {mode === "SOL" && latestSolPrice && st?.sol_quantity
                  ? `${(parseFloat(st.sol_quantity) * latestSolPrice).toFixed(8)} BTC`
                  : "—"}
              </td>
            </tr>
            <tr>
              <td className="py-1.5 text-gray-400">Chase order</td>
              <td className="py-1.5 text-right text-gray-400">
                {st?.chase_order_id
                  ? `#${st.chase_order_id} @ ${parseFloat(st.chase_price ?? "0").toFixed(8)}`
                  : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Recent Trades */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Trades</p>
        {loading ? (
          <div className="animate-pulse space-y-2">
            {[...Array(3)].map((_, i) => <div key={i} className="h-8 bg-gray-800 rounded" />)}
          </div>
        ) : trades.length === 0 ? (
          <p className="text-gray-600 text-sm">No completed round trips yet</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left pb-1">Buy</th>
                  <th className="text-left pb-1">Sell</th>
                  <th className="text-right pb-1">PnL BTC</th>
                  <th className="text-right pb-1">%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {trades.slice(0, 8).map((t: any) => {
                  const isWin = (t.pnl_btc ?? 0) > 0;
                  return (
                    <tr key={t.id} className="hover:bg-gray-800/30">
                      <td className="py-1.5 text-gray-300">{t.buy_price ? parseFloat(t.buy_price).toFixed(8) : "—"}</td>
                      <td className="py-1.5 text-gray-300">{t.sell_price ? parseFloat(t.sell_price).toFixed(8) : "—"}</td>
                      <td className={`py-1.5 text-right ${isWin ? "text-green-400" : "text-red-400"}`}>
                        {isWin ? "+" : ""}{(t.pnl_btc ?? 0).toFixed(8)}
                      </td>
                      <td className={`py-1.5 text-right ${isWin ? "text-green-400" : "text-red-400"}`}>
                        {isWin ? "+" : ""}{(t.pnl_pct ?? 0).toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Activity */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Activity</p>
        <div className="h-56 overflow-y-auto space-y-0.5 font-mono text-sm pr-1">
          {runs.length === 0 && <p className="text-gray-600">No runs yet.</p>}
          {runs.map((r: any) => {
            const actions: any[] = r.data?.actions ?? [];
            const time = r.run_at
              ? new Date(r.run_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
              : "";
            return (
              <div key={r.id} className="flex gap-2 items-start">
                <span className="text-gray-600 shrink-0">{time}</span>
                <div className="flex flex-col gap-0">
                  {actions.map((a: any, i: number) => (
                    <span key={i} className={actionColor(a.action)}>{formatAction(a)}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SolHypertradePaperPanel({
  trades, state, runs, loading,
  enabled, onToggle, toggling,
  onClearHistory, clearingHistory,
}: {
  trades: any[]; state: any; runs: any[]; loading: boolean;
  enabled: boolean; onToggle: () => void; toggling: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
}) {
  const st = state;
  const level = st?.level ?? 0;
  const positions: any[] = st?.positions ?? [];
  const totalCost = st?.total_cost ?? 0;
  const totalPnl = st?.realized_pnl_usd ?? 0;
  const totalCycles = st?.total_cycles ?? 0;
  const wins = st?.total_wins ?? 0;
  const losses = totalCycles - wins;
  const winRate = totalCycles > 0 ? (wins / totalCycles * 100).toFixed(1) : "—";
  const maxLevelEver = st?.max_level_ever ?? 0;
  const maxCostEver = st?.max_cost_ever ?? 0;
  const lastEntryPrice = st?.last_entry_price ? parseFloat(st.last_entry_price) : null;
  const tpTarget = st?.tp_target ? parseFloat(st.tp_target) : null;
  const inPosition = level > 0;

  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [liveSpreadPct, setLiveSpreadPct] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/bitfinex-price?symbol=tSOLUSD");
        const data = await res.json();
        if (!cancelled && data.bid != null) setLivePrice(data.bid);
        if (!cancelled && data.spreadPct != null) setLiveSpreadPct(data.spreadPct);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const totalSolQty = positions.reduce((s: number, p: any) => s + (p.sol_qty ?? 0), 0);
  const portfolioValue = inPosition && livePrice ? totalSolQty * livePrice : null;
  const openPnl = portfolioValue != null && totalCost > 0 ? portfolioValue - totalCost : null;
  const nextDcaPrice = lastEntryPrice != null ? lastEntryPrice * (1 - htDropPctForLevel(level + 1) / 100) : null;
  const pctToTp = tpTarget != null && portfolioValue != null && portfolioValue > 0 ? ((tpTarget / portfolioValue) - 1) * 100 : null;
  const pctToDca = nextDcaPrice != null && livePrice != null ? ((livePrice / nextDcaPrice) - 1) * 100 : null;

  // Ticking clock so workerAlive/cycleElapsedText stay fresh even when the DB row itself hasn't
  // changed in a while (otherwise these froze at whatever Date.now() was at the last re-render,
  // sometimes showing stale "worker offline" for a perfectly healthy worker).
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const cycleElapsedMs = st?.cycle_start_time ? nowTick - new Date(st.cycle_start_time).getTime() : null;
  const cycleElapsedText = cycleElapsedMs != null ? formatDurationShort(cycleElapsedMs) : null;

  const chartTrades = trades.map((t: any) => ({ ...t, pnl: t.pnl_usd, exit_time: t.exit_time }));

  const lockAge = st?.lock_heartbeat ? nowTick - new Date(st.lock_heartbeat).getTime() : null;
  const workerAlive = lockAge != null && lockAge < 30_000;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">SOL Hypertrade Live (Worker 2)</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">LIVE</span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${workerAlive ? "bg-green-500/20 text-green-400" : "bg-gray-700/40 text-gray-500"}`}>
              {workerAlive ? "worker alive" : "worker offline"}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onClearHistory}
              disabled={clearingHistory || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before clearing" : "Delete all trade history and run logs, reset state"}
            >
              {clearingHistory ? "Clearing…" : "Clear"}
            </button>
            <button
              onClick={onToggle}
              disabled={toggling}
              className={`flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                enabled
                  ? "bg-green-500/20 text-green-400 hover:bg-green-500/30"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${enabled ? "bg-green-400" : "bg-gray-600"}`} />
              {toggling ? "…" : enabled ? "Running" : "Paused"}
            </button>
          </div>
        </div>
        <p className="text-gray-500 text-xs">Continuous grid, no directional signal · always re-enters after every close · variable-rate formula: decaying size multiplier (~1.66x→1x), widening DCA gap (~8.03%→), shrinking TP target (~1.52%→0.05% floor) as levels stack · UNCAPPED depth, compounding base size capped to real wallet balance · orders + fills over WS, real bid/ask spread · LIVE · REAL MONEY · verified worst-case ~9 levels / $2,535 bare reserve per $100 base (Binance Global 5yr + Bitfinex 2yr) · deployed at 35x reserve (2 levels of margin, confirmed robust to start-date sensitivity) · ${HT_SEED_USD} seed</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="Realized PnL"
            value={`${totalPnl >= 0 ? "+" : ""}${(totalPnl / HT_SEED_USD * 100).toFixed(2)}%`}
            sub={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} on $${HT_SEED_USD} ref`}
            color={totalPnl >= 0 ? "text-green-400" : "text-red-400"}
          />
          <Stat
            label="Win Rate"
            value={`${winRate}%`}
            sub={`${totalCycles} cycles (${wins}W/${losses}L)`}
            color="text-blue-400"
          />
          <Stat
            label="Status"
            value={inPosition ? `Watching, level ${level}` : "Entering…"}
            sub={inPosition && cycleElapsedText ? `${cycleElapsedText} in this cycle — needs ${pctToTp != null ? `+${pctToTp.toFixed(2)}%` : "?"} to exit or ${pctToDca != null ? `${pctToDca.toFixed(2)}%` : "?"} to add` : "—"}
            color={inPosition ? "text-yellow-400" : "text-gray-400"}
          />
          <Stat
            label="Max depth ever"
            value={`${maxLevelEver} levels`}
            sub={`$${maxCostEver.toFixed(2)} real worst-case`}
            color="text-orange-400"
          />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Position</p>
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-gray-600 border-b border-gray-800">
              <th className="text-left pb-1 font-medium">Field</th>
              <th className="text-right pb-1 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">SOL held</td>
              <td className="py-1.5 text-right text-white">{inPosition ? `${totalSolQty.toFixed(4)} SOL` : "—"}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Last entry price</td>
              <td className="py-1.5 text-right text-white">{lastEntryPrice != null ? `$${lastEntryPrice.toFixed(4)}` : "—"}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Current price (spread)</td>
              <td className="py-1.5 text-right text-yellow-400">
                {livePrice != null ? `$${livePrice.toFixed(4)}` : "—"}
                {liveSpreadPct != null ? <span className="text-gray-500"> ({liveSpreadPct.toFixed(4)}%)</span> : null}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Next DCA trigger</td>
              <td className="py-1.5 text-right text-red-400">
                {nextDcaPrice != null ? `$${nextDcaPrice.toFixed(4)}` : "—"}
                {pctToDca != null ? <span className="text-gray-500"> ({pctToDca.toFixed(2)}% away)</span> : null}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">TP target (price)</td>
              <td className="py-1.5 text-right text-green-400">
                {tpTarget != null && totalSolQty > 0 ? `$${(tpTarget / totalSolQty).toFixed(4)}` : "—"}
                {pctToTp != null ? <span className="text-gray-500"> (+{pctToTp.toFixed(2)}% away)</span> : null}
              </td>
            </tr>
            <tr>
              <td className="py-1.5 text-gray-400">Open PnL</td>
              <td className={`py-1.5 text-right font-bold ${
                openPnl == null ? "text-gray-600" : openPnl >= 0 ? "text-green-400" : "text-red-400"
              }`}>
                {openPnl != null && totalCost > 0
                  ? `${openPnl >= 0 ? "+" : ""}${(openPnl / totalCost * 100).toFixed(2)}% (${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)})`
                  : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL ($, reference sizing)</p>
        <PnLChart trades={chartTrades} initial={HT_SEED_USD} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">DCA Legs ({positions.length} leg{positions.length === 1 ? "" : "s"})</p>
        {positions.length === 0 ? (
          <p className="text-gray-600 text-sm">No open position</p>
        ) : (
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-gray-600 border-b border-gray-800">
                <th className="text-left pb-1 font-medium">Level</th>
                <th className="text-right pb-1 font-medium">Entry $</th>
                <th className="text-right pb-1 font-medium">Size $</th>
                <th className="text-right pb-1 font-medium">SOL Qty</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p: any, i: number) => (
                <tr key={i} className="border-b border-gray-800/50">
                  <td className="py-1.5 text-gray-400">{i + 1}</td>
                  <td className="py-1.5 text-right text-white">${parseFloat(p.price).toFixed(4)}</td>
                  <td className="py-1.5 text-right text-white">${parseFloat(p.usd_size).toFixed(2)}</td>
                  <td className="py-1.5 text-right text-white">{parseFloat(p.sol_qty).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Cycles</p>
        {loading ? (
          <div className="animate-pulse space-y-2">
            {[...Array(3)].map((_, i) => <div key={i} className="h-8 bg-gray-800 rounded" />)}
          </div>
        ) : trades.length === 0 ? (
          <p className="text-gray-600 text-sm">No completed cycles yet</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left pb-1">Levels</th>
                  <th className="text-right pb-1">PnL</th>
                  <th className="text-right pb-1">%</th>
                  <th className="text-right pb-1">Held</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {trades.slice(0, 8).map((t: any) => {
                  const isWin = (t.pnl_usd ?? 0) > 0;
                  const heldMin = Math.round((t.bars_held_ms ?? 0) / 60000);
                  return (
                    <tr key={t.id} className="hover:bg-gray-800/30">
                      <td className="py-1.5 text-gray-300">{t.levels ?? "—"}</td>
                      <td className={`py-1.5 text-right ${isWin ? "text-green-400" : "text-red-400"}`}>
                        {isWin ? "+" : ""}${(t.pnl_usd ?? 0).toFixed(2)}
                      </td>
                      <td className={`py-1.5 text-right ${isWin ? "text-green-400" : "text-red-400"}`}>
                        {isWin ? "+" : ""}{(t.pnl_pct ?? 0).toFixed(2)}%
                      </td>
                      <td className="py-1.5 text-right text-gray-400">{heldMin}m</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Activity</p>
        <div className="h-56 overflow-y-auto space-y-0.5 font-mono text-sm pr-1">
          {runs.length === 0 && <p className="text-gray-600">No runs yet.</p>}
          {runs.map((r: any) => {
            const actions: any[] = r.data?.actions ?? [];
            const time = r.run_at
              ? new Date(r.run_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
              : "";
            return (
              <div key={r.id} className="flex gap-2 items-start">
                <span className="text-gray-600 shrink-0">{time}</span>
                <div className="flex flex-col gap-0">
                  {actions.map((a: any, i: number) => {
                    const color = a.action === "ENTRY" ? "text-yellow-400"
                      : a.action === "DCA" ? "text-orange-400"
                      : a.action === "EXIT" ? (a.pnlUsd >= 0 ? "text-green-400" : "text-red-400")
                      : a.action === "STATUS" ? "text-gray-500"
                      : a.action === "ERROR" ? "text-red-400"
                      : "text-gray-500";
                    const text = a.action === "ENTRY" ? `ENTRY level=1 @ $${parseFloat(a.price).toFixed(4)}  $${a.size?.toFixed?.(2) ?? a.size}`
                      : a.action === "DCA" ? `DCA level=${a.level} @ $${parseFloat(a.price).toFixed(4)}  $${a.size?.toFixed?.(2) ?? a.size}  total=$${a.totalCost?.toFixed?.(2) ?? a.totalCost}`
                      : a.action === "EXIT" ? `EXIT levels=${a.levels} @ $${parseFloat(a.price).toFixed(4)}  pnl $${a.pnlUsd?.toFixed?.(2) ?? a.pnlUsd} (${a.pnlPct?.toFixed?.(2) ?? a.pnlPct}%)`
                      : a.action === "STATUS" ? `level=${a.level}  bid=$${parseFloat(a.bid).toFixed(4)}  distToDCA=${a.distToDca?.toFixed?.(3)}%  distToTP=${a.distToTp?.toFixed?.(3)}%`
                      : a.action === "ERROR" ? `ERROR: ${a.error}`
                      : a.action;
                    return <span key={i} className={color}>{text}</span>;
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── SOL/BTC Size Confirmation panel (Worker 1, paper) ──────────────────────

function SolbtcSizeconfPanel({
  trades, state, runs, loading,
  enabled, onToggle, toggling,
  onClearHistory, clearingHistory,
}: {
  trades: any[]; state: any; runs: any[]; loading: boolean;
  enabled: boolean; onToggle: () => void; toggling: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
}) {
  const st = state;
  const btcBalance = st?.btc_balance ?? 1;
  const solQty = st?.sol_qty ?? 0;
  const side = st?.side ?? "BTC";
  const pending = st?.pending ?? null;
  const totalPnl = st?.realized_pnl_btc ?? 0;
  const totalTrades = st?.total_trades ?? 0;
  const wins = st?.total_wins ?? 0;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : "—";

  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const lockAge = st?.lock_heartbeat ? nowTick - new Date(st.lock_heartbeat).getTime() : null;
  const workerAlive = lockAge != null && lockAge < 30_000;

  const q = st?.w > 0 ? st.u / st.w : 0;
  const tinyQ = st?.wt >= 0.5 ? st.ut / st.wt : 0;
  const active = st?.active ?? false;

  const currentPrice = st?.current_minute_last_price ?? (st?.last_log_price != null ? Math.exp(st.last_log_price) : null);
  const unrealizedBtc = side === "SOL" && st?.entry_btc != null && currentPrice != null
    ? solQty * currentPrice - st.entry_btc
    : null;
  const unrealizedPct = unrealizedBtc != null && st?.entry_btc ? (unrealizedBtc / st.entry_btc) * 100 : null;

  const [btLoading, setBtLoading] = useState(false);
  const [btResult, setBtResult] = useState<any>(null);
  const [btError, setBtError] = useState<string | null>(null);
  async function handleCompareBacktest() {
    setBtLoading(true); setBtError(null);
    try {
      const res = await fetch("/api/expected-vs-actual?bot=solbtc-sizeconf");
      const data = await res.json();
      if (!data.ok) { setBtError(data.error ?? "Failed to compare."); setBtResult(null); }
      else setBtResult(data);
    } catch (e: any) {
      setBtError(String(e?.message ?? e));
    } finally {
      setBtLoading(false);
    }
  }

  const chartTrades = trades.filter((t: any) => t.pnl_btc != null).map((t: any) => ({ ...t, pnl: t.pnl_btc, exit_time: t.fill_time }));

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">SOL/BTC Size Confirmation (Worker 1)</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">PAPER</span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${workerAlive ? "bg-green-500/20 text-green-400" : "bg-gray-700/40 text-gray-500"}`}>
              {workerAlive ? "worker alive" : "worker offline"}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={handleCompareBacktest}
              disabled={btLoading}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title="Replay the exact verified engine over Bitfinex's real trade tape for this bot's actual window, and compare against what really happened"
            >
              {btLoading ? "Comparing…" : "Compare to Backtest"}
            </button>
            <button
              onClick={onClearHistory}
              disabled={clearingHistory || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before clearing" : "Delete all trade history and run logs, reset state"}
            >
              {clearingHistory ? "Clearing…" : "Clear"}
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
        <p className="text-gray-500 text-xs">Trade-tape count pressure + tiny-trade (&lt;0.1 SOL) confirmation + 30-min activity gate · PAPER ONLY · live Bitfinex trade-tape WebSocket, not polling · cost = real live bid/ask half-spread at fill time, not an assumed flat rate · verified event-for-event against the reference formula on 50,000 real batches · 1 BTC seed</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(6)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="PnL (BTC)"
            value={`${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(8)} (${totalPnl >= 0 ? "+" : ""}${(totalPnl * 100).toFixed(3)}%)`}
            sub={`${totalTrades} round trips`}
            color={totalPnl >= 0 ? "text-green-400" : "text-red-400"}
          />
          <Stat
            label="Win Rate"
            value={`${winRate}%`}
            sub={`${totalTrades} trades (${wins}W/${losses}L)`}
            color="text-blue-400"
          />
          <Stat
            label="Position"
            value={pending ? `${side}→${pending}` : side}
            sub={side === "SOL" ? `${solQty.toFixed(6)} SOL` : `${btcBalance.toFixed(8)} BTC`}
            color={side === "SOL" ? "text-green-400" : "text-gray-400"}
          />
          <Stat
            label="Pressure"
            value={q.toFixed(2)}
            sub={`tiny=${tinyQ.toFixed(2)}`}
            color={q > 0 ? "text-green-400" : q < 0 ? "text-red-400" : "text-gray-400"}
          />
          <Stat
            label="Unrealized PnL"
            value={unrealizedBtc == null ? "—" : `${unrealizedBtc >= 0 ? "+" : ""}${unrealizedBtc.toFixed(8)}`}
            sub={unrealizedPct == null ? "flat (in BTC)" : `${unrealizedPct >= 0 ? "+" : ""}${unrealizedPct.toFixed(3)}%`}
            color={unrealizedBtc == null ? "text-gray-400" : unrealizedBtc >= 0 ? "text-green-400" : "text-red-400"}
          />
          <Stat
            label="Activity Gate"
            value={active ? "active" : "inactive"}
            sub={active ? "entries allowed" : "SOL entries blocked"}
            color={active ? "text-green-400" : "text-yellow-400"}
          />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL (BTC)</p>
        <PnLChart trades={chartTrades} initial={0} unit="₿" />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Fills</p>
        {loading ? (
          <div className="animate-pulse space-y-2">
            {[...Array(3)].map((_, i) => <div key={i} className="h-8 bg-gray-800 rounded" />)}
          </div>
        ) : trades.length === 0 ? (
          <p className="text-gray-600 text-sm">No fills yet</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left pb-1">Side</th>
                  <th className="text-right pb-1">Price</th>
                  <th className="text-right pb-1">Cost</th>
                  <th className="text-right pb-1">Latency</th>
                  <th className="text-right pb-1">PnL BTC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {trades.slice(0, 8).map((t: any) => {
                  const pnl = t.pnl_btc != null ? parseFloat(t.pnl_btc) : null;
                  const entryBtcForTrip = pnl != null ? parseFloat(t.btc_after) - pnl : null;
                  const pnlPct = pnl != null && entryBtcForTrip ? (pnl / entryBtcForTrip) * 100 : null;
                  const costPct = t.cost_pct != null ? parseFloat(t.cost_pct) : null;
                  const latency = t.latency_s != null ? parseFloat(t.latency_s) : null;
                  return (
                    <tr key={t.id} className="hover:bg-gray-800/30">
                      <td className={`py-1.5 ${t.side_after === "SOL" ? "text-blue-400" : "text-orange-400"}`}>{t.side_after}</td>
                      <td className="py-1.5 text-right text-gray-300">{parseFloat(t.fill_price).toFixed(8)}</td>
                      <td className="py-1.5 text-right text-gray-500" title={costPct == null ? "flat fallback, book not ready yet" : "live measured bid/ask half-spread"}>
                        {costPct != null ? `${(costPct*100).toFixed(3)}%` : "~0.020%*"}
                      </td>
                      <td className={`py-1.5 text-right ${latency == null ? "text-gray-600" : latency < 1.0 ? "text-red-400" : "text-gray-500"}`} title="signal -> fill gap; must be >= 1s per the verified rule">
                        {latency != null ? `${latency.toFixed(2)}s` : "—"}
                      </td>
                      <td className={`py-1.5 text-right ${pnl == null ? "text-gray-600" : pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {pnl != null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(8)} (${pnl >= 0 ? "+" : ""}${pnlPct!.toFixed(3)}%)` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(btResult || btError) && (
        <div className="border-t border-gray-800 pt-4 space-y-2">
          <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Backtest Comparison</p>
          {btError ? (
            <p className="text-red-400 text-sm">{btError}</p>
          ) : (
            <div className="space-y-2">
              <p className="text-gray-600 text-xs">
                {btResult.matchedCount ?? btResult.real.trades} of {btResult.real.trades} fills match the replay exactly
                {" · "}{new Date(btResult.windowStart).toLocaleDateString()} → {new Date(btResult.windowEnd).toLocaleDateString()}
                {" · replayed via the same engine module the live worker runs, over Bitfinex's real trade tape"}
              </p>
              <div className="overflow-auto">
                <table className="w-full font-mono text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left pb-1">Side</th>
                      <th className="text-right pb-1">Price (real / backtest)</th>
                      <th className="text-right pb-1">Real time</th>
                      <th className="text-right pb-1">Δt</th>
                      <th className="text-right pb-1">Match</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {btResult.real.fills.map((f: any, i: number) => {
                      const bf = btResult.backtest.fills[i];
                      const isDivergent = btResult.rowMatches ? !btResult.rowMatches[i] : btResult.firstDivergenceIndex === i;
                      const dt = btResult.timeDeltasS?.[i];
                      return (
                        <tr key={i}>
                          <td className={`py-1.5 ${f.side === "SOL" ? "text-blue-400" : "text-orange-400"}`}>{f.side}</td>
                          <td className="py-1.5 text-right text-gray-300">
                            {f.fillPrice.toFixed(8)}{bf ? ` / ${bf.fillPrice.toFixed(8)}` : " / —"}
                          </td>
                          <td className="py-1.5 text-right text-gray-500">{new Date(f.fillTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</td>
                          <td className={`py-1.5 text-right ${dt == null ? "text-gray-700" : Math.abs(dt) > 30 ? "text-yellow-500/80" : "text-gray-500"}`} title="Positive means the real fill happened after the backtest replay's -- expected after a worker restart, which misses trades live but not in the replay">
                            {dt != null ? `${dt >= 0 ? "+" : ""}${dt.toFixed(1)}s` : "—"}
                          </td>
                          <td className="py-1.5 text-right">
                            {isDivergent
                              ? <span className="text-amber-500/80" title="Side or price differs from the replay">diverges</span>
                              : <span className="text-gray-600">✓</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {btResult.backtest.fills.slice(btResult.real.fills.length).map((f: any, i: number) => (
                      <tr key={`extra-${i}`}>
                        <td className={`py-1.5 ${f.side === "SOL" ? "text-blue-400" : "text-orange-400"}`}>{f.side}</td>
                        <td className="py-1.5 text-right text-gray-300">— / {f.fillPrice.toFixed(8)}</td>
                        <td className="py-1.5 text-right text-gray-600">backtest-only</td>
                        <td className="py-1.5 text-right text-gray-700">—</td>
                        <td className="py-1.5 text-right text-gray-700">—</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-gray-600 text-xs">Δt drift (not counted as a mismatch) is expected after a worker restart — the live bot can&apos;t backfill trades missed while it was redeploying, the replay has no such gap.</p>
            </div>
          )}
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Activity</p>
        <div className="h-56 overflow-y-auto space-y-0.5 font-mono text-sm pr-1">
          {runs.length === 0 && <p className="text-gray-600">No runs yet.</p>}
          {runs.map((r: any) => {
            const actions: any[] = r.data?.actions ?? [];
            const time = r.run_at
              ? new Date(r.run_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
              : "";
            return (
              <div key={r.id} className="flex gap-2 items-start">
                <span className="text-gray-600 shrink-0">{time}</span>
                <div className="flex flex-col gap-0">
                  {actions.map((a: any, i: number) => {
                    const color = a.action === "ERROR" ? "text-red-400" : "text-gray-500";
                    const text = a.action === "STATUS"
                      ? `WATCH  side=${a.side}  pending=${a.pending ?? "-"}  active=${a.active}  btc=${a.btcBalance?.toFixed?.(6)}  sol=${a.solQty?.toFixed?.(4)}  wsAge=${a.tradesWsAgeMs}ms`
                      : a.action === "ERROR" ? `ERROR (${a.stage}): ${a.error}`
                      : a.action;
                    return <span key={i} className={color}>{text}</span>;
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
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
  // Worker 1 manual exit levers -- same as the Worker 2 hedge panel, one row instead of two.
  const showLevers = table === "lighter_btc_initial_state";
  const [slIn, setSlIn] = useState("");
  const [trigIn, setTrigIn] = useState("");
  const [trailIn, setTrailIn] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const liveVol: number | null = state?.live_vol_pct ?? null;
  const liveZebra: number | null = state?.live_zebra_index ?? null;
  const liveCandleVolume: number | null = state?.live_candle_volume ?? null;
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
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exitMode: mode }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not switch exit mode.");
    }
    await onToggled();
    setSavingExitMode(false);
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
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stochWindow: stochWindowIn.trim() }),
    });
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
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
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
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jumpGuardEnabled: next }),
    });
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
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseMode: mode }),
    });
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
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
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
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearVolumeJump: true }),
    });
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
  // = volume_avg / wiggle (intrabar dispersion); unlike the jump guard above this is a pure
  // instant reading with no peak-tracking or pause timer -- it blocks new entries only while
  // the ratio stays above the threshold, and releases the instant it drops back down.
  const liveWiggleRatio: number | null = state?.live_volume_wiggle_ratio ?? null;
  const curWiggleLockThreshold: number | null = state?.override_volume_wiggle_lock_threshold ?? null;
  const curWiggleLockEnabled: boolean = state?.override_volume_wiggle_lock_enabled ?? true;
  const wiggleLocked = curWiggleLockEnabled && curWiggleLockThreshold != null
    && liveWiggleRatio != null && liveWiggleRatio > curWiggleLockThreshold;
  const [wiggleLockThresholdIn, setWiggleLockThresholdIn] = useState("");

  async function handleSetWiggleLockThreshold() {
    if (!wiggleLockThresholdIn.trim()) return;
    if (!confirm(`Set the volume/wiggle lock threshold to ${wiggleLockThresholdIn.trim()} for ${title}? Takes effect immediately.`)) return;
    setSavingSignal("wiggleLock");
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wiggleLock: wiggleLockThresholdIn.trim() }),
    });
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
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wiggleLockEnabled: next }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingSignal(null);
  }

  async function handleToggleSignal(key: "stochastic" | "zebra" | "flip", label: string, next: boolean) {
    if (!confirm(`Turn ${label} ${next ? "ON" : "OFF"} for ${title}? Takes effect immediately.`)) return;
    setSavingSignal(key);
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: next }),
    });
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
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volThreshold: volThresholdIn.trim() }),
    });
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
    if (Object.keys(payload).length === 0) return;
    if (!confirm(
      `Apply to ${title}?\n\n`
      + `SL      ${payload.sl ?? "(unchanged)"}%\n`
      + `Trigger ${payload.trigger ?? "(unchanged)"}%\n`
      + `Trail   ${payload.trail ?? "(unchanged)"}%\n`
      + `TP      ${payload.tp ?? "(unchanged)"}%\n`
      + `Dwell   ${payload.dwell ?? "(unchanged)"}s\n\n`
      + `Takes effect immediately, including on an open position.`
    )) return;
    setSavingSettings(true);
    const res = await fetch("/api/lighter-btc-initial-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply settings.");
    } else { setSlIn(""); setTrigIn(""); setTrailIn(""); setTpIn(""); setDwellIn(""); }
    await onToggled();
    setSavingSettings(false);
  }

  async function handleReset() {
    if (!confirm(`Reset ${title}? Rolls PnL into equity and hides trades before now -- nothing is deleted, all trades stay in the database for research. Only works while flat.`)) return;
    setResetting(true);
    const res = await fetch("/api/lighter-btc-initial-reset", { method: "POST" });
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
      const res = await fetch("/api/lighter-btc-toggle", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table }),
      });
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
    await fetch("/api/lighter-btc-close-position", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table }),
    });
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
          <p className="text-gray-500 text-[11px] leading-relaxed">{subtitle}</p>
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
          {table === "lighter_btc_initial_state" && (
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
        <div className="bg-gray-800/60 rounded-lg p-2">
          {/* Must match zebra_index_min/max in lighter_stoch_dca_btc_initial.py. */}
          <p className="text-gray-500 text-[10px] uppercase">Color-balance index (5 candles, enters at 65–75)</p>
          <p className="font-bold text-sm tabular-nums">
            <span className={liveZebra == null ? "text-gray-500"
              : liveZebra >= 65 && liveZebra <= 75 ? "text-green-400" : "text-amber-400"}>
              {liveZebra != null ? liveZebra.toFixed(0) : "—"}
            </span>
            <span className="text-[10px] font-normal text-gray-500 ml-1.5">
              {liveZebra == null ? "no reading yet"
                : liveZebra >= 65 && liveZebra <= 75 ? "IN BAND — a fresh signal can enter"
                : liveZebra < 65 ? "too trendy — no entry"
                : "too balanced/choppy — no entry"}
            </span>
          </p>
        </div>
      )}
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
              volume to wiggle (intrabar dispersion). Instant reading, no pause timer: blocks
              new entries only while the ratio stays above the threshold, releases the moment
              it drops. */}
          <div className="flex items-baseline justify-between">
            <p className="text-gray-500 text-[10px] uppercase">Volume/wiggle lock</p>
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
            Volume ÷ wiggle. Instant reading, no pause timer -- blocks new entries only while
            above the threshold, releases the moment it drops back down.
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
          {/* 2026-10-04, direct request: "publish the ER 2 hours... so I can see it" -- a
              slower-moving regime indicator (chop vs trend) than ER15. Readout only, gates
              nothing. The reading alone isn't the signal -- watch whether the direction holds
              the same across several checks over a couple hours; it flipping often means chop. */}
          <p className="text-gray-500 text-[10px] uppercase">Efficiency ratio (2h, chop vs trend)</p>
          <p className="font-bold text-sm tabular-nums">
            <span className={liveEr2h == null ? "text-gray-500"
              : liveEr2h >= 0.15 ? "text-amber-400" : "text-gray-300"}>
              {liveEr2h != null ? liveEr2h.toFixed(3) : "—"}
            </span>
            <span className="text-[10px] font-normal text-gray-500 ml-1.5">
              {liveEr2h == null ? "no reading yet"
                : `${liveEr2hDir === "long" ? "up" : liveEr2hDir === "short" ? "down" : "flat"} -- near 0 = chop, near 1 = trend`}
            </span>
          </p>
          <p className="text-gray-600 text-[9px] leading-snug mt-1">
            Watch whether the direction holds steady across several checks over a couple hours --
            that's the real signal, not any single reading.
          </p>
        </div>
      )}
      {showLevers && !loading && (
        <div className="bg-gray-800/60 rounded-lg p-2 space-y-2">
          <div className="flex items-baseline justify-between">
            <p className="text-gray-500 text-[10px] uppercase">Volatility (1-min range, 10m)</p>
            <p className="font-bold text-sm tabular-nums">
              <span className={liveVol == null ? "text-gray-500"
                : liveVol >= 0.10 ? "text-red-400"
                : liveVol >= 0.06 ? "text-amber-400" : "text-green-400"}>
                {liveVol != null ? liveVol.toFixed(4) + "%" : "—"}
              </span>
              <span className="text-[10px] font-normal text-gray-500 ml-1.5">
                {liveVol == null ? "" : liveVol >= 0.10 ? "HIGH" : liveVol >= 0.06 ? "elevated" : "calm"}
              </span>
            </p>
          </div>
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
          <div className="grid grid-cols-5 gap-1.5">
            {([["SL", slIn, setSlIn, curSl, "%"],
               ["Trigger", trigIn, setTrigIn, curTrig, "%"],
               ["Trail", trailIn, setTrailIn, curTrail, "%"],
               ["TP", tpIn, setTpIn, curTp, "%"],
               ["Dwell", dwellIn, setDwellIn, curDwell, "s"]] as const).map(([label, val, set, cur, unit]) => (
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
          <button
            onClick={handleApplySettings}
            disabled={savingSettings || loading || (!slIn.trim() && !trigIn.trim() && !trailIn.trim() && !tpIn.trim() && !dwellIn.trim())}
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

// One strategy, two real sub-accounts, one switch. 2026-09-29, direct request: the hedge bot
// is a single process (Worker 2's Render service) controlling both legs at once -- there is
// no such thing as turning on "just the long leg." This panel shows both legs combined and
// toggles both together via /api/lighter-hedge-toggle. Worker 3's own CompactStochBtcPanel
// call is left completely untouched elsewhere on the page -- this does NOT replace it, it
// replaces Worker 2's panel only. If the hedge strategy is ever abandoned, Worker 3 goes back
// to running its own original strategy standalone with its panel exactly as it already is.
function HedgeDualLegPanel({
  longState, longTrades, shortState, shortTrades, currentPrice, loading, onToggled, environmentRun, now,
}: {
  longState: any; longTrades: any[]; shortState: any; shortTrades: any[];
  environmentRun: any; now: number;
  currentPrice: number | null; loading: boolean; onToggled: () => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [closing, setClosing] = useState(false);
  // Own 1s ticker for the jump-guard countdown (2026-10-03) -- the `now` prop is healthTick,
  // shared dashboard-wide and only updated every 15s, which made the countdown look frozen.
  // Same pattern as Worker 1's panel (its own local nowTick at 1000ms).
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const enabled = longState?.enabled ?? false;
  const resetReady = longState?.side === null && shortState?.side === null
    && longState?.enabled === false && shortState?.enabled === false
    && longState?.close_requested === false && shortState?.close_requested === false;
  // The worker keeps close_requested set while it is still retrying the close, so this is a live
  // "close in flight" indicator rather than just optimistic local state.
  const closePending = (longState?.close_requested ?? false) || (shortState?.close_requested ?? false);
  // Manual exit levers. Free-text so an exact value can be typed rather than nudged -- these exist
  // to find the right exits per volatility regime by observation, before an adaptive formula is
  // committed to. Volatility ran 0.048% in the quiet hours and 0.117% at the US open the same day.
  const [slIn, setSlIn] = useState("");
  const [trigIn, setTrigIn] = useState("");
  const [trailIn, setTrailIn] = useState("");
  const [tpIn, setTpIn] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingExitMode, setSavingExitMode] = useState(false);
  const environment = environmentRun?.detail;
  const environmentAge = Math.max(now, Date.now()) / 1000 - (environment?.checked_at ?? 0);
  const environmentFresh = environment?.window === 15 && environment?.pause_below === 0.15
    && environment?.resume_at === 0.15 && environment?.vol_max_pct === 0.045
    && environment?.vol_window === 10 && environmentAge >= 0 && environmentAge <= 90;
  const environmentGreen = environmentFresh && environment?.er_allowed === true;
  const volatilityGreen = environmentFresh && environment?.vol_allowed === true;
  const liveVol: number | null = environmentFresh ? environment?.vol_pct ?? null : null;
  // Traded-volume readout (2026-10-02, "same guard for worker 2" -- step 1 of 2, display only,
  // no gating yet). Reuses the environment_er row rather than a new state column or migration.
  const liveTradedVolume: number | null = environmentFresh ? environment?.volume ?? null : null;
  const liveTradedVolumeRate: number | null = environmentFresh ? environment?.volume_rate ?? null : null;
  // 2-hour efficiency ratio (2026-10-04, direct request: "put it in both [panels], I have
  // worker 1 off for now") -- same readout as Worker 1's panel, LONG leg is the owner (already
  // has schema_has_live_signal=True), same convention as every other shared hedge readout.
  const liveEr2h: number | null = longState?.live_er_2h ?? null;
  const liveEr2hDir: string | null = longState?.live_er_2h_direction ?? null;
  // Volume-jump guard (2026-10-03, "build the same guard for worker 2" -- step 2, the actual
  // gate, same panel shape as Worker 1's). LONG leg is the live-readout owner, same convention
  // as ER15/Vol10; the override values are written identically to both legs so either leg's
  // row would show the same current settings -- longState is used for both, matching the rest
  // of this panel.
  const [savingJump, setSavingJump] = useState<string | null>(null);
  const liveJumpRatio: number | null = longState?.live_volume_jump_ratio ?? null;
  const curJumpRatio: number = longState?.override_volume_jump_ratio ?? 3.0;
  const curJumpPause: number = longState?.override_volume_jump_pause_seconds ?? 1800;
  // On/off switch -- see Worker 1's panel for the full reasoning. Both legs always carry the
  // same switch, same reason as every other guard override here.
  const curJumpGuardEnabled: boolean = longState?.override_volume_jump_enabled ?? true;

  async function handleToggleJumpGuard(next: boolean) {
    if (!confirm(`Turn the volume-jump guard ${next ? "ON" : "OFF"} for both hedge legs? Takes effect immediately.`)) return;
    setSavingJump("jumpGuardEnabled");
    const res = await fetch("/api/lighter-hedge-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jumpGuardEnabled: next }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingJump(null);
  }
  // 3-arm early release -- see Worker 1's panel for the full reasoning. "Volume" reuses the
  // existing liveTradedVolume/liveTradedVolumeRate readout above rather than new columns; only
  // wiggle is genuinely new here.
  const liveWiggle: number | null = longState?.live_wiggle ?? null;
  const curReleaseMode: string = longState?.override_volume_jump_release_mode ?? "off";
  const [savingRelease, setSavingRelease] = useState(false);
  // Release-target readout -- see Worker 1's panel for the full reasoning.
  const liveReleasePeak: number | null = longState?.live_volume_jump_release_peak ?? null;
  const releaseUnit = curReleaseMode === "volume" ? " BTC" : curReleaseMode === "rate" ? " BTC/min" : "";
  const releasePrefix = curReleaseMode === "wiggle" ? "$" : "";

  async function handleSetReleaseMode(mode: "off" | "volume" | "wiggle" | "rate") {
    if (mode === curReleaseMode) return;
    if (!confirm(`Set the volume-jump pause's early release to "${mode}" for both hedge legs? Takes effect immediately.`)) return;
    setSavingRelease(true);
    const res = await fetch("/api/lighter-hedge-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseMode: mode }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingRelease(false);
  }
  const jumpPausedUntil: Date | null = longState?.live_volume_jump_paused_until
    ? new Date(longState.live_volume_jump_paused_until) : null;
  // Optimistic clear (2026-10-03, direct report: "it does not clear") -- same fix as Worker
  // 1's panel. live_volume_jump_paused_until is written back on a 10s throttle
  // (_live_signal_persist_ts), and this panel's onToggled() reload can easily land inside that
  // gap, showing the stale still-paused value for up to ~10s. See Worker 1's panel for the
  // full reasoning.
  const [jumpClearClickedAt, setJumpClearClickedAt] = useState<number | null>(null);
  const jumpClearMasking = jumpClearClickedAt != null && nowTick - jumpClearClickedAt < 12000;
  const jumpPausedActive = !jumpClearMasking && jumpPausedUntil != null && jumpPausedUntil.getTime() > nowTick;
  const jumpSecondsLeft = jumpPausedActive ? Math.max(0, Math.round((jumpPausedUntil!.getTime() - nowTick) / 1000)) : 0;
  const [jumpRatioIn, setJumpRatioIn] = useState("");
  const [jumpPauseIn, setJumpPauseIn] = useState("");

  async function handleApplyJumpGuard() {
    if (!jumpRatioIn.trim() && !jumpPauseIn.trim()) return;
    if (!confirm(`Set the volume-jump guard to ratio ${jumpRatioIn.trim() || curJumpRatio}x / pause ${jumpPauseIn.trim() || curJumpPause}s for both hedge legs? Takes effect immediately.`)) return;
    setSavingJump("jump");
    const payload: Record<string, string> = {};
    if (jumpRatioIn.trim()) payload.jumpRatio = jumpRatioIn.trim();
    if (jumpPauseIn.trim()) payload.jumpPause = jumpPauseIn.trim();
    const res = await fetch("/api/lighter-hedge-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else {
      setJumpRatioIn(""); setJumpPauseIn("");
    }
    await onToggled();
    setSavingJump(null);
  }

  async function handleClearVolumeJump() {
    if (!confirm("Clear the current volume-jump pause for both hedge legs? A new spike will still re-arm it normally.")) return;
    setSavingJump("jumpClear");
    const res = await fetch("/api/lighter-hedge-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clearVolumeJump: true }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not clear the pause.");
    } else {
      setJumpClearClickedAt(Date.now());
    }
    await onToggled();
    setSavingJump(null);
  }

  // Volume/wiggle lock -- see Worker 1's panel for the full reasoning. Pure instant reading, no
  // peak-tracking or pause timer. LONG leg is the live-readout owner, same convention as the
  // jump guard above; overrides are written identically to both legs.
  const liveWiggleRatio: number | null = longState?.live_volume_wiggle_ratio ?? null;
  const curWiggleLockThreshold: number | null = longState?.override_volume_wiggle_lock_threshold ?? null;
  const curWiggleLockEnabled: boolean = longState?.override_volume_wiggle_lock_enabled ?? true;
  const wiggleLocked = curWiggleLockEnabled && curWiggleLockThreshold != null
    && liveWiggleRatio != null && liveWiggleRatio > curWiggleLockThreshold;
  const [wiggleLockThresholdIn, setWiggleLockThresholdIn] = useState("");
  const [savingWiggleLock, setSavingWiggleLock] = useState<string | null>(null);

  async function handleSetWiggleLockThreshold() {
    if (!wiggleLockThresholdIn.trim()) return;
    if (!confirm(`Set the volume/wiggle lock threshold to ${wiggleLockThresholdIn.trim()} for both hedge legs? Takes effect immediately.`)) return;
    setSavingWiggleLock("wiggleLock");
    const res = await fetch("/api/lighter-hedge-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wiggleLock: wiggleLockThresholdIn.trim() }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    } else {
      setWiggleLockThresholdIn("");
    }
    await onToggled();
    setSavingWiggleLock(null);
  }

  async function handleToggleWiggleLock(next: boolean) {
    if (!confirm(`Turn the volume/wiggle lock ${next ? "ON" : "OFF"} for both hedge legs? Takes effect immediately.`)) return;
    setSavingWiggleLock("wiggleLockEnabled");
    const res = await fetch("/api/lighter-hedge-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wiggleLockEnabled: next }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply the change.");
    }
    await onToggled();
    setSavingWiggleLock(null);
  }

  const curSl = longState?.override_sl_pct ?? null;
  const curTrig = longState?.override_profit_lock_trigger ?? null;
  const curTrail = longState?.override_profit_lock_trail ?? null;
  // Exit mode (2026-10-03, direct request after WORKER_2_HANDOFF.md research: "a panel where i
  // can change between trail and TP so i can test multiple strategies"). "trail" (default)
  // reproduces whatever disable_literal_tp/profit_lock_enabled were already compiled to -- SL
  // is the one protection that's active either way, never touched by this switch. "tp" is the
  // research-recommended controlled comparison: a literal TP (at curTp) becomes the only
  // winner exit and the trail is suppressed. See StochBot._exit_params's docstring.
  const curTp = longState?.override_tp_pct ?? null;
  const curExitMode: string = longState?.override_exit_mode ?? "trail";
  // Dwell -- see Worker 1's panel for the full reasoning.
  const curDwell: number = longState?.override_dwell_seconds ?? 0;
  const [dwellIn, setDwellIn] = useState("");

  async function handleSetExitMode(mode: "trail" | "tp" | "floor") {
    if (mode === curExitMode) return;
    if (!confirm(
      mode === "tp"
        ? `Switch BOTH legs to fixed-TP mode? The profit-lock trail is suppressed; only SL and the TP level close a winner. Takes effect immediately, including on an open position.`
        : mode === "floor"
        ? `Switch BOTH legs to floor mode? TP and the plain trail are both off. Until a leg's partner closes, only SL protects it; once the partner closes, a new stop arms at roughly the level that offsets the partner's loss (dwell-gated if set). Takes effect immediately, including on an open position.`
        : `Switch BOTH legs back to trail mode? Literal TP is disabled again; the profit-lock trail governs winners, same as before. Takes effect immediately, including on an open position.`
    )) return;
    setSavingExitMode(true);
    const res = await fetch("/api/lighter-hedge-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exitMode: mode }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not switch exit mode.");
    }
    await onToggled();
    setSavingExitMode(false);
  }

  async function handleApplySettings() {
    const payload: Record<string, string> = {};
    if (slIn.trim()) payload.sl = slIn.trim();
    if (trigIn.trim()) payload.trigger = trigIn.trim();
    if (trailIn.trim()) payload.trail = trailIn.trim();
    if (tpIn.trim()) payload.tp = tpIn.trim();
    if (dwellIn.trim()) payload.dwell = dwellIn.trim();
    if (Object.keys(payload).length === 0) return;
    // The route writes BOTH legs together -- unequal exits would break the breakeven floor.
    if (!confirm(
      `Apply to BOTH legs?\n\n`
      + `SL      ${payload.sl ?? "(unchanged)"}%\n`
      + `Trigger ${payload.trigger ?? "(unchanged)"}%\n`
      + `Trail   ${payload.trail ?? "(unchanged)"}%\n`
      + `TP      ${payload.tp ?? "(unchanged)"}%\n`
      + `Dwell   ${payload.dwell ?? "(unchanged)"}s\n\n`
      + `Takes effect immediately, including on an open position.`
    )) return;
    setSavingSettings(true);
    const res = await fetch("/api/lighter-hedge-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not apply settings.");
    } else { setSlIn(""); setTrigIn(""); setTrailIn(""); setTpIn(""); setDwellIn(""); }
    await onToggled();
    setSavingSettings(false);
  }

  async function handleToggle() {
    const question = enabled
      ? "Turn OFF the hedge strategy? This stops new entries on BOTH legs -- it will NOT close existing positions."
      : "Turn ON the hedge strategy? This resumes real trading on BOTH legs together.";
    if (!confirm(question)) return;
    setToggling(true);
    try {
      const res = await fetch("/api/lighter-hedge-toggle", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        alert(body?.error ?? "Could not confirm the ON/OFF change on both hedge legs. Check both legs before trying again.");
      }
      await onToggled();
    } catch {
      alert("Could not confirm the ON/OFF change. Refresh the dashboard to check both hedge legs before trying again.");
    } finally {
      setToggling(false);
    }
  }

  // Reset clears the displayed history, preserves trade rows, and carries equity forward.
  // Both legs must already be OFF and flat; errors are surfaced and the button always recovers.
  async function handleReset() {
    if (!confirm("Reset the hedge display? All trades stay saved. PnL rolls into equity. Both legs must be OFF and flat, with no close pending.")) return;
    setResetting(true);
    try {
      const res = await fetch("/api/lighter-hedge-reset", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        alert(body?.error ?? "Could not confirm the reset. Check both legs before trying again.");
      }
      await onToggled();
    } catch {
      alert("Could not confirm the reset. Refresh the dashboard and check both legs before trying again.");
    } finally {
      setResetting(false);
    }
  }

  // 2026-09-30: the missing escape hatch. The hedge pivot removed both legs' individual "Close
  // Position" buttons, and Reset refuses to run with a position open -- so an open cycle could
  // neither be closed nor reset from the dashboard. Sets close_requested on both legs; the worker
  // does the actual closing with its own credentials and clears the flag once confirmed flat.
  async function handleCloseBoth() {
    if (!confirm(
      "Close BOTH legs now? This places real market orders on both sub-accounts to flatten every "
      + "open position, and leaves the strategy disabled afterwards."
    )) return;
    setClosing(true);
    const res = await fetch("/api/lighter-hedge-close", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error || "Close failed.");
    }
    await onToggled();
    setClosing(false);
  }

  function legStats(state: any, trades: any[]) {
    const side = state?.side ?? null;
    const legs: any[] = state?.legs ?? [];
    const seedUsd = state?.seed_usd ?? 10;
    const realizedPnl = state?.realized_pnl_usd ?? 0;
    const totalNotional = legs.reduce((s, l) => s + l.usd_size, 0);
    const totalQty = legs.reduce((s, l) => s + l.usd_size / l.price, 0);
    const avgEntry = totalQty > 0 ? totalNotional / totalQty : null;
    const unrealizedPct = side && avgEntry && currentPrice
      ? (side === "long" ? (currentPrice - avgEntry) / avgEntry : (avgEntry - currentPrice) / avgEntry) * 100
      : null;
    return { side, seedUsd, realizedPnl, avgEntry, unrealizedPct };
  }
  const longLeg = legStats(longState, longTrades);
  const shortLeg = legStats(shortState, shortTrades);
  // Long leg is the pressure-bias signal owner (pressure_signal_owner=True) -- its live_k/
  // live_signal is the ONE reading both legs' sizing actually uses, see
  // _pressure_biased_leg_usd's docstring in stoch_bot_core.py.
  const liveK: number | null = longState?.live_k ?? null;
  const liveSignal: string | null = longState?.live_signal ?? null;
  // Stochastic-only entry filter: color balance remains a descriptive reading.
  const liveBalanceIdx: number | null = longState?.live_zebra_index ?? null;

  const combinedSeed = longLeg.seedUsd + shortLeg.seedUsd;
  const combinedRealized = longLeg.realizedPnl + shortLeg.realizedPnl;
  const combinedEquity = combinedSeed + combinedRealized;

  // Both legs always enter together (cycle_partner_table guarantees it -- see
  // stoch_bot_core.py), so the Nth long close and the Nth short close, sorted by their own
  // opened_at, belong to the SAME cycle even though they don't necessarily close at the same
  // moment (one leg's SL is fast, the other's trail is patient). Pairing by entry order, not
  // by matching timestamps, is what makes that reliable -- direct request: "each line has to
  // be the result of both legs... they are working together for a common goal," not shown as
  // two disconnected strategies.
  // Paired by ENTRY TIME, not by position in the list. Pairing by index (longClosed[i] with
  // shortClosed[i], truncated to the shorter list) silently dropped every unmatched leg and,
  // worse, mis-attributed PnL the moment the two legs fell out of step -- it would happily pair a
  // long from 05:05 with a short from 05:08 and print their sum as one "cycle". That is exactly
  // what happened live on 2026-09-30 (see _cycle_gate_clear_to_enter): the legs desynced, the
  // short's solo trade vanished from this list entirely, and the panel looked like trades were
  // not being recorded at all when in fact both tables were perfectly correct.
  //
  // Both legs of a real cycle are opened in the same tick, so a small tolerance is all that is
  // needed. Anything that fails to find a partner is a SOLO leg and is now shown as such rather
  // than hidden -- an unhedged leg is the single most important thing this panel can surface.
  // Direct request: show % alongside $, because the live position pills are read in % and a
  // cycle's $ figures are fractions of a cent on $10 legs. Per LEG this is the move against its
  // own entry; for the cycle it is the net $ over the capital actually at risk that cycle, so the
  // two legs' percentages stay comparable to what the open-position pills show.
  const legPct = (t: any) =>
    t == null || !t.avg_entry_price
      ? null
      : (t.side === "long"
          ? (t.exit_price - t.avg_entry_price) / t.avg_entry_price
          : (t.avg_entry_price - t.exit_price) / t.avg_entry_price) * 100;
  const legNotional = (t: any) =>
    t == null || !t.avg_entry_price ? 0 : t.avg_entry_price * (t.base_amount_btc ?? 0);
  // Hover detail for a cycle row -- direct request. Native title attribute rather than a custom
  // popover: it works on every browser, needs no state, and cannot get stuck open.
  const legDetail = (t: any, label: string) => {
    if (!t) return `${label}: (no leg)`;
    const pct = legPct(t);
    const secs = t.opened_at && t.closed_at
      ? (new Date(t.closed_at).getTime() - new Date(t.opened_at).getTime()) / 1000 : null;
    const notional = legNotional(t);
    return [
      `${label} ${t.side?.toUpperCase() ?? ""}  ${t.reason ?? ""}`,
      `  entry  ${t.avg_entry_price?.toFixed(1) ?? "?"}`,
      `  exit   ${t.exit_price?.toFixed(1) ?? "?"}`,
      `  move   ${pct != null ? (pct >= 0 ? "+" : "") + pct.toFixed(4) + "%" : "?"}`,
      `  pnl    ${t.pnl_usd >= 0 ? "+" : ""}$${t.pnl_usd?.toFixed(5) ?? "?"}  on $${notional.toFixed(2)}`,
      secs != null ? `  held   ${secs < 90 ? secs.toFixed(0) + "s" : (secs / 60).toFixed(1) + "m"}` : "",
    ].filter(Boolean).join("\n");
  };
  // Entry-feature snapshot (2026-10-01, direct request): what K, the color-balance index,
  // volatility, and dispersion read at the moment this cycle opened -- both legs enter on the
  // same market at the same instant, so either leg's snapshot represents the cycle; prefer the
  // long leg's, fall back to the short leg's. Purely descriptive, for hand-review in this
  // tooltip, drives no bot decision. Prefer a saved numeric reading from either leg; older
  // trades with no saved snapshot say so explicitly rather than hiding this whole line.
  const entryFeaturesLine = (c: any) => {
    const read = (key: string): number | undefined =>
      [c.long?.[key], c.short?.[key]].find((v) => typeof v === "number" && Number.isFinite(v));
    const k = read("entry_k"), balance = read("entry_balance_index");
    const vol = read("entry_vol_pct"), dispersion = read("entry_dispersion");
    const fmt = (v: number | undefined, suffix = "") =>
      v !== undefined ? v.toFixed(v < 10 ? 2 : 1) + suffix : "—";
    const missing = [k, balance, vol, dispersion].every((v) => v === undefined);
    return `at entry: K ${fmt(k)}  balance-idx ${fmt(balance)}  `
      + `vol ${fmt(vol, "%")}  dispersion ${fmt(dispersion, "$")}`
      + (missing ? " (no entry snapshot saved)" : "");
  };
  const cycleTooltip = (c: any) => {
    const win = c.long && c.short
      ? (c.long.pnl_usd >= c.short.pnl_usd ? "long" : "short") : null;
    const parts = [
      legDetail(c.long, win === "long" ? "WINNER  LONG " : win === "short" ? "loser   LONG " : "LONG "),
      legDetail(c.short, win === "short" ? "WINNER  SHORT" : win === "long" ? "loser   SHORT" : "SHORT"),
    ];
    const p = cyclePct(c);
    parts.push(`NET  ${c.netPnl >= 0 ? "+" : ""}$${c.netPnl.toFixed(5)}`
      + (p != null ? `  (${p >= 0 ? "+" : ""}${p.toFixed(4)}% of capital deployed)` : ""));
    const ef = entryFeaturesLine(c);
    if (ef) parts.push(ef);
    if (!c.long || !c.short) {
      parts.push(c.running ? "Partner leg still open -- cycle not finished."
                           : "NO PARTNER LEG -- this trade was unhedged.");
    }
    return parts.join("\n\n");
  };
  const cyclePct = (c: any) => {
    const cap = legNotional(c.long) + legNotional(c.short);
    return cap > 0 ? (c.netPnl / cap) * 100 : null;
  };

  const PAIR_TOLERANCE_MS = 5000;
  // A closed leg whose partner is STILL OPEN is not unhedged -- the cycle simply isn't finished.
  // The old index-based pairing hid such a row entirely until both legs closed, which read
  // correctly ("one row, waiting for the other leg"); flagging it UNHEDGED instead was wrong and
  // made the warning fire on nearly every cycle. The partner's open position lives in its state
  // row, not the trades table, so that is what gets checked here. UNHEDGED is now reserved for
  // the real thing: no partner leg ever ENTERED alongside this one.
  const stillRunning = (partnerState: any, t: any) => {
    const fet = partnerState?.first_entry_time;
    if (partnerState?.side == null || fet == null) return false;
    return Math.abs(Number(fet) - new Date(t.opened_at).getTime()) <= PAIR_TOLERANCE_MS;
  };
  const ms = (t: any) => new Date(t.opened_at).getTime();
  const byEntry = (a: any, b: any) => ms(a) - ms(b);
  const longClosed = longTrades.filter((t) => t.pnl_usd != null).sort(byEntry);
  const shortClosed = shortTrades.filter((t) => t.pnl_usd != null).sort(byEntry);

  const cycles = [];
  const usedShort = new Set<number>();
  // Pass 1: both legs stamp the SAME cycle_id at entry (the cycle barrier's release instant,
  // see schema_has_cycle_id) -- an exact id match is definitive and immune to the opened_at
  // drift a slow confirm/retry on one leg can cause, which is exactly what used to split one
  // real cycle into two unpaired rows. Older rows (pre-migration) have no cycle_id and fall
  // through to pass 2's time-proximity match, same as before.
  for (const L of longClosed) {
    if (!L.cycle_id) continue;
    const S = shortClosed.find((s) => !usedShort.has(s.id) && s.cycle_id === L.cycle_id);
    if (!S) continue;
    usedShort.add(S.id);
    cycles.push({
      key: `${L.id}-${S.id}`,
      closedAt: L.closed_at > S.closed_at ? L.closed_at : S.closed_at,
      long: L, short: S,
      netPnl: L.pnl_usd + S.pnl_usd,
    });
  }
  for (const L of longClosed) {
    if (cycles.some((c) => c.long?.id === L.id)) continue;
    let best: any = null;
    for (const S of shortClosed) {
      if (usedShort.has(S.id)) continue;
      const gap = Math.abs(ms(S) - ms(L));
      if (gap > PAIR_TOLERANCE_MS) continue;
      if (best === null || gap < Math.abs(ms(best) - ms(L))) best = S;
    }
    if (best) {
      usedShort.add(best.id);
      cycles.push({
        key: `${L.id}-${best.id}`,
        closedAt: L.closed_at > best.closed_at ? L.closed_at : best.closed_at, // whichever leg finished it
        long: L, short: best,
        netPnl: L.pnl_usd + best.pnl_usd,
      });
    } else {
      cycles.push({ key: `L${L.id}`, closedAt: L.closed_at, long: L, short: null,
                    netPnl: L.pnl_usd, running: stillRunning(shortState, L) });
    }
  }
  for (const S of shortClosed) {
    if (usedShort.has(S.id)) continue;
    cycles.push({ key: `S${S.id}`, closedAt: S.closed_at, long: null, short: S,
                  netPnl: S.pnl_usd, running: stillRunning(longState, S) });
  }
  cycles.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());
  const wins = cycles.filter((c) => c.netPnl > 0).length;
  const winRate = cycles.length > 0 ? (wins / cycles.length * 100).toFixed(0) : "—";

  function LegBadge({ label, leg }: { label: string; leg: { side: string | null; avgEntry: number | null; unrealizedPct: number | null } }) {
    return (
      <div className="bg-gray-800/60 rounded-lg p-2">
        <p className="text-gray-500 text-[10px] uppercase">{label}</p>
        <div className="flex items-center gap-1.5">
          <span className={`font-bold text-sm ${leg.side === "long" ? "text-green-400" : leg.side === "short" ? "text-amber-400" : "text-gray-400"}`}>
            {leg.side ? leg.side.toUpperCase() : "FLAT"}
          </span>
          {leg.unrealizedPct != null && (
            <span className={`text-[10px] ${leg.unrealizedPct >= 0 ? "text-green-400" : "text-red-400"}`}>
              ({leg.unrealizedPct >= 0 ? "+" : ""}{leg.unrealizedPct.toFixed(3)}%)
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 rounded-xl p-4 space-y-3">
      {/* Title + description get the FULL panel width, controls sit on their own row beneath.
          Side-by-side squeezed this (long) description into a narrow column many lines tall with
          the buttons floating in the middle of it. */}
      <div className="space-y-2.5">
        <div>
          <h3 className="text-white font-bold text-sm">Worker 2 · Hedge Strategy (2 legs)</h3>
          <p className="text-gray-500 text-[11px] leading-relaxed">
            Both legs open together: Worker 2 LONG, Worker 3 SHORT, $10 per leg. Stochastic, Z-score, ATR and Bollinger BandWidth below gate new pairs only. All OFF removes those signal filters; existing volume safeguards still apply. Exit controls apply to both legs. ER15 and Vol10 remain readings only.
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* ALWAYS rendered. It used to be hidden unless a leg's row showed a position, which
              made it disappear in precisely the case it exists for: on 2026-09-30 both rows said
              side=null while the exchange actually held 3x positions, so the one control that
              could have flattened them was not on screen. The button must reflect "flatten
              whatever is really out there", never "flatten what the bot believes it has". */}
          <button
            onClick={handleCloseBoth}
            disabled={closing || toggling || loading}
            title="Flatten every open position on BOTH sub-accounts with real market orders, then leave the strategy disabled. Checks the exchange, not the bot's own state."
            className="text-xs font-bold px-2.5 py-1 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30"
          >
            {closing || closePending ? "Closing…" : "Close Both"}
          </button>
          <button
            onClick={handleReset}
            disabled={resetting || toggling || closing || loading || !resetReady}
            title={resetReady
              ? "Clear the displayed history, keep all trades saved, and roll PnL into equity"
              : "Use Close Both and wait until both legs are OFF and flat before resetting"}
            className="text-xs font-bold px-2.5 py-1 rounded-full bg-gray-700/40 text-gray-400 hover:bg-gray-700/70 disabled:opacity-40"
          >
            {resetting ? "…" : "Reset"}
          </button>
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
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <HedgeEntryFilters settings={longState?.override_hedge_entry_filters}
              reading={environment?.entry_filters} onSaved={onToggled} />
            <div className="bg-gray-800/60 rounded-lg p-2">
              <div className="flex items-center gap-1.5">
                <p className="text-gray-500 text-[10px] uppercase">Combined Equity</p>
                <span className={`text-[8px] font-bold px-1 rounded uppercase ${combinedRealized > 0 ? "bg-green-500/20 text-green-400" : combinedRealized < 0 ? "bg-red-500/20 text-red-400" : "bg-gray-700/40 text-gray-500"}`}>
                  {combinedRealized > 0 ? "Winning" : combinedRealized < 0 ? "Losing" : "Even"}
                </span>
              </div>
              <p className={`font-bold ${combinedRealized >= 0 ? "text-green-400" : "text-red-400"}`}>
                ${combinedEquity.toFixed(2)} <span className="text-[10px] font-normal">({combinedRealized >= 0 ? "+" : ""}{(combinedRealized / combinedSeed * 100).toFixed(2)}%)</span>
              </p>
              {/* Direct request: earnings relative to capital actually AT RISK ($10 fixed per
                  leg x 2 legs = $20), not the full account seed above -- seed_usd includes
                  balance never put at risk by this strategy, so that % understates the real
                  return on what's actually deployed. */}
              <p className="text-[10px] text-gray-500">
                <span className={combinedRealized >= 0 ? "text-green-400" : "text-red-400"}>
                  {combinedRealized >= 0 ? "+" : ""}{(combinedRealized / 20 * 100).toFixed(2)}%
                </span> of $20 risked capital
              </p>
            </div>
            <div className="bg-gray-800/60 rounded-lg p-2">
              <p className="text-gray-500 text-[10px] uppercase">Win Rate (cycles)</p>
              <p className="font-bold text-blue-400">{winRate}% <span className="text-[10px] font-normal text-gray-500">({cycles.length})</span></p>
            </div>
            <LegBadge label="Long leg (Worker 2 acct)" leg={longLeg} />
            <LegBadge label="Short leg (Worker 3 acct)" leg={shortLeg} />
            <div className="bg-gray-800/60 rounded-lg p-2">
              <p className="text-gray-500 text-[10px] uppercase">Color-balance index (reading only)</p>
              <p className="font-bold text-sm tabular-nums">
                <span className={liveBalanceIdx == null ? "text-gray-500" : "text-blue-400"}>
                  {liveBalanceIdx != null ? liveBalanceIdx.toFixed(0) : "—"}
                </span>
                <span className="text-[10px] font-normal text-gray-500 ml-1.5">
                  {liveBalanceIdx == null ? "no reading yet"
                    : "entry filter off"}
                </span>
              </p>
              <div className="mt-1 space-y-1">
                <p className="font-bold text-sm tabular-nums" title="ER15: green at 0.15 or above. Uses 15 closed one-minute moves.">
                  <span className="text-gray-500 mr-1">ER15</span>
                  <span className={environmentGreen ? "text-green-400" : "text-red-400"}>
                    {environmentFresh && typeof environment?.er === "number" ? environment.er.toFixed(3) : "—"}
                  </span>
                  <span className="text-[10px] font-normal text-gray-500 ml-1.5">{!environmentFresh ? "waiting" : environmentGreen ? "green" : "red"}</span>
                </p>
                <p className="font-bold text-sm tabular-nums" title="Vol10: mean range of 10 closed one-minute candles. Green at 0.045% or below.">
                  <span className="text-gray-500 mr-1">Vol10</span>
                  <span className={volatilityGreen ? "text-green-400" : "text-red-400"}>
                    {liveVol != null ? liveVol.toFixed(4) + "%" : "—"}
                  </span>
                  <span className="text-[10px] font-normal text-gray-500 ml-1.5">{liveVol == null ? "waiting" : volatilityGreen ? "green" : "red"}</span>
                </p>
                <p className="font-bold text-sm tabular-nums text-gray-300" title="Traded volume: mean BTC size of 10 closed one-minute candles. Readout only, not gated.">
                  <span className="text-gray-500 mr-1">Volume</span>
                  {liveTradedVolume != null ? liveTradedVolume.toFixed(2) + " BTC" : "—"}
                </p>
                <p className="text-xs tabular-nums text-gray-400" title="Volume rate: change vs. one candle earlier. Readout only, not gated.">
                  <span className="text-gray-500 mr-1">Rate</span>
                  {liveTradedVolumeRate == null ? "—"
                    : (liveTradedVolumeRate >= 0 ? "+" : "") + liveTradedVolumeRate.toFixed(2) + " BTC/min"}
                </p>
                <p className="text-[10px] text-gray-400">
                  Filters OFF · readings only
                </p>
              </div>
            </div>
            <div className="bg-gray-800/60 rounded-lg p-2">
              <p className="text-gray-500 text-[10px] uppercase">Pressure Signal (stoch K — readout only, not gating)</p>
              <p className="font-bold text-sm">
                <span className={liveSignal === "long" ? "text-green-400" : liveSignal === "short" ? "text-amber-400" : "text-gray-400"}>
                  {liveK != null ? liveK.toFixed(1) : "—"}
                </span>
                <span className="text-[10px] font-normal text-gray-500 ml-1.5">
                  {/* Readout only. The legs are always $10/$10 -- pressure_bias_enabled is off
                      (2026-09-30), so this signal does NOT change either leg's size. */}
                  {liveSignal === "long" ? "leaning LONG — readout only, legs stay $10 / $10"
                    : liveSignal === "short" ? "leaning SHORT — readout only, legs stay $10 / $10"
                    : "neutral — readout only, legs stay $10 / $10"}
                </span>
              </p>
            </div>
            <div className="bg-gray-800/60 rounded-lg p-2">
              {/* 2026-10-04, direct request: "put it in both, I have worker 1 off for now" --
                  same readout as Worker 1's panel, readings only, gates nothing. Watch whether
                  the direction holds steady across several checks over a couple hours -- that's
                  the real signal, not any single reading. */}
              <p className="text-gray-500 text-[10px] uppercase">Efficiency ratio (2h, chop vs trend)</p>
              <p className="font-bold text-sm tabular-nums">
                <span className={liveEr2h == null ? "text-gray-500"
                  : liveEr2h >= 0.15 ? "text-amber-400" : "text-gray-300"}>
                  {liveEr2h != null ? liveEr2h.toFixed(3) : "—"}
                </span>
                <span className="text-[10px] font-normal text-gray-500 ml-1.5">
                  {liveEr2h == null ? "no reading yet"
                    : `${liveEr2hDir === "long" ? "up" : liveEr2hDir === "short" ? "down" : "flat"} -- near 0 = chop, near 1 = trend`}
                </span>
              </p>
            </div>
            <div className="bg-gray-800/60 rounded-lg p-2 col-span-2">
              {/* col-span-2 (2026-10-03, direct report: half the panel was empty space) -- this
                  box is the 7th item in the surrounding 2-column grid, so without it this box
                  only filled one cell and left its row's other cell blank. Worker 1's version
                  isn't in this problem at all -- it's a standalone full-width box outside any
                  grid, never squeezed into a cell to begin with.
                  2026-10-03, direct request ("build the same guard for worker 2") -- same
                  guard as Worker 1's (compute_volume_jump_ratio), same panel shape. Blocks NEW
                  paired cycles only, never an exit -- see _volume_jump_allows_cycle's docstring. */}
              <div className="flex items-baseline justify-between">
                <p className="text-gray-500 text-[10px] uppercase">Volume-jump guard</p>
                <button
                  onClick={() => handleToggleJumpGuard(!curJumpGuardEnabled)}
                  disabled={savingJump !== null || loading}
                  className={`text-[10px] font-bold px-1.5 py-0.5 rounded disabled:opacity-30 ${
                    curJumpGuardEnabled ? "bg-blue-500/20 text-blue-300" : "bg-gray-700/50 text-gray-500"
                  }`}
                >
                  {savingJump === "jumpGuardEnabled" ? "…" : curJumpGuardEnabled ? "ON" : "OFF"}
                </button>
              </div>
              <p className="font-bold text-sm tabular-nums">
                <span className={!curJumpGuardEnabled ? "text-gray-500" : jumpPausedActive ? "text-red-400" : "text-green-400"}>
                  {!curJumpGuardEnabled ? "OFF" : jumpPausedActive ? "PAUSED" : "ARMED, not paused"}
                </span>
                <span className="text-[10px] font-normal text-gray-500 ml-1.5">
                  {!curJumpGuardEnabled ? "switch is off -- never blocks"
                    : jumpPausedActive
                    ? `new cycles blocked -- clears in ${Math.floor(jumpSecondsLeft / 60)}:${String(jumpSecondsLeft % 60).padStart(2, "0")}`
                    : "new cycles allowed"}
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
                  disabled={savingJump !== null || loading}
                  className="mt-1 text-xs font-bold px-2.5 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-30"
                >
                  {savingJump === "jumpClear" ? "…" : "Clear pause now"}
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
                    {liveTradedVolume != null ? liveTradedVolume.toFixed(2) + " BTC" : "—"}
                  </div>
                  <div className={curReleaseMode === "wiggle" ? "text-blue-300" : "text-gray-400"}>
                    <p className="text-gray-500 text-[9px] uppercase">Wiggle</p>
                    {liveWiggle != null ? "$" + liveWiggle.toFixed(2) : "—"}
                  </div>
                  <div className={curReleaseMode === "rate" ? "text-blue-300" : "text-gray-400"}>
                    <p className="text-gray-500 text-[9px] uppercase">Rate</p>
                    {liveTradedVolumeRate != null ? (liveTradedVolumeRate >= 0 ? "+" : "") + liveTradedVolumeRate.toFixed(2) + "/min" : "—"}
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
                  disabled={savingJump !== null || loading || (!jumpRatioIn.trim() && !jumpPauseIn.trim())}
                  className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30"
                >
                  {savingJump === "jump" ? "…" : "Set"}
                </button>
              </div>
            </div>
            <div className="bg-gray-800/60 rounded-lg p-2 col-span-2">
              {/* 2026-10-03, direct request after a live "market manipulation" concern -- ratio
                  of volume to wiggle (intrabar dispersion), same mechanism as Worker 1's panel.
                  Instant reading, no pause timer: blocks new paired cycles only while the ratio
                  stays above the threshold, releases the moment it drops. */}
              <div className="flex items-baseline justify-between">
                <p className="text-gray-500 text-[10px] uppercase">Volume/wiggle lock (both legs)</p>
                <button
                  onClick={() => handleToggleWiggleLock(!curWiggleLockEnabled)}
                  disabled={savingWiggleLock !== null || loading}
                  className={`text-[10px] font-bold px-1.5 py-0.5 rounded disabled:opacity-30 ${
                    curWiggleLockEnabled ? "bg-blue-500/20 text-blue-300" : "bg-gray-700/50 text-gray-500"
                  }`}
                >
                  {savingWiggleLock === "wiggleLockEnabled" ? "…" : curWiggleLockEnabled ? "ON" : "OFF"}
                </button>
              </div>
              <p className="font-bold text-sm tabular-nums">
                <span className={!curWiggleLockEnabled ? "text-gray-500" : wiggleLocked ? "text-red-400" : "text-green-400"}>
                  {!curWiggleLockEnabled ? "OFF" : wiggleLocked ? "LOCKED" : "not locked"}
                </span>
                <span className="text-[10px] font-normal text-gray-500 ml-1.5">
                  {curWiggleLockEnabled ? (wiggleLocked ? "new cycles blocked" : "new cycles allowed") : "switch is off -- never blocks"}
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
                  disabled={savingWiggleLock !== null || loading || !wiggleLockThresholdIn.trim()}
                  className="text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30 whitespace-nowrap"
                >
                  {savingWiggleLock === "wiggleLock" ? "…" : "Set"}
                </button>
              </div>
              <p className="text-gray-600 text-[9px] leading-snug mt-1">
                Volume ÷ wiggle. Instant reading, no pause timer -- blocks new paired cycles only
                while above the threshold, releases the moment it drops back down.
              </p>
            </div>
          </div>
          {/* Manual exit settings; environment readings are together above. */}
          <div className="bg-gray-800/60 rounded-lg p-2 space-y-2">
            <p className="text-gray-500 text-[10px] uppercase">Exit settings (both legs)</p>
            <div>
              <p className="text-gray-500 text-[9px] uppercase">
                Exit mode <span className="text-gray-600">now {curExitMode}</span>
              </p>
              <div className="grid grid-cols-3 gap-1 mt-1">
                {(["trail", "tp", "floor"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => handleSetExitMode(mode)}
                    disabled={savingExitMode || loading}
                    className={`text-[11px] font-bold px-1.5 py-1.5 rounded capitalize disabled:opacity-30 ${
                      curExitMode === mode ? "bg-blue-500/30 text-blue-300" : "bg-gray-700/50 text-gray-500 hover:bg-gray-700"
                    }`}
                  >
                    {mode === "tp" ? "Fixed TP" : mode === "floor" ? "Floor" : "Trail"}
                  </button>
                ))}
              </div>
              <p className="text-gray-600 text-[9px] leading-snug mt-1">
                Trail: the profit-lock trigger/trail below governs winners (current behavior).
                Fixed TP: the trail is suppressed -- only SL and the TP level below close a
                winner, per the WORKER_2_HANDOFF.md research candidate. Floor: TP and the trail
                are both off -- only SL protects until this leg's partner closes, then a new
                stop arms near the level that offsets the partner's loss (the dwell box below
                can delay that new stop; it never delays TP or SL). SL always stays active.
              </p>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {([["SL", slIn, setSlIn, curSl, "%"],
                 ["Trigger", trigIn, setTrigIn, curTrig, "%"],
                 ["Trail", trailIn, setTrailIn, curTrail, "%"],
                 ["TP", tpIn, setTpIn, curTp, "%"],
                 ["Dwell", dwellIn, setDwellIn, curDwell, "s"]] as const).map(([label, val, set, cur, unit]) => (
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
            <button
              onClick={handleApplySettings}
              disabled={savingSettings || loading || (!slIn.trim() && !trigIn.trim() && !trailIn.trim() && !tpIn.trim() && !dwellIn.trim())}
              className="w-full text-xs font-bold px-2.5 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-30"
            >
              {savingSettings ? "Applying…" : "Apply to both legs"}
            </button>
            <p className="text-gray-600 text-[9px] leading-snug">
              Leave a box blank to keep it. Applies to BOTH legs at once and takes effect
              immediately, including on an open position — stop the bot first if you'd rather it
              only affect the next cycle. Dwell: the trail's pullback (Trail mode) or the armed
              floor (Floor mode) must hold for this many seconds before it closes -- 0 = instant.
              Never applies to TP (take it the instant it's reached) or SL. Research found it
              cuts whipsaw but hasn't beaten plain no-dwell yet -- see WORKER_2_HANDOFF.md follow-up.
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-gray-500 text-[10px] uppercase">Recent cycles (net of both legs)</p>
            <div className="max-h-72 overflow-y-auto space-y-1 pr-0.5">
              {cycles.slice(0, 20).map((c) => {
                const timeLabel = c.closedAt
                  ? new Intl.DateTimeFormat("en-US", {
                      timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true,
                    }).format(new Date(c.closedAt))
                  : null;
                return (
                  <div key={c.key} title={cycleTooltip(c)}
                       className="flex items-center justify-between text-[11px] bg-gray-800/50 rounded px-1.5 py-1 cursor-help hover:bg-gray-800">
                    {timeLabel && <span className="text-gray-600 tabular-nums shrink-0">{timeLabel}</span>}
                    <span className="text-gray-400 truncate">
                      {c.long && c.short ? (
                        <>
                          <span className="text-green-400">
                            L·{shortReason(c.long.reason)}
                            <span className="text-gray-500"> {legPct(c.long)!.toFixed(3)}%</span>
                          </span>
                          {" / "}
                          <span className="text-amber-400">
                            S·{shortReason(c.short.reason)}
                            <span className="text-gray-500"> {legPct(c.short)!.toFixed(3)}%</span>
                          </span>
                        </>
                      ) : c.running ? (
                        // Partner is still open: the cycle is in flight, not unhedged.
                        <>
                          <span className="text-gray-500">⏳ </span>
                          {c.long
                            ? <><span className="text-green-400">L·{shortReason(c.long.reason)}<span className="text-gray-500"> {legPct(c.long)!.toFixed(3)}%</span></span><span className="text-gray-500"> / short still running</span></>
                            : <><span className="text-amber-400">S·{shortReason(c.short.reason)}<span className="text-gray-500"> {legPct(c.short)!.toFixed(3)}%</span></span><span className="text-gray-500"> / long still running</span></>}
                        </>
                      ) : (
                        // No partner leg ever entered alongside this one -- a genuinely naked
                        // directional bet. Called out loudly; this is the real warning.
                        <>
                          <span className="text-red-400 font-bold">UNHEDGED</span>
                          {" "}
                          {c.long
                            ? <span className="text-green-400">L·{shortReason(c.long.reason)}<span className="text-gray-500"> {legPct(c.long)!.toFixed(3)}%</span> (no short leg)</span>
                            : <span className="text-amber-400">S·{shortReason(c.short.reason)}<span className="text-gray-500"> {legPct(c.short)!.toFixed(3)}%</span> (no long leg)</span>}
                        </>
                      )}
                    </span>
                    <span className={`font-semibold shrink-0 tabular-nums ${c.netPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {cyclePct(c) != null && (
                        <span className="mr-1.5">{cyclePct(c)! >= 0 ? "+" : ""}{cyclePct(c)!.toFixed(3)}%</span>
                      )}
                      <span className="text-[10px] opacity-70">
                        {c.netPnl >= 0 ? "+" : ""}${c.netPnl.toFixed(3)}
                      </span>
                    </span>
                  </div>
                );
              })}
              {cycles.length === 0 && <p className="text-gray-600 text-[11px]">No completed cycles yet.</p>}
            </div>
          </div>
        </>
      )}
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
  // Per-bot ON/OFF switch, independent of that bot having a settings object on the same rule --
  // direct request: "maybe with this rule I want 1 on and the other off... I need a little
  // switch". Default true (both run) -- see normalizeRuleForSave / StochBot._apply_schedule_rules.
  worker1_enabled: true, hedge_enabled: true,
  worker1: { sl_pct: null, trigger_pct: null, trail_pct: null, tp_pct: null, dwell_seconds: null,
             band_lo: null, band_hi: null, reversal_lo: null, reversal_hi: null, window: null },
  hedge: { sl_pct: null, trigger_pct: null, trail_pct: null, tp_pct: null, dwell_seconds: null },
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
] as const;
const BOT_NUMERIC_FIELDS = [
  "sl_pct", "trigger_pct", "trail_pct", "tp_pct", "dwell_seconds",
  "band_lo", "band_hi", "reversal_lo", "reversal_hi", "window",
] as const;

function normalizeRuleForSave(rule: any): any {
  const out: any = {};
  for (const key of RULE_NUMERIC_FIELDS) out[key] = numOrNull(rule[key]);
  out.worker1_enabled = rule.worker1_enabled !== false;
  out.hedge_enabled = rule.hedge_enabled !== false;
  for (const bot of ["worker1", "hedge"] as const) {
    const botOut: any = {};
    for (const key of BOT_NUMERIC_FIELDS) {
      if (bot === "hedge" && !["sl_pct", "trigger_pct", "trail_pct", "tp_pct", "dwell_seconds"].includes(key)) continue;
      botOut[key] = numOrNull(rule[bot]?.[key]);
    }
    out[bot] = botOut;
  }
  return out;
}

function MasterSchedulePanel({
  scheduleState, worker1State, hedgeLongState, loading, onToggled,
}: {
  scheduleState: any; worker1State: any; hedgeLongState: any; loading: boolean; onToggled: () => void;
}) {
  const [rules, setRules] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingBoth, setTogglingBoth] = useState(false);
  const loadedOnce = useRef(false);

  useEffect(() => {
    if (!loadedOnce.current && scheduleState) {
      setRules(Array.isArray(scheduleState.rules) ? scheduleState.rules : []);
      loadedOnce.current = true;
    }
  }, [scheduleState]);

  const scheduleEnabled: boolean = scheduleState?.enabled ?? false;
  const worker1On = worker1State?.enabled ?? false;
  const hedgeOn = hedgeLongState?.enabled ?? false;

  async function postSchedule(body: Record<string, unknown>) {
    const res = await fetch("/api/bot-schedule", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      alert(b.error || "Could not save.");
      return false;
    }
    return true;
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
    const ok = await postSchedule({ rules: rules.map(normalizeRuleForSave) });
    if (ok) await onToggled();
    setSaving(false);
  }

  async function handleBothOn() {
    if (!confirm("Turn BOTH Worker 1 and the hedge ON?")) return;
    setTogglingBoth(true);
    const calls = [];
    if (!worker1On) calls.push(fetch("/api/lighter-btc-toggle", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "lighter_btc_initial_state" }),
    }));
    if (!hedgeOn) calls.push(fetch("/api/lighter-hedge-toggle", { method: "POST" }));
    await Promise.all(calls);
    await onToggled();
    setTogglingBoth(false);
  }

  async function handleBothOff() {
    if (!confirm("Turn BOTH Worker 1 and the hedge OFF? This only blocks new entries, it never closes an open position.")) return;
    setTogglingBoth(true);
    const calls = [];
    if (worker1On) calls.push(fetch("/api/lighter-btc-toggle", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "lighter_btc_initial_state" }),
    }));
    if (hedgeOn) calls.push(fetch("/api/lighter-hedge-toggle", { method: "POST" }));
    await Promise.all(calls);
    await onToggled();
    setTogglingBoth(false);
  }

  function addRule() {
    setRules((r) => [...r, JSON.parse(JSON.stringify(EMPTY_RULE))]);
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
  function patchRuleBot(i: number, bot: "worker1" | "hedge", patch: Record<string, unknown>) {
    setRules((r) => r.map((rule, idx) => (idx === i ? { ...rule, [bot]: { ...rule[bot], ...patch } } : rule)));
  }

  const liveEr = worker1State?.live_er_2h ?? null;
  const liveVolume = worker1State?.live_candle_volume ?? null;
  const liveWiggle = worker1State?.live_wiggle ?? null;
  const liveRate = worker1State?.live_volume_jump_rate ?? null;
  const liveVolWiggleRatio = worker1State?.live_volume_wiggle_ratio ?? null;
  // Volume x wiggle PRODUCT (2026-10-04, direct request: "volume and wiggle product can be a
  // filter as well"). No new live column -- same two numbers already shown above, multiplied
  // client-side; the backend computes the same product independently at rule-evaluation time
  // (StochBot._apply_schedule_rules), never from this display value.
  const liveVolWiggleProduct = liveVolume != null && liveWiggle != null ? liveVolume * liveWiggle : null;

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

  const settingsField = (label: string, i: number, bot: "worker1" | "hedge", key: string, rule: any) => (
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
            {togglingBoth ? "…" : "Both ON"}
          </button>
          <button onClick={handleBothOff} disabled={togglingBoth || loading}
            className="text-xs font-bold px-2.5 py-1 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-40">
            {togglingBoth ? "…" : "Both OFF"}
          </button>
        </div>
      </div>
      <p className="text-gray-600 text-[10px] leading-snug">
        Controls Worker 1 and the hedge together. When the schedule below is ON, the first rule
        whose hour range and/or ER/volume/wiggle/rate conditions match applies its settings AND
        turns that bot ON -- no match turns it OFF. This overrides the plain ON/OFF buttons and
        manual SL/Trigger/Trail/etc. boxes every ~30s for as long as the schedule is on, even if
        you click something manually in between. Never closes a position already open, only
        blocks/allows new entries, same as every other ON/OFF switch here.
      </p>

      <div className="bg-gray-800/60 rounded-lg p-2 flex items-center justify-between">
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

      <div className="bg-gray-800/60 rounded-lg p-2">
        <p className="text-gray-500 text-[10px] uppercase mb-1">Live readings (Worker 1's feed)</p>
        <div className="grid grid-cols-4 gap-1.5 text-[10px] tabular-nums">
          <div><p className="text-gray-600 text-[9px] uppercase">ER 2h</p>{liveEr != null ? liveEr.toFixed(3) : "—"}</div>
          <div><p className="text-gray-600 text-[9px] uppercase">Volume</p>{liveVolume != null ? liveVolume.toFixed(2) : "—"}</div>
          <div><p className="text-gray-600 text-[9px] uppercase">Wiggle</p>{liveWiggle != null ? liveWiggle.toFixed(2) : "—"}</div>
          <div><p className="text-gray-600 text-[9px] uppercase">Rate</p>{liveRate != null ? liveRate.toFixed(2) : "—"}</div>
          <div><p className="text-gray-600 text-[9px] uppercase">Vol/Wiggle</p>{liveVolWiggleRatio != null ? liveVolWiggleRatio.toFixed(3) : "—"}</div>
          <div><p className="text-gray-600 text-[9px] uppercase">Vol×Wiggle</p>{liveVolWiggleProduct != null ? liveVolWiggleProduct.toFixed(1) : "—"}</div>
        </div>
      </div>

      <div className="space-y-1.5">
        {rules.map((rule, i) => (
          <div key={i} className="bg-gray-800/60 rounded-lg p-2">
            <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpanded(expanded === i ? null : i)}>
              <p className="text-xs font-bold text-white">
                Rule {i + 1}
                <span className={`ml-1.5 text-[9px] font-bold px-1 rounded ${rule.worker1_enabled !== false ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                  W1 {rule.worker1_enabled !== false ? "ON" : "OFF"}
                </span>
                <span className={`ml-1 text-[9px] font-bold px-1 rounded ${rule.hedge_enabled !== false ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                  Hedge {rule.hedge_enabled !== false ? "ON" : "OFF"}
                </span>
                <span className="text-[10px] font-normal text-gray-500 ml-1.5">
                  {rule.hour_start != null && rule.hour_end != null ? `hour ${rule.hour_start}-${rule.hour_end} (Miami)` : ""}
                  {(rule.er_min != null || rule.er_max != null) ? " · ER bound" : ""}
                  {(rule.volume_min != null || rule.volume_max != null) ? " · volume bound" : ""}
                  {(rule.wiggle_min != null || rule.wiggle_max != null) ? " · wiggle bound" : ""}
                  {(rule.rate_min != null || rule.rate_max != null) ? " · rate bound" : ""}
                  {(rule.vol_wiggle_ratio_min != null || rule.vol_wiggle_ratio_max != null) ? " · vol/wiggle bound" : ""}
                  {(rule.vol_wiggle_product_min != null || rule.vol_wiggle_product_max != null) ? " · vol×wiggle bound" : ""}
                </span>
              </p>
              <div className="flex items-center gap-1">
                <button onClick={(e) => { e.stopPropagation(); moveRule(i, -1); }} disabled={i === 0}
                  className="text-gray-500 hover:text-white disabled:opacity-20 px-1">↑</button>
                <button onClick={(e) => { e.stopPropagation(); moveRule(i, 1); }} disabled={i === rules.length - 1}
                  className="text-gray-500 hover:text-white disabled:opacity-20 px-1">↓</button>
                <button onClick={(e) => { e.stopPropagation(); removeRule(i); }}
                  className="text-red-400 hover:text-red-300 px-1 text-xs">✕</button>
                <span className="text-gray-500 text-xs px-1">{expanded === i ? "▲" : "▼"}</span>
              </div>
            </div>
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
                    {condField("Rate", i, "rate_min", "rate_max", rule)}
                    {condField("Vol/Wiggle", i, "vol_wiggle_ratio_min", "vol_wiggle_ratio_max", rule)}
                    {condField("Vol×Wiggle", i, "vol_wiggle_product_min", "vol_wiggle_product_max", rule)}
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-gray-500 text-[9px] uppercase">Worker 1 settings (blank = leave alone)</p>
                    <button
                      onClick={() => patchRule(i, { worker1_enabled: !(rule.worker1_enabled !== false) })}
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                        rule.worker1_enabled !== false ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                      {rule.worker1_enabled !== false ? "ON when matched" : "OFF when matched"}
                    </button>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {settingsField("SL", i, "worker1", "sl_pct", rule)}
                    {settingsField("Trig", i, "worker1", "trigger_pct", rule)}
                    {settingsField("Trail", i, "worker1", "trail_pct", rule)}
                    {settingsField("TP", i, "worker1", "tp_pct", rule)}
                    {settingsField("Dwell", i, "worker1", "dwell_seconds", rule)}
                  </div>
                  <div className="flex gap-1.5 flex-wrap mt-1.5">
                    {settingsField("Band lo", i, "worker1", "band_lo", rule)}
                    {settingsField("Band hi", i, "worker1", "band_hi", rule)}
                    {settingsField("Rev lo", i, "worker1", "reversal_lo", rule)}
                    {settingsField("Rev hi", i, "worker1", "reversal_hi", rule)}
                    {settingsField("Window", i, "worker1", "window", rule)}
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-gray-500 text-[9px] uppercase">Hedge settings (blank = leave alone)</p>
                    <button
                      onClick={() => patchRule(i, { hedge_enabled: !(rule.hedge_enabled !== false) })}
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                        rule.hedge_enabled !== false ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                      {rule.hedge_enabled !== false ? "ON when matched" : "OFF when matched"}
                    </button>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {settingsField("SL", i, "hedge", "sl_pct", rule)}
                    {settingsField("Trig", i, "hedge", "trigger_pct", rule)}
                    {settingsField("Trail", i, "hedge", "trail_pct", rule)}
                    {settingsField("TP", i, "hedge", "tp_pct", rule)}
                    {settingsField("Dwell", i, "hedge", "dwell_seconds", rule)}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
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
  const [optimalBtcState,  setOptimalBtcState]  = useState<any>(null);
  const [optimalBtcTrades, setOptimalBtcTrades] = useState<any[]>([]);
  const [optimalBtcRuns,   setOptimalBtcRuns]   = useState<any[]>([]);
  const [hedgeEnvironmentRun, setHedgeEnvironmentRun] = useState<any>(null);
  const [scheduleState, setScheduleState] = useState<any>(null);
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
    setOptimalBtcState(optimalBtcSt ?? null);
    setOptimalBtcTrades(optimalBtcTr ?? []);
    setOptimalBtcRuns(optimalBtcRs ?? []);
    setHedgeEnvironmentRun(hedgeEnvironmentRows?.[0] ?? null);
    setScheduleState(scheduleSt ?? null);
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
    // market_id=1 -- BTC, the coin the hedge (Worker 2) trades again as of 2026-10-01 (was ETH,
    // was SOL, was BTC before that -- update this market_id every time the hedge switches
    // coins). See hedgeCoinPrice's declaration for why this must not reuse ocoBtcPrice -- kept
    // as its own fetch rather than collapsed back into ocoBtcPrice specifically so this is a
    // one-line change the next time the coin changes, not a re-wire.
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

  async function handleSurferToggle() {
    setSurferToggling(true);
    await fetch("/api/surfer/toggle", { method: "POST" });
    await load();
    setSurferToggling(false);
  }

  async function handleSurferSellAll() {
    if (!confirm("Sell all SOL back to BTC and return to idle?")) return;
    setSurferSellingAll(true);
    await fetch("/api/surfer/sell-all", { method: "POST" });
    await load();
    setSurferSellingAll(false);
  }

  async function handleSurferClearHistory() {
    if (!confirm("Delete all Surfer trade history and run logs?")) return;
    setSurferClearing(true);
    await fetch("/api/surfer/clear-history", { method: "POST" });
    await load();
    setSurferClearing(false);
  }

  async function handleSurferUsdtToggle() {
    setSurferUsdtToggling(true);
    await fetch("/api/surfer-usdt/toggle", { method: "POST" });
    await load();
    setSurferUsdtToggling(false);
  }

  async function handleSurferUsdtSellAll() {
    if (!confirm("Sell all SOL back to USDT and return to idle?")) return;
    setSurferUsdtSellingAll(true);
    await fetch("/api/surfer-usdt/sell-all", { method: "POST" });
    await load();
    setSurferUsdtSellingAll(false);
  }

  async function handleSurferUsdtClearHistory() {
    if (!confirm("Delete all Surfer USDT trade history and run logs?")) return;
    setSurferUsdtClearing(true);
    await fetch("/api/surfer-usdt/clear-history", { method: "POST" });
    await load();
    setSurferUsdtClearing(false);
  }


  async function handleHtToggle() {
    setHtToggling(true);
    await fetch("/api/sol-hypertrade-paper/toggle", { method: "POST" });
    await load();
    setHtToggling(false);
  }

  async function handleHtClearHistory() {
    if (!confirm("Delete all hypertrade trade history and run logs, and reset state? Any open real position will be sold first.")) return;
    setHtClearing(true);
    const res = await fetch("/api/sol-hypertrade-paper/clear-history", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Failed to clear history.");
    }
    await load();
    setHtClearing(false);
  }

  async function handleSzToggle() {
    setSzToggling(true);
    await fetch("/api/solbtc-sizeconf/toggle", { method: "POST" });
    await load();
    setSzToggling(false);
  }

  async function handleSzClearHistory() {
    if (!confirm("Delete all size-confirmation-bot trade history and run logs, and reset state?")) return;
    setSzClearing(true);
    const res = await fetch("/api/solbtc-sizeconf/clear-history", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Failed to clear history.");
    }
    await load();
    setSzClearing(false);
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
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "lighter_btc_optimal_runs" }, debouncedLoad)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "lighter_stoch_dca_btc_runs" }, debouncedLoad)
      .subscribe();
    const ch6 = sb.channel("lighter-btc-rsi-paper")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "lighter_btc_rsi_paper_trades" }, debouncedLoad)
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      sb.removeChannel(ch1); sb.removeChannel(ch2); sb.removeChannel(ch3); sb.removeChannel(ch4); sb.removeChannel(ch5);
      sb.removeChannel(ch6);
    };
  }, []);

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">TradeBot Dashboard</h1>
        </div>

        <MasterSchedulePanel
          scheduleState={scheduleState}
          worker1State={initialBtcState}
          hedgeLongState={optimalBtcState}
          loading={loading}
          onToggled={load}
        />

        {/* ── Lighter BTC Stochastic5: 3-worker comparison, real money, $100 each */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
          <HedgeDualLegPanel
            environmentRun={hedgeEnvironmentRun}
            now={healthTick}
            longState={optimalBtcState}
            longTrades={optimalBtcTrades.filter((t: any) => Date.parse(t.closed_at) >= Date.parse(optimalBtcState?.history_reset_at ?? WORKER2_RESET_AT))}
            shortState={dcaBtcState}
            shortTrades={dcaBtcTrades.filter((t: any) => Date.parse(t.closed_at) >= Date.parse(dcaBtcState?.history_reset_at ?? WORKER2_RESET_AT))}
            currentPrice={hedgeCoinPrice}
            loading={loading}
            onToggled={load}
          />
          <CompactStochBtcPanel
            title="Worker 3 · Joint Adaptive"
            subtitle="Window, K thresholds, TP, SL, and reversal blanking all move continuously with volatility (R = vol_pct/0.0712) -- unchanged formula / real SL locks real orders, 2 consecutive paper wins unlock (at least 1 must be a literal TP), OR 3 wins of any kind unlocks regardless / book-opposition early exit added (10s age, losing >=0.05%, near-touch opposing depth >60% within 0.05% of price)"
            table="lighter_stoch_dca_btc_state"
            state={dcaBtcState}
            trades={dcaBtcTrades.filter((t: any) => Date.parse(t.closed_at) >= Date.parse(dcaBtcState?.history_reset_at ?? WORKER3_RESET_AT))}
            currentPrice={ocoBtcPrice}
            loading={loading}
            onToggled={load}
            runs={dcaBtcRuns}
            showSelfLock
            combineEquityWinRate
            dormant
          />
        </div>

      </div>
    </main>
  );
}
