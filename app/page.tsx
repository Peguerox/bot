"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import PnLChart from "@/components/PnLChart";
import { SEED_USD as HT_SEED_USD, dropPctForLevel as htDropPctForLevel } from "@/lib/sol-hypertrade-config";

// Mirrors trigger/live-bot-surfer-solbtc.ts BUF_UP/BUF_DN/ARM/GIVEBACK -- keep in sync if that changes.
const SURFER_BUF_UP = 0.0025;
const SURFER_BUF_DN = 0.0020;
const SURFER_ARM = 0.18;
const SURFER_GIVEBACK = 0.15;

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
  title, subtitle, table, state, trades, currentPrice, loading, onToggled, erValue, runs, cooldownMin,
  showSelfLock, stats, tradingHoursUtc, combineEquityWinRate,
}: {
  title: string; subtitle: string; table: string; state: any; trades: any[];
  currentPrice: number | null; loading: boolean; onToggled: () => void;
  erValue?: number | null; runs?: any[]; cooldownMin?: number; showSelfLock?: boolean;
  stats?: { total: number; wins: number }; tradingHoursUtc?: number[];
  combineEquityWinRate?: boolean;
}) {
  const [toggling, setToggling] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const side = state?.side ?? null;
  const legs: any[] = state?.legs ?? [];
  const seedUsd = state?.seed_usd ?? 100;
  const realizedPnl = state?.realized_pnl_usd ?? 0;
  const equity = seedUsd + realizedPnl;
  const enabled = state?.enabled ?? false;
  // A trend-regime leg is entered with a wider TP than the fade default (0.10%) -- that's
  // the only signal we have client-side for which regime this open position belongs to.
  const posTpPct = state?.position_tp_pct ?? null;
  const positionRegime = side == null ? null : (posTpPct != null && posTpPct > 0.15 ? "trend" : "fade");
  const marketRegime = erValue == null ? null : (erValue > 0.75 ? "trend" : "chop");

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

  async function handleToggle() {
    const question = enabled
      ? `Turn OFF ${title}? This stops new entries -- it will NOT close an existing position.`
      : `Turn ON ${title}? This resumes real trading.`;
    if (!confirm(question)) return;
    setToggling(true);
    await fetch("/api/lighter-btc-toggle", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table }),
    });
    await onToggled();
    setToggling(false);
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
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-white font-bold text-sm">{title}</h3>
          <p className="text-gray-500 text-[11px]">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
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
          <div className={`bg-gray-800/60 rounded-lg p-2 ${!combineEquityWinRate && erValue == null && cooldownMin == null && !showSelfLock && !tradingHoursUtc ? "col-span-2" : ""}`}>
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
        const erPill = erValue != null && (
          <div className="bg-gray-800/60 rounded-lg p-2">
            <p className="text-gray-500 text-[10px] uppercase">Market ER(6)</p>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-white">{erValue.toFixed(2)}</span>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${marketRegime === "trend" ? "bg-purple-500/20 text-purple-300" : "bg-blue-500/20 text-blue-300"}`}>
                {marketRegime}
              </span>
            </div>
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
          const now = new Date(nowTick);
          const nowHourUtc = now.getUTCHours();
          const isOpen = tradingHoursUtc.includes(nowHourUtc);
          // Find the next hour where open/closed status flips, in UTC (matches the gate's
          // own clock), then label that boundary in Miami/Eastern time -- what's actually
          // useful here is "when does this change," not the current time (a watch covers
          // that already).
          let boundaryHourUtc = nowHourUtc;
          let daysAhead = 0;
          for (let i = 1; i <= 24; i++) {
            const h = (nowHourUtc + i) % 24;
            if (tradingHoursUtc.includes(h) !== isOpen) {
              boundaryHourUtc = h;
              daysAhead = Math.floor((nowHourUtc + i) / 24);
              break;
            }
          }
          const boundaryDate = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead,
            boundaryHourUtc, 0, 0
          ));
          const boundaryLabel = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true,
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
        const awaitingOpenConfirm = !state?.real_trading_locked && state?.awaiting_open_confirmation;
        const selfLockPill = showSelfLock && (
          <div className="bg-gray-800/60 rounded-lg p-2">
            <p className="text-gray-500 text-[10px] uppercase">Self-Lock</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${
                state?.real_trading_locked ? "bg-red-500/20 text-red-400"
                : awaitingOpenConfirm ? "bg-amber-500/20 text-amber-400"
                : "bg-green-500/20 text-green-400"
              }`}>
                real {state?.real_trading_locked ? "locked" : awaitingOpenConfirm ? "awaiting TP" : "active"}
              </span>
              {state?.real_trading_locked && (
                <span className="text-[10px] font-bold text-gray-300 tabular-nums"
                      title="Consecutive paper TPs needed to unlock real trading">
                  {state?.paper_consecutive_tps ?? 0}/2 paper TPs
                </span>
              )}
              {awaitingOpenConfirm && (
                <span className="text-[10px] font-bold text-gray-300 tabular-nums"
                      title="1 paper TP required before real entries resume this open-hour session">
                  0/1 paper TP
                </span>
              )}
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${
                state?.paper_side === "long" ? "bg-green-500/20 text-green-400"
                : state?.paper_side === "short" ? "bg-amber-500/20 text-amber-400"
                : "bg-gray-700/40 text-gray-500"
              }`} title="What the internal paper shadow is currently holding, real or not">
                paper {state?.paper_side ? state.paper_side.toUpperCase() : "FLAT"}
              </span>
            </div>
          </div>
        );

        if (combineEquityWinRate) {
          // Fixed 2x2: [Equity+WinRate, Self-Lock] / [Position, Trading Hours]
          return (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {equityWinRatePill}
              {selfLockPill}
              {positionPill}
              {tradingHoursPill}
            </div>
          );
        }
        return (
          <div className="grid grid-cols-2 gap-2 text-xs">
            {equityPill}
            {winRatePill}
            {positionPill}
            {erPill}
            {breakerPill}
            {tradingHoursPill}
            {selfLockPill}
          </div>
        );
      })()}
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
                <span className={t.side === "long" ? "text-green-400" : "text-amber-400"}>{t.side}·{t.reason}</span>
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
                <span className={t.side === "long" ? "text-green-400" : "text-red-400"}>{t.side} · {t.reason}</span>
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
  const [btcEr6, setBtcEr6] = useState<number | null>(null);
  const [dcaBtcState,  setDcaBtcState]  = useState<any>(null);
  const [dcaBtcTrades, setDcaBtcTrades] = useState<any[]>([]);
  const [dcaBtcRuns,   setDcaBtcRuns]   = useState<any[]>([]);
  const [initialBtcState,  setInitialBtcState]  = useState<any>(null);
  const [initialBtcTrades, setInitialBtcTrades] = useState<any[]>([]);
  const [initialBtcRuns,   setInitialBtcRuns]   = useState<any[]>([]);
  const [optimalBtcState,  setOptimalBtcState]  = useState<any>(null);
  const [optimalBtcTrades, setOptimalBtcTrades] = useState<any[]>([]);
  const [optimalBtcRuns,   setOptimalBtcRuns]   = useState<any[]>([]);
  // True lifetime trade/win counts -- the trades arrays above are capped at 200 rows for
  // display purposes, which silently froze the win-rate % and trade count once any worker
  // passed 200 real trades (Worker 2 hit this first, at 606 real trades and counting).
  const [dcaBtcStats,     setDcaBtcStats]     = useState({ total: 0, wins: 0 });
  const [initialBtcStats, setInitialBtcStats] = useState({ total: 0, wins: 0 });
  const [optimalBtcStats, setOptimalBtcStats] = useState({ total: 0, wins: 0 });

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
    setDcaBtcStats({ total: dcaBtcTotal ?? 0, wins: dcaBtcWins ?? 0 });
    setInitialBtcStats({ total: initialBtcTotal ?? 0, wins: initialBtcWins ?? 0 });
    setOptimalBtcStats({ total: optimalBtcTotal ?? 0, wins: optimalBtcWins ?? 0 });
    fetch("https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=1&limit=1")
      .then((r) => r.json())
      .then((ob) => {
        const bid = parseFloat(ob?.bids?.[0]?.price);
        const ask = parseFloat(ob?.asks?.[0]?.price);
        if (bid && ask) setOcoBtcPrice((bid + ask) / 2);
      })
      .catch(() => {});
    // Live Efficiency Ratio(6) -- same formula Worker 1/3's regime switch uses -- computed
    // client-side from public candles so the panel shows the actual market condition, not
    // just the bot's last trade.
    fetch(`https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id=1&resolution=1m&start_timestamp=0&end_timestamp=${Date.now()}&count_back=10`)
      .then((r) => r.json())
      .then((d) => {
        const c = (d?.c ?? []).slice().sort((a: any, b: any) => a.t - b.t);
        if (c.length < 7) return;
        const closes = c.slice(-7).map((x: any) => x.c);
        const net = Math.abs(closes[closes.length - 1] - closes[0]);
        let path = 0;
        for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1]);
        setBtcEr6(path > 0 ? net / path : 0);
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
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      sb.removeChannel(ch1); sb.removeChannel(ch2); sb.removeChannel(ch3); sb.removeChannel(ch4); sb.removeChannel(ch5);
    };
  }, []);

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">TradeBot Dashboard</h1>
        </div>

        {/* ── Lighter BTC Stochastic5: 3-worker comparison, real money, $100 each */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <CompactStochBtcPanel
            title="Worker 1 · Blanking Period + Hourly Schedule"
            subtitle="TP 0.10% / SL 0.11% / 25-75 / window 5 / 120s blanking period after entry -- Worker 2's config plus that and an hourly trading-hours schedule (experiment)"
            table="lighter_btc_initial_state"
            state={initialBtcState}
            trades={initialBtcTrades}
            currentPrice={ocoBtcPrice}
            loading={loading}
            onToggled={load}
            stats={initialBtcStats}
            tradingHoursUtc={[0, 1, 4, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21]}
          />
          <CompactStochBtcPanel
            title="Worker 2 · Combined"
            subtitle="TP 0.10% / SL 0.11% / 25-75 / window 5 / 120s blanking period / hourly schedule / self-lock / 1 paper TP required at hour-open"
            table="lighter_btc_optimal_state"
            state={optimalBtcState}
            trades={optimalBtcTrades}
            currentPrice={ocoBtcPrice}
            loading={loading}
            onToggled={load}
            stats={optimalBtcStats}
            showSelfLock
            tradingHoursUtc={[0, 1, 4, 9, 10, 12, 15, 16, 17, 18, 19, 20, 21]}
            combineEquityWinRate
          />
          <CompactStochBtcPanel
            title="Worker 3 · Self-Lock"
            subtitle="TP 0.10% / SL 0.11% / 25-75 / window 5 / 120s reversal guard / real SL locks real orders, 2 consecutive paper wins unlock (winning reversals count too)"
            table="lighter_stoch_dca_btc_state"
            state={dcaBtcState}
            trades={dcaBtcTrades}
            currentPrice={ocoBtcPrice}
            loading={loading}
            onToggled={load}
            runs={dcaBtcRuns}
            showSelfLock
            stats={dcaBtcStats}
          />
        </div>

      </div>
    </main>
  );
}
