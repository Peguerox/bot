"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import PnLChart from "@/components/PnLChart";
import TradeHistory from "@/components/TradeHistory";
import OpenPositions from "@/components/OpenPositions";

const PAPER_INITIAL = 2000;

function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="bg-gray-800/60 rounded-lg p-3">
      <p className="text-gray-500 text-xs uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${color}`}>{value}</p>
      <p className="text-gray-600 text-xs mt-0.5">{sub}</p>
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
  return a.action;
}

// ── Paper bot panel ─────────────────────────────────────────────────────────

function PaperPanel({ trades, openPositions, loading }: {
  trades: any[]; openPositions: any[]; loading: boolean;
}) {
  const totalPnL  = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const decided   = trades.filter(t => t.result !== "EXPIRE" && t.result !== "MISSED");
  const wins      = decided.filter(t => t.pnl > 0);
  const losses    = decided.filter(t => t.pnl < 0);
  const winRate   = decided.length > 0 ? (wins.length / decided.length * 100).toFixed(1) : "—";
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf        = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  let peak = PAPER_INITIAL, maxDD = 0, runBal = PAPER_INITIAL;
  [...trades].reverse().forEach(t => {
    runBal += t.pnl ?? 0;
    if (runBal > peak) peak = runBal;
    const dd = (runBal - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  });
  const balance = PAPER_INITIAL + totalPnL;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">Lag Bot</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">PAPER</span>
          </div>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-green-400 text-xs font-medium">Running</span>
          </span>
        </div>
        <p className="text-gray-500 text-xs">BNB + ATOM · $2,000 · 1m · Z=2.0 · TP 0.8% · SL 0.3%</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Balance"       value={`$${balance.toFixed(2)}`}   sub={`${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)} paper PnL`} color={balance >= PAPER_INITIAL ? "text-green-400" : "text-red-400"} />
          <Stat label="Win Rate"      value={`${winRate}%`}              sub={`${wins.length}W / ${losses.length}L of ${decided.length}`}       color="text-blue-400" />
          <Stat label="Profit Factor" value={pf}                         sub={openPositions.length > 0 ? `${openPositions.length} open` : "No open positions"} color="text-purple-400" />
          <Stat label="Max Drawdown"  value={`${maxDD.toFixed(1)}%`}     sub={`${trades.length} total trades`}                                  color={maxDD < -10 ? "text-red-400" : "text-yellow-400"} />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL</p>
        <PnLChart trades={trades} initial={PAPER_INITIAL} />
      </div>
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">
          Open Positions
          {openPositions.length > 0 && <span className="ml-1 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full text-xs">{openPositions.length}</span>}
        </p>
        <OpenPositions positions={openPositions} loading={loading} />
      </div>
      <div className="flex-1">
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Trades</p>
        <TradeHistory trades={trades.slice(0, 10)} loading={loading} />
      </div>
    </div>
  );
}

// ── XLM→BTC Live bot panel ───────────────────────────────────────────────────

function XlmLivePanel({
  trades, openPositions, loading, botUsdt, totalUsdt, allBotsUsdt,
  enabled, onToggle, toggling, onReset, resetting,
  onClearHistory, clearingHistory, runs,
}: {
  trades: any[]; openPositions: any[]; loading: boolean;
  botUsdt: number; totalUsdt: number; allBotsUsdt: number; enabled: boolean;
  onToggle: () => void; toggling: boolean;
  onReset: () => void; resetting: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
  runs: any[];
}) {
  const INITIAL    = 25;
  const totalPnL   = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const decided    = trades.filter(t => t.result !== "EXPIRE" && t.result !== "MISSED");
  const wins       = decided.filter(t => t.pnl > 0);
  const losses     = decided.filter(t => t.pnl < 0);
  const winRate    = decided.length > 0 ? (wins.length / decided.length * 100).toFixed(1) : "—";
  const grossWin   = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf         = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  let peak = INITIAL, maxDD = 0, runBal = INITIAL;
  [...trades].reverse().forEach(t => {
    runBal += t.pnl ?? 0;
    if (runBal > peak) peak = runBal;
    const dd = (runBal - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  });

  const latestPrice: number | null = (() => {
    const actions: any[] = runs[0]?.data?.actions ?? [];
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].livePrice != null) return parseFloat(actions[i].livePrice);
      if (actions[i].price != null)     return parseFloat(actions[i].price);
    }
    return null;
  })();

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">Pure Lag · BTC</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">LIVE</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onClearHistory}
              disabled={clearingHistory || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before clearing" : "Delete all closed trades and run logs"}
            >
              {clearingHistory ? "Clearing…" : "Clear"}
            </button>
            <button
              onClick={onReset}
              disabled={resetting || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-red-400/70 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before selling" : "Sell all XLM & clear position"}
            >
              {resetting ? "Selling…" : "Sell All"}
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
        <p className="text-gray-500 text-xs">BTC/USDT · $25 · 1m · BTC global≥0.05% · TP 0.8% · SL 0.15% · limit +0.02%</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="PnL"           value={`${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}`} sub={`balance $${(INITIAL + totalPnL).toFixed(2)}`} color={totalPnL >= 0 ? "text-green-400" : "text-red-400"} />
          <Stat label="Win Rate"      value={`${winRate}%`}             sub={`${wins.length}W / ${losses.length}L of ${decided.length}`} color="text-blue-400" />
          <Stat label="Profit Factor" value={pf}                        sub={openPositions.length > 0 ? `${openPositions.length} open` : "No open positions"} color="text-purple-400" />
          <Stat label="Max Drawdown"  value={`${maxDD.toFixed(1)}%`}   sub={`${trades.length} total trades`} color={maxDD < -10 ? "text-red-400" : "text-yellow-400"} />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL</p>
        <PnLChart trades={trades} initial={INITIAL} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Allocation</p>
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-gray-600 border-b border-gray-800">
              <th className="text-left pb-1 font-medium">Asset</th>
              <th className="text-right pb-1 font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Total USDT</td>
              <td className="py-1.5 text-right text-white">${totalUsdt > 0 ? totalUsdt.toFixed(2) : "—"}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Bot Balance</td>
              <td className={`py-1.5 text-right font-bold ${
                openPositions[0]?.status === "pending_entry" ? "text-yellow-400"
                : openPositions[0]?.status === "open" || openPositions[0]?.status === "chasing" ? "text-blue-400"
                : botUsdt >= 24 ? "text-green-400" : botUsdt > 0 ? "text-yellow-400" : "text-red-400"
              }`}>
                {openPositions[0]?.status === "pending_entry"
                  ? `$${botUsdt.toFixed(2)} in order`
                  : openPositions[0]?.status === "open" || openPositions[0]?.status === "chasing"
                  ? `≈$${((openPositions[0].quantity ?? 0) * (latestPrice ?? 0)).toFixed(2)} in BTC`
                  : `$${botUsdt.toFixed(2)}`}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Free USDT</td>
              <td className="py-1.5 text-right text-gray-400">
                {totalUsdt > 0
                  ? openPositions.length > 0
                    ? `$${totalUsdt.toFixed(2)}`
                    : `$${Math.max(0, totalUsdt - allBotsUsdt).toFixed(2)}`
                  : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">BTC</td>
              <td className="py-1.5 text-right text-white">
                {openPositions[0]?.status === "pending_entry"
                  ? "—"
                  : openPositions[0]?.quantity?.toFixed(5) ?? "0"}
              </td>
            </tr>
            <tr>
              <td className="py-1.5 text-gray-400">BTC price</td>
              <td className="py-1.5 text-right text-yellow-400">
                {latestPrice != null ? `$${latestPrice.toFixed(2)}` : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">
          Open Positions
          {openPositions.length > 0 && <span className="ml-1 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full text-xs">{openPositions.length}</span>}
        </p>
        <OpenPositions positions={openPositions} loading={loading} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Trades</p>
        <TradeHistory trades={trades.slice(0, 10)} loading={loading} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Activity</p>
        <div className="h-56 overflow-y-auto space-y-0.5 font-mono text-sm pr-1">
          {runs.length === 0 && <p className="text-gray-600">No runs yet.</p>}
          {runs.map((r: any) => {
            const actions = r.data?.actions ?? [];
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

// ── BTC Live bot panel ──────────────────────────────────────────────────────

function BtcLivePanel({
  trades, openPositions, loading, botUsdt, totalUsdt, allBotsUsdt,
  enabled, onToggle, toggling, onReset, resetting,
  onClearHistory, clearingHistory, runs,
}: {
  trades: any[]; openPositions: any[]; loading: boolean;
  botUsdt: number; totalUsdt: number; allBotsUsdt: number; enabled: boolean;
  onToggle: () => void; toggling: boolean;
  onReset: () => void; resetting: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
  runs: any[];
}) {
  const INITIAL    = 25;
  const totalPnL   = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const decided    = trades.filter(t => t.result !== "EXPIRE" && t.result !== "MISSED");
  const wins       = decided.filter(t => t.pnl > 0);
  const losses     = decided.filter(t => t.pnl < 0);
  const winRate    = decided.length > 0 ? (wins.length / decided.length * 100).toFixed(1) : "—";
  const grossWin   = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf         = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  let peak = INITIAL, maxDD = 0, runBal = INITIAL;
  [...trades].reverse().forEach(t => {
    runBal += t.pnl ?? 0;
    if (runBal > peak) peak = runBal;
    const dd = (runBal - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  });

  const latestPrice: number | null = (() => {
    const actions: any[] = runs[0]?.data?.actions ?? [];
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].livePrice != null) return parseFloat(actions[i].livePrice);
      if (actions[i].price != null)     return parseFloat(actions[i].price);
    }
    return null;
  })();

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">Pure Lag · BTC</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">LIVE</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onClearHistory}
              disabled={clearingHistory || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before clearing" : "Delete all closed trades and run logs"}
            >
              {clearingHistory ? "Clearing…" : "Clear"}
            </button>
            <button
              onClick={onReset}
              disabled={resetting || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-red-400/70 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before selling" : "Sell all BTC & clear position"}
            >
              {resetting ? "Selling…" : "Sell All"}
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
        <p className="text-gray-500 text-xs">BTC/USDT · $25 · 1m · BTC global≥0.05% · TP 0.8% · SL 0.15% · limit +0.02%</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="PnL"           value={`${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}`} sub={`balance $${(INITIAL + totalPnL).toFixed(2)}`} color={totalPnL >= 0 ? "text-green-400" : "text-red-400"} />
          <Stat label="Win Rate"      value={`${winRate}%`}             sub={`${wins.length}W / ${losses.length}L of ${decided.length}`} color="text-blue-400" />
          <Stat label="Profit Factor" value={pf}                        sub={openPositions.length > 0 ? `${openPositions.length} open` : "No open positions"} color="text-purple-400" />
          <Stat label="Max Drawdown"  value={`${maxDD.toFixed(1)}%`}   sub={`${trades.length} total trades`} color={maxDD < -10 ? "text-red-400" : "text-yellow-400"} />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL</p>
        <PnLChart trades={trades} initial={INITIAL} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Allocation</p>
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-gray-600 border-b border-gray-800">
              <th className="text-left pb-1 font-medium">Asset</th>
              <th className="text-right pb-1 font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Total USDT</td>
              <td className="py-1.5 text-right text-white">${totalUsdt > 0 ? totalUsdt.toFixed(2) : "—"}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Bot Balance</td>
              <td className={`py-1.5 text-right font-bold ${
                openPositions[0]?.status === "pending_entry" ? "text-yellow-400"
                : openPositions[0]?.status === "open" || openPositions[0]?.status === "chasing" ? "text-blue-400"
                : botUsdt >= 24 ? "text-green-400" : botUsdt > 0 ? "text-yellow-400" : "text-red-400"
              }`}>
                {openPositions[0]?.status === "pending_entry"
                  ? `$${botUsdt.toFixed(2)} in order`
                  : openPositions[0]?.status === "open" || openPositions[0]?.status === "chasing"
                  ? `≈$${((openPositions[0].quantity ?? 0) * (latestPrice ?? 0)).toFixed(2)} in BTC`
                  : `$${botUsdt.toFixed(2)}`}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Free USDT</td>
              <td className="py-1.5 text-right text-gray-400">
                {totalUsdt > 0
                  ? openPositions.length > 0
                    ? `$${totalUsdt.toFixed(2)}`
                    : `$${Math.max(0, totalUsdt - allBotsUsdt).toFixed(2)}`
                  : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">BTC</td>
              <td className="py-1.5 text-right text-white">
                {openPositions[0]?.status === "pending_entry"
                  ? "—"
                  : openPositions[0]?.quantity?.toFixed(5) ?? "0"}
              </td>
            </tr>
            <tr>
              <td className="py-1.5 text-gray-400">BTC price</td>
              <td className="py-1.5 text-right text-yellow-400">
                {latestPrice != null ? `$${latestPrice.toFixed(2)}` : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">
          Open Positions
          {openPositions.length > 0 && <span className="ml-1 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full text-xs">{openPositions.length}</span>}
        </p>
        <OpenPositions positions={openPositions} loading={loading} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Trades</p>
        <TradeHistory trades={trades.slice(0, 10)} loading={loading} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Activity</p>
        <div className="h-56 overflow-y-auto space-y-0.5 font-mono text-sm pr-1">
          {runs.length === 0 && <p className="text-gray-600">No runs yet.</p>}
          {runs.map((r: any) => {
            const actions = r.data?.actions ?? [];
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

// ── BNB Live bot panel ──────────────────────────────────────────────────────

function BnbLivePanel({
  trades, openPositions, loading, botUsdt, totalUsdt, allBotsUsdt,
  enabled, onToggle, toggling, onReset, resetting,
  onClearHistory, clearingHistory, runs,
}: {
  trades: any[]; openPositions: any[]; loading: boolean;
  botUsdt: number; totalUsdt: number; allBotsUsdt: number; enabled: boolean;
  onToggle: () => void; toggling: boolean;
  onReset: () => void; resetting: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
  runs: any[];
}) {
  const INITIAL    = 25;
  const totalPnL   = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const decided    = trades.filter(t => t.result !== "EXPIRE" && t.result !== "MISSED");
  const wins       = decided.filter(t => t.pnl > 0);
  const losses     = decided.filter(t => t.pnl < 0);
  const winRate    = decided.length > 0 ? (wins.length / decided.length * 100).toFixed(1) : "—";
  const grossWin   = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf         = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  let peak = INITIAL, maxDD = 0, runBal = INITIAL;
  [...trades].reverse().forEach(t => {
    runBal += t.pnl ?? 0;
    if (runBal > peak) peak = runBal;
    const dd = (runBal - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  });

  const latestPrice: number | null = (() => {
    const actions: any[] = runs[0]?.data?.actions ?? [];
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].livePrice != null) return parseFloat(actions[i].livePrice);
      if (actions[i].price     != null) return parseFloat(actions[i].price);
    }
    return null;
  })();

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">Pure Lag · BTC</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">LIVE</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onClearHistory}
              disabled={clearingHistory || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before clearing" : "Delete all closed trades and run logs"}
            >
              {clearingHistory ? "Clearing…" : "Clear"}
            </button>
            <button
              onClick={onReset}
              disabled={resetting || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-red-400/70 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before selling" : "Sell all XLM & clear position"}
            >
              {resetting ? "Selling…" : "Sell All"}
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
        <p className="text-gray-500 text-xs">BTC/USDT · $25 · 1m · BTC global≥0.05% · TP 0.8% · SL 0.15% · limit +0.02%</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="PnL"           value={`${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}`} sub={`balance $${(INITIAL + totalPnL).toFixed(2)}`} color={totalPnL >= 0 ? "text-green-400" : "text-red-400"} />
          <Stat label="Win Rate"      value={`${winRate}%`}             sub={`${wins.length}W / ${losses.length}L of ${decided.length}`} color="text-blue-400" />
          <Stat label="Profit Factor" value={pf}                        sub={openPositions.length > 0 ? `${openPositions.length} open` : "No open positions"} color="text-purple-400" />
          <Stat label="Max Drawdown"  value={`${maxDD.toFixed(1)}%`}   sub={`${trades.length} total trades`} color={maxDD < -10 ? "text-red-400" : "text-yellow-400"} />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL</p>
        <PnLChart trades={trades} initial={INITIAL} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Allocation</p>
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-gray-600 border-b border-gray-800">
              <th className="text-left pb-1 font-medium">Asset</th>
              <th className="text-right pb-1 font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Total USDT</td>
              <td className="py-1.5 text-right text-white">${totalUsdt > 0 ? totalUsdt.toFixed(2) : "—"}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Bot Balance</td>
              <td className={`py-1.5 text-right font-bold ${
                openPositions[0]?.status === "pending_entry"
                  ? "text-yellow-400"
                  : botUsdt >= 24 ? "text-green-400" : botUsdt > 0 ? "text-yellow-400" : "text-blue-400"
              }`}>
                {openPositions[0]?.status === "pending_entry"
                  ? `≈$${((openPositions[0].quantity ?? 0) * (latestPrice ?? 0)).toFixed(2)} in order`
                  : `$${botUsdt.toFixed(2)}`}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Free USDT</td>
              <td className="py-1.5 text-right text-gray-400">${totalUsdt > 0 ? Math.max(0, totalUsdt - allBotsUsdt).toFixed(2) : "—"}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">XLM</td>
              <td className="py-1.5 text-right text-white">
                {openPositions[0]?.status === "pending_entry"
                  ? "—"
                  : openPositions[0]?.quantity?.toFixed(0) ?? "0"}
              </td>
            </tr>
            <tr>
              <td className="py-1.5 text-gray-400">XLM price</td>
              <td className="py-1.5 text-right text-yellow-400">
                {latestPrice != null ? `$${latestPrice.toFixed(5)}` : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">
          Open Positions
          {openPositions.length > 0 && <span className="ml-1 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full text-xs">{openPositions.length}</span>}
        </p>
        <OpenPositions positions={openPositions} loading={loading} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Trades</p>
        <TradeHistory trades={trades.slice(0, 10)} loading={loading} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Activity</p>
        <div className="h-56 overflow-y-auto space-y-0.5 font-mono text-sm pr-1">
          {runs.length === 0 && <p className="text-gray-600">No runs yet.</p>}
          {runs.map((r: any) => {
            const actions = r.data?.actions ?? [];
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

// ── XRP Live bot panel ──────────────────────────────────────────────────────

function XrpLivePanel({
  trades, openPositions, loading, botUsdt, totalUsdt, allBotsUsdt,
  enabled, onToggle, toggling, onReset, resetting,
  onClearHistory, clearingHistory, runs,
}: {
  trades: any[]; openPositions: any[]; loading: boolean;
  botUsdt: number; totalUsdt: number; allBotsUsdt: number; enabled: boolean;
  onToggle: () => void; toggling: boolean;
  onReset: () => void; resetting: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
  runs: any[];
}) {
  const INITIAL    = 25;
  const totalPnL   = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const decided    = trades.filter(t => t.result !== "EXPIRE" && t.result !== "MISSED");
  const wins       = decided.filter(t => t.pnl > 0);
  const losses     = decided.filter(t => t.pnl < 0);
  const winRate    = decided.length > 0 ? (wins.length / decided.length * 100).toFixed(1) : "—";
  const grossWin   = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf         = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  let peak = INITIAL, maxDD = 0, runBal = INITIAL;
  [...trades].reverse().forEach(t => {
    runBal += t.pnl ?? 0;
    if (runBal > peak) peak = runBal;
    const dd = (runBal - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  });

  const latestPrice: number | null = (() => {
    const actions: any[] = runs[0]?.data?.actions ?? [];
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].livePrice != null) return parseFloat(actions[i].livePrice);
      if (actions[i].price     != null) return parseFloat(actions[i].price);
    }
    return null;
  })();

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">Z-Lag · XRP</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">LIVE</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onClearHistory}
              disabled={clearingHistory || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before clearing" : "Delete all closed trades and run logs"}
            >
              {clearingHistory ? "Clearing…" : "Clear"}
            </button>
            <button
              onClick={onReset}
              disabled={resetting || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-red-400/70 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause bot before selling" : "Sell all XRP & clear position"}
            >
              {resetting ? "Selling…" : "Sell All"}
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
        <p className="text-gray-500 text-xs">XRP/FDUSD · $25 · 1m · Z=1.5 · TP 0.8% · SL 0.15% · limit orders</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="PnL"           value={`${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}`} sub={`balance $${(INITIAL + totalPnL).toFixed(2)}`} color={totalPnL >= 0 ? "text-green-400" : "text-red-400"} />
          <Stat label="Win Rate"      value={`${winRate}%`}             sub={`${wins.length}W / ${losses.length}L of ${decided.length}`} color="text-blue-400" />
          <Stat label="Profit Factor" value={pf}                        sub={openPositions.length > 0 ? `${openPositions.length} open` : "No open positions"} color="text-purple-400" />
          <Stat label="Max Drawdown"  value={`${maxDD.toFixed(1)}%`}   sub={`${trades.length} total trades`} color={maxDD < -10 ? "text-red-400" : "text-yellow-400"} />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL</p>
        <PnLChart trades={trades} initial={INITIAL} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Allocation</p>
        <table className="w-full text-sm font-mono">
          <thead>
            <tr className="text-gray-600 border-b border-gray-800">
              <th className="text-left pb-1 font-medium">Asset</th>
              <th className="text-right pb-1 font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Total FDUSD</td>
              <td className="py-1.5 text-right text-white">${totalUsdt > 0 ? totalUsdt.toFixed(2) : "—"}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Protected</td>
              <td className="py-1.5 text-right text-gray-400">${totalUsdt > 0 ? Math.max(0, totalUsdt - allBotsUsdt).toFixed(2) : "—"}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-500">
                {openPositions[0]?.status === "pending_entry" ? "In Order (FDUSD)" : "Allocated"}
              </td>
              <td className={`py-1.5 text-right font-bold ${
                openPositions[0]?.status === "pending_entry"
                  ? "text-yellow-400"
                  : botUsdt >= 24 ? "text-green-400" : botUsdt > 0 ? "text-yellow-400" : "text-blue-400"
              }`}>
                {openPositions[0]?.status === "pending_entry"
                  ? `≈$${((openPositions[0].quantity ?? 0) * (latestPrice ?? 0)).toFixed(2)}`
                  : `$${botUsdt.toFixed(2)}`}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">XRP</td>
              <td className="py-1.5 text-right text-white">
                {openPositions[0]?.status === "pending_entry"
                  ? "—"
                  : openPositions[0]?.quantity?.toFixed(1) ?? "0"}
              </td>
            </tr>
            <tr>
              <td className="py-1.5 text-gray-400">XRP price</td>
              <td className="py-1.5 text-right text-yellow-400">
                {latestPrice != null ? `$${latestPrice.toFixed(4)}` : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">
          Open Positions
          {openPositions.length > 0 && <span className="ml-1 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full text-xs">{openPositions.length}</span>}
        </p>
        <OpenPositions positions={openPositions} loading={loading} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Trades</p>
        <TradeHistory trades={trades.slice(0, 10)} loading={loading} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Activity</p>
        <div className="h-56 overflow-y-auto space-y-0.5 font-mono text-sm pr-1">
          {runs.length === 0 && <p className="text-gray-600">No runs yet.</p>}
          {runs.map((r: any) => {
            const actions = r.data?.actions ?? [];
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

// ── Dashboard ───────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [trades, setTrades]       = useState<any[]>([]);
  const [open, setOpen]           = useState<any[]>([]);
  const [xlmSettings, setXlmSettings] = useState<any>(null);
  const [xlmOpen, setXlmOpen]     = useState<any[]>([]);
  const [xlmTrades, setXlmTrades] = useState<any[]>([]);
  const [xlmRuns, setXlmRuns]     = useState<any[]>([]);
  const [btcSettings, setBtcSettings] = useState<any>(null);
  const [btcOpen, setBtcOpen]     = useState<any[]>([]);
  const [btcTrades, setBtcTrades] = useState<any[]>([]);
  const [btcRuns, setBtcRuns]     = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [xlmToggling, setXlmToggling]   = useState(false);
  const [xlmResetting, setXlmResetting] = useState(false);
  const [xlmClearing, setXlmClearing]   = useState(false);
  const [btcToggling, setBtcToggling]   = useState(false);
  const [btcResetting, setBtcResetting] = useState(false);
  const [btcClearing, setBtcClearing]   = useState(false);

  async function load() {
    const [
      { data: closed },
      { data: openPos },
      { data: xlmSt },
      { data: xlmOp },
      { data: xlmCl },
      { data: xlmRs },
    ] = await Promise.all([
      getSupabase().from("positions").select("*").eq("status", "closed").order("exit_time", { ascending: false }),
      getSupabase().from("positions").select("*").in("status", ["open", "chasing"]),
      getSupabase().from("xlm_live_settings").select("*").single(),
      getSupabase().from("xlm_live_positions").select("*").in("status", ["open", "chasing", "pending_entry"]),
      getSupabase().from("xlm_live_positions").select("*").eq("status", "closed").order("exit_time", { ascending: false }).limit(20),
      getSupabase().from("xlm_live_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
    ]);
    setTrades(closed ?? []);
    setOpen(openPos ?? []);
    setXlmSettings(xlmSt ?? null);
    setXlmOpen((xlmOp ?? []).map((p: any) => ({ ...p, pair: "XLM" })));
    setXlmTrades(xlmCl ?? []);
    setXlmRuns(xlmRs ?? []);
    setLoading(false);
  }

  async function handleXlmToggle() {
    setXlmToggling(true);
    await fetch("/api/xlm/toggle", { method: "POST" });
    await load();
    setXlmToggling(false);
  }

  async function handleXlmReset() {
    if (!confirm("Market sell all XLM and clear position?")) return;
    setXlmResetting(true);
    await fetch("/api/xlm/reset", { method: "POST" });
    await load();
    setXlmResetting(false);
  }

  async function handleXlmClearHistory() {
    if (!confirm("Delete all XLM closed trade history and run logs?")) return;
    setXlmClearing(true);
    await fetch("/api/xlm/clear-history", { method: "POST" });
    await load();
    setXlmClearing(false);
  }

  async function handleBtcToggle() {
    setBtcToggling(true);
    await fetch("/api/btc/toggle", { method: "POST" });
    await load();
    setBtcToggling(false);
  }

  async function handleBtcReset() {
    if (!confirm("Market sell all BTC and clear position?")) return;
    setBtcResetting(true);
    await fetch("/api/btc/reset", { method: "POST" });
    await load();
    setBtcResetting(false);
  }

  async function handleBtcClearHistory() {
    if (!confirm("Delete all BTC closed trade history and run logs?")) return;
    setBtcClearing(true);
    await fetch("/api/btc/clear-history", { method: "POST" });
    await load();
    setBtcClearing(false);
  }

  useEffect(() => {
    load();
    const sb = getSupabase();
    const ch1 = sb.channel("positions")
      .on("postgres_changes", { event: "*", schema: "public", table: "positions" }, load)
      .subscribe();
    const ch2 = sb.channel("xlm")
      .on("postgres_changes", { event: "*", schema: "public", table: "xlm_live_positions" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "xlm_live_settings" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "xlm_live_runs" }, load)
      .subscribe();
    const ch3 = sb.channel("btc")
      .on("postgres_changes", { event: "*", schema: "public", table: "btc_live_positions" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "btc_live_settings" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "btc_live_runs" }, load)
      .subscribe();
    return () => { sb.removeChannel(ch1); sb.removeChannel(ch2); sb.removeChannel(ch3); };
  }, []);

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold text-white">TradeBot Dashboard</h1>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <XlmLivePanel
            trades={xlmTrades}
            openPositions={xlmOpen}
            loading={loading}
            botUsdt={xlmSettings?.usdt_balance ?? 0}
            totalUsdt={xlmSettings?.total_usdt ?? 0}
            allBotsUsdt={xlmSettings?.usdt_balance ?? 0}
            enabled={xlmSettings?.enabled ?? false}
            onToggle={handleXlmToggle}
            toggling={xlmToggling}
            onReset={handleXlmReset}
            resetting={xlmResetting}
            onClearHistory={handleXlmClearHistory}
            clearingHistory={xlmClearing}
            runs={xlmRuns}
          />
          <PaperPanel
            trades={trades}
            openPositions={open}
            loading={loading}
          />
        </div>
      </div>
    </main>
  );
}
