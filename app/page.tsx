"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import PnLChart from "@/components/PnLChart";
import BookVolumeChart from "@/components/BookVolumeChart";

function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="bg-gray-800/60 rounded-lg p-3">
      <p className="text-gray-500 text-xs uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${color}`}>{value}</p>
      <p className="text-gray-600 text-xs mt-0.5">{sub}</p>
    </div>
  );
}

type SummaryRow = {
  name: string;
  badge: string;
  trades: number;
  winRate: string;
  winRateNum: number;
  pnl: number;
  pnlDisplay: string;
  positive: boolean;
  returnPct: string;
  returnPctNum: number;
  ratePerDay: number;
  ratePerDayDisplay: string;
  running: string;
  elapsedMs: number;
  holdReturnPctNum: number | null;
  holdReturnDisplay: string;
};

type SortKey = "name" | "pnl" | "returnPctNum" | "ratePerDay" | "winRateNum" | "trades" | "elapsedMs" | "holdReturnPctNum";

function SummaryCards({ rows }: { rows: SummaryRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("ratePerDay");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  const sortedRows = [...rows].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    if (sortKey === "name") return a.name.localeCompare(b.name) * dir;
    const av = a[sortKey] ?? 0;
    const bv = b[sortKey] ?? 0;
    return (av - bv) * dir;
  });

  function SortHeader({ label, sortKey: key, align = "right" }: { label: string; sortKey: SortKey; align?: "left" | "right" }) {
    const active = sortKey === key;
    return (
      <th
        className={`${align === "left" ? "text-left pr-4" : "text-right px-4"} py-2 cursor-pointer select-none hover:text-gray-300`}
        onClick={() => handleSort(key)}
      >
        {label}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
      </th>
    );
  }

  return (
    <div className="bg-gray-900 rounded-xl p-5 overflow-x-auto">
      <h2 className="text-white font-bold text-lg mb-4">Summary — click a column to sort</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs uppercase tracking-wide border-b border-gray-700">
            <SortHeader label="Bot" sortKey="name" align="left" />
            <SortHeader label="PnL" sortKey="pnl" />
            <SortHeader label="Return" sortKey="returnPctNum" />
            <SortHeader label="Buy & Hold" sortKey="holdReturnPctNum" />
            <SortHeader label="Speed" sortKey="ratePerDay" />
            <SortHeader label="Win Rate" sortKey="winRateNum" />
            <SortHeader label="Trades" sortKey="trades" />
            <SortHeader label="Running" sortKey="elapsedMs" />
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((r) => (
            <tr key={r.name} className="border-b border-gray-800/60 hover:bg-gray-800/30">
              <td className="py-3 pr-4">
                <div className="flex items-center gap-2">
                  <span className="text-white font-semibold">{r.name}</span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    r.badge === "LIVE" ? "bg-green-500/20 text-green-400" : "bg-blue-500/20 text-blue-400"
                  }`}>{r.badge}</span>
                </div>
              </td>
              <td className={`text-right py-3 px-4 text-xl font-bold ${r.positive ? "text-green-400" : "text-red-400"}`}>
                {r.pnlDisplay}
              </td>
              <td className={`text-right py-3 px-4 font-semibold ${r.positive ? "text-green-400" : "text-red-400"}`}>
                {r.returnPct}
              </td>
              <td className="text-right py-3 px-4">
                {r.holdReturnPctNum == null ? (
                  <span className="text-gray-600">—</span>
                ) : (
                  <span className={r.holdReturnPctNum >= 0 ? "text-gray-400" : "text-gray-500"}>
                    {r.holdReturnDisplay}
                    {r.returnPctNum >= r.holdReturnPctNum
                      ? <span className="text-green-500 ml-1" title="Beating buy &amp; hold">▲</span>
                      : <span className="text-red-500 ml-1" title="Lagging buy &amp; hold">▼</span>}
                  </span>
                )}
              </td>
              <td className={`text-right py-3 px-4 font-semibold ${r.ratePerDay >= 0 ? "text-green-400" : "text-red-400"}`}>
                {r.ratePerDayDisplay}
              </td>
              <td className="text-right py-3 px-4 text-white">{r.winRate}</td>
              <td className="text-right py-3 px-4 text-white">{r.trades}</td>
              <td className="text-right py-3 pl-4 text-gray-300">{r.running}</td>
            </tr>
          ))}
        </tbody>
      </table>
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

  // Derive SOLBTC price from latest run's CHECK action
  const latestSolPrice: number | null = (() => {
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
        <p className="text-gray-500 text-xs">SOL/BTC · $50 BTC · 15m · RSI 30/70 · 12h EMA(7/25) · limit chase</p>
      </div>

      {/* Stats */}
      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
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

function SolTrailContinuousPanel({
  trades, state, runs, loading,
  enabled, onToggle, toggling,
  onClearHistory, clearingHistory,
}: {
  trades: any[]; state: any; runs: any[]; loading: boolean;
  enabled: boolean; onToggle: () => void; toggling: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
}) {
  const INITIAL  = 20;
  const st   = state;
  const totalPnl = st?.realized_pnl_usd ?? 0;
  const totalTrades = st?.total_trades ?? 0;
  const wins     = st?.total_wins ?? 0;
  const losses   = totalTrades - wins;
  const winRate  = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : "—";
  const mode = st?.mode ?? "USD";

  const [livePrice, setLivePrice] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        // Bitfinex's public API sends no CORS headers, so a direct browser fetch is silently
        // blocked — proxied through our own API route instead (server-to-server, no CORS issue).
        const res = await fetch("/api/bitfinex-price");
        const data = await res.json();
        if (!cancelled && data.lastPrice != null) setLivePrice(data.lastPrice);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const latestPrice: number | null = livePrice ?? (() => {
    for (const r of runs) {
      const actions: any[] = r.data?.actions ?? [];
      for (let i = actions.length - 1; i >= 0; i--) {
        const p = actions[i].price;
        if (p != null) return parseFloat(p);
      }
    }
    return null;
  })();

  const statusText  = mode === "SOL" ? "Holding SOL" : "Holding USD";
  const statusColor = mode === "SOL" ? "text-green-400" : "text-gray-400";
  const chartTrades = trades.map((t: any) => ({ ...t, pnl: t.pnl_usd, exit_time: t.exit_time }));

  const entryValue   = mode === "SOL" && st?.entry_price && st?.sol_quantity
    ? parseFloat(st.entry_price) * parseFloat(st.sol_quantity) : null;
  const currentValue = mode === "SOL" && latestPrice && st?.sol_quantity
    ? parseFloat(st.sol_quantity) * latestPrice : null;
  const openPnl = entryValue != null && currentValue != null ? currentValue - entryValue : null;

  const peakPrice = mode === "SOL" && st?.peak_price ? parseFloat(st.peak_price) : null;
  const stopPrice = mode === "SOL" && st?.stop_price ? parseFloat(st.stop_price) : null;

  const lockAge = st?.lock_heartbeat ? Date.now() - new Date(st.lock_heartbeat).getTime() : null;
  const workerAlive = lockAge != null && lockAge < 30_000;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">SOL OCO Live</h2>
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
              title={enabled ? "Pause bot before clearing" : "Delete all trade history and run logs"}
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
        <p className="text-gray-500 text-xs">CONVERTED 2026-09-04: always-on entry, no filter · fixed OCO bracket TP=+1% / SL=-0.1% (testing the 3mo backtest live — was +77% at optimistic spread, inverted to -1216% at realistic spread) · LIVE · REAL MONEY · $20 seed, compounds · long-only (no shorting on spot)</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="PnL"
            value={`${totalPnl >= 0 ? "+" : ""}${(totalPnl / INITIAL * 100).toFixed(2)}%`}
            sub={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} · ${totalTrades} trades (${wins}W/${losses}L)`}
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
            sub={
              mode === "SOL" && st?.entry_price
                ? `entry $${parseFloat(st.entry_price).toFixed(2)}${latestPrice != null ? ` · now $${latestPrice.toFixed(2)}` : ""}`
                : "watching"
            }
            color={statusColor}
          />
          <Stat
            label="SOL/USD"
            value={latestPrice != null ? `$${latestPrice.toFixed(2)}` : "—"}
            sub={mode === "SOL" && st?.sol_quantity ? `${parseFloat(st.sol_quantity).toFixed(3)} SOL held` : "no position"}
            color="text-yellow-400"
          />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL (USD)</p>
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
                {mode === "SOL" && st?.sol_quantity ? `${parseFloat(st.sol_quantity).toFixed(3)} SOL` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Entry price</td>
              <td className="py-1.5 text-right text-white">
                {mode === "SOL" && st?.entry_price ? `$${parseFloat(st.entry_price).toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Current price</td>
              <td className="py-1.5 text-right text-yellow-400">
                {latestPrice != null ? `$${latestPrice.toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Take profit</td>
              <td className="py-1.5 text-right text-green-400">
                {peakPrice != null ? `$${peakPrice.toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Stop loss</td>
              <td className="py-1.5 text-right text-red-400">
                {stopPrice != null ? `$${stopPrice.toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr>
              <td className="py-1.5 text-gray-400">Open PnL</td>
              <td className={`py-1.5 text-right font-bold ${
                openPnl == null ? "text-gray-600"
                : openPnl >= 0 ? "text-green-400" : "text-red-400"
              }`}>
                {openPnl != null && entryValue
                  ? `${openPnl >= 0 ? "+" : ""}${(openPnl / entryValue * 100).toFixed(2)}% (${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)})`
                  : "—"}
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
                  const isWin = (t.pnl_usd ?? 0) > 0;
                  return (
                    <tr key={t.id} className="hover:bg-gray-800/30">
                      <td className="py-1.5 text-gray-300">${t.entry_price ? parseFloat(t.entry_price).toFixed(2) : "—"}</td>
                      <td className="py-1.5 text-gray-300">${t.exit_price  ? parseFloat(t.exit_price).toFixed(2)  : "—"}</td>
                      <td className={`py-1.5 text-right ${isWin ? "text-green-400" : "text-red-400"}`}>
                        {isWin ? "+" : ""}${(t.pnl_usd ?? 0).toFixed(2)}
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
                  {actions.map((a: any, i: number) => {
                    const color = a.action === "BUY" ? "text-yellow-400"
                      : a.action === "STOP_FILLED" ? (parseFloat(a.pnlUsd) >= 0 ? "text-green-400" : "text-red-400")
                      : a.action === "STATUS" ? "text-gray-500"
                      : "text-gray-500";
                    const text = a.action === "BUY" ? `BUY  qty=${parseFloat(a.qty).toFixed(3)} @ $${parseFloat(a.price).toFixed(2)}`
                      : a.action === "STOP_FILLED" ? `STOP HIT  @ $${parseFloat(a.price).toFixed(2)}  pnl ${parseFloat(a.pnlUsd) >= 0 ? "+" : ""}$${parseFloat(a.pnlUsd).toFixed(4)} (${parseFloat(a.pnlPct).toFixed(4)}%)`
                      : a.action === "STATUS" ? `watching  ${a.mode}  bid=${a.bid != null ? `$${parseFloat(a.bid).toFixed(2)}` : "—"}  ask=${a.ask != null ? `$${parseFloat(a.ask).toFixed(2)}` : "—"}  peak=${a.peak != null ? `$${parseFloat(a.peak).toFixed(2)}` : "—"}  stop=${a.stop != null ? `$${parseFloat(a.stop).toFixed(2)}` : "—"}`
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

function SolJumpTrailBitfinexPanel({
  log, state, loading,
  enabled, onToggle, toggling,
  onClearHistory, clearingHistory,
}: {
  log: any[]; state: any; loading: boolean;
  enabled: boolean; onToggle: () => void; toggling: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
}) {
  const st = state;
  const latest = log.length > 0 ? log[log.length - 1] : null;
  const price = latest ? parseFloat(latest.price) : null;
  const imbalance25 = latest?.imbalance_25 != null ? parseFloat(latest.imbalance_25) : null;
  const imbalance100 = latest?.imbalance_100 != null ? parseFloat(latest.imbalance_100) : null;
  const imbalance250 = latest ? parseFloat(latest.imbalance) : null;
  const binanceBid = latest?.binance_bid != null ? parseFloat(latest.binance_bid) : null;
  const binanceAsk = latest?.binance_ask != null ? parseFloat(latest.binance_ask) : null;
  const bitfinexAsk = latest?.bitfinex_ask != null ? parseFloat(latest.bitfinex_ask) : null;
  const gapPct = binanceAsk != null && bitfinexAsk != null ? (binanceAsk - bitfinexAsk) / bitfinexAsk * 100 : null;
  const bitstampAsk = latest?.bitstamp_ask != null ? parseFloat(latest.bitstamp_ask) : null;
  const bitstampGapPct = bitstampAsk != null && bitfinexAsk != null ? (bitstampAsk - bitfinexAsk) / bitfinexAsk * 100 : null;

  const lockAge = st?.lock_heartbeat ? Date.now() - new Date(st.lock_heartbeat).getTime() : null;
  const workerAlive = lockAge != null && lockAge < 30_000;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">SOL Book Volume Log</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400">RESEARCH</span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${workerAlive ? "bg-green-500/20 text-green-400" : "bg-gray-700/40 text-gray-500"}`}>
              {workerAlive ? "worker alive" : "worker offline"}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onClearHistory}
              disabled={clearingHistory || enabled}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              title={enabled ? "Pause logger before clearing" : "Delete all logged data"}
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
        <p className="text-gray-500 text-xs">No trading, no signal — pure research logger. Records real Bitfinex order book volume and price every 5s, imbalance ratio at 3 depths (25/100/250 levels — 250 alone found too sluggish to react to real price moves), plus Binance's real bid/ask for the cross-venue gap.</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <Stat
            label="SOL/USD"
            value={price != null ? `$${price.toFixed(2)}` : "—"}
            sub={`${log.length} samples logged`}
            color="text-yellow-400"
          />
          <Stat
            label="Binance-Bitfinex gap"
            value={gapPct != null ? `${gapPct.toFixed(4)}%` : "—"}
            sub={binanceAsk != null ? `Binance ask $${binanceAsk.toFixed(2)}` : "waiting for Binance"}
            color="text-orange-400"
          />
          <Stat
            label="Bitstamp-Bitfinex gap"
            value={bitstampGapPct != null ? `${bitstampGapPct.toFixed(4)}%` : "—"}
            sub={bitstampAsk != null ? `Bitstamp ask $${bitstampAsk.toFixed(2)}` : "waiting for Bitstamp"}
            color="text-pink-400"
          />
          <Stat
            label="Imbalance (25)"
            value={imbalance25 != null ? imbalance25.toFixed(3) : "—"}
            sub="top 25 levels"
            color="text-blue-400"
          />
          <Stat
            label="Imbalance (100)"
            value={imbalance100 != null ? imbalance100.toFixed(3) : "—"}
            sub="top 100 levels"
            color="text-purple-400"
          />
          <Stat
            label="Imbalance (250)"
            value={imbalance250 != null ? imbalance250.toFixed(3) : "—"}
            sub="top 250 levels"
            color="text-emerald-400"
          />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Price vs Imbalance at 3 depths</p>
        <BookVolumeChart log={log} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Samples</p>
        {loading ? (
          <div className="animate-pulse space-y-2">
            {[...Array(3)].map((_, i) => <div key={i} className="h-8 bg-gray-800 rounded" />)}
          </div>
        ) : log.length === 0 ? (
          <p className="text-gray-600 text-sm">No samples yet</p>
        ) : (
          <div className="overflow-auto h-56 pr-4">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800 sticky top-0 bg-gray-900">
                  <th className="text-left pb-1">Time</th>
                  <th className="text-right pb-1">Price</th>
                  <th className="text-right pb-1">Imb 25</th>
                  <th className="text-right pb-1">Imb 100</th>
                  <th className="text-right pb-1">Imb 250</th>
                  <th className="text-right pb-1 pr-1">Gap %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {log.slice().reverse().slice(0, 60).map((r: any) => {
                  const imb25 = r.imbalance_25 != null ? parseFloat(r.imbalance_25) : null;
                  const imb100 = r.imbalance_100 != null ? parseFloat(r.imbalance_100) : null;
                  const imb250 = parseFloat(r.imbalance);
                  const rPrice = parseFloat(r.price);
                  const rBinanceAsk = r.binance_ask != null ? parseFloat(r.binance_ask) : null;
                  const rBitfinexAsk = r.bitfinex_ask != null ? parseFloat(r.bitfinex_ask) : null;
                  const rGap = rBinanceAsk != null && rBitfinexAsk != null ? (rBinanceAsk - rBitfinexAsk) / rBitfinexAsk * 100 : null;
                  return (
                    <tr key={r.id} className="hover:bg-gray-800/30">
                      <td className="py-1 text-gray-500">{new Date(r.logged_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</td>
                      <td className="py-1 text-right text-yellow-400">${rPrice.toFixed(2)}</td>
                      <td className="py-1 text-right text-blue-400">{imb25 != null ? imb25.toFixed(3) : "—"}</td>
                      <td className="py-1 text-right text-purple-400">{imb100 != null ? imb100.toFixed(3) : "—"}</td>
                      <td className="py-1 text-right text-emerald-400">{imb250.toFixed(3)}</td>
                      <td className="py-1 text-right pr-1 text-orange-400">{rGap != null ? rGap.toFixed(4) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SolEmaVwapPanel({
  trades, state, runs, loading,
  enabled, onToggle, toggling,
  onClearHistory, clearingHistory,
}: {
  trades: any[]; state: any; runs: any[]; loading: boolean;
  enabled: boolean; onToggle: () => void; toggling: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
}) {
  const INITIAL = 100;
  const st = state;
  const totalPnl = st?.realized_pnl_usd ?? 0;
  const totalTrades = st?.total_trades ?? 0;
  const wins = st?.total_wins ?? 0;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : "—";
  const posState: string = st?.position_state ?? "FLAT";
  const holding = posState === "FULL" || posState === "HALF";

  const [livePrice, setLivePrice] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/bitfinex-price");
        const data = await res.json();
        if (!cancelled && data.lastPrice != null) setLivePrice(data.lastPrice);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const statusText: Record<string, string> = { FLAT: "Watching", ARMED: "Armed (waiting for bounce)", FULL: "Holding (full)", HALF: "Holding (half, breakeven)" };
  const statusColor: Record<string, string> = { FLAT: "text-gray-400", ARMED: "text-yellow-400", FULL: "text-green-400", HALF: "text-blue-400" };
  const chartTrades = trades.map((t: any) => ({ ...t, pnl: t.pnl_usd, exit_time: t.exit_time }));

  const entryValue = holding && st?.entry_price && st?.remaining_qty
    ? parseFloat(st.entry_price) * parseFloat(st.remaining_qty) : null;
  const currentValue = holding && livePrice && st?.remaining_qty
    ? parseFloat(st.remaining_qty) * livePrice : null;
  const openPnl = entryValue != null && currentValue != null ? currentValue - entryValue : null;

  // Only meaningful state-change actions -- CHECK/WAITING fire every minute and would flood this.
  const meaningfulActions = new Set(["ARM", "DISARM", "ENTER", "TP_PARTIAL", "BREAKEVEN_EXIT", "SL_FULL", "ERROR"]);
  const activityRuns = runs.filter((r: any) => (r.data?.actions ?? []).some((a: any) => meaningfulActions.has(a.action)));

  const lastRunAt = runs[0]?.run_at ? new Date(runs[0].run_at).getTime() : null;
  const workerAlive = lastRunAt != null && Date.now() - lastRunAt < 3 * 60_000; // cron runs every 1min, allow some slack

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">SOL EMA/VWAP Scalper</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">PAPER</span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${workerAlive ? "bg-green-500/20 text-green-400" : "bg-gray-700/40 text-gray-500"}`}>
              {workerAlive ? "cron alive" : "cron offline"}
            </span>
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
        <p className="text-gray-500 text-xs">EMA9/EMA21 cross arms the signal, entry on the retrace-and-bounce off VWAP (5m candles, 15m trend filter) · long-only · PAPER · $100 seed · SL = VWAP - 0.05%, TP = entry + 2x risk · half closed at TP, rest rides at breakeven · runs every 1min via cron, not a live worker</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="PnL"
            value={`${totalPnl >= 0 ? "+" : ""}${(totalPnl / INITIAL * 100).toFixed(2)}%`}
            sub={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} · ${totalTrades} trades (${wins}W/${losses}L)`}
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
            value={statusText[posState] ?? posState}
            sub={holding && st?.entry_price ? `entry $${parseFloat(st.entry_price).toFixed(2)}` : "watching for EMA cross"}
            color={statusColor[posState] ?? "text-gray-400"}
          />
          <Stat
            label="SOL/USD"
            value={livePrice != null ? `$${livePrice.toFixed(2)}` : "—"}
            sub={holding && st?.remaining_qty ? `${parseFloat(st.remaining_qty).toFixed(3)} SOL held` : "no position"}
            color="text-yellow-400"
          />
        </div>
      )}

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL (USD)</p>
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
              <td className="py-1.5 text-gray-400">Status</td>
              <td className={`py-1.5 text-right font-bold ${statusColor[posState] ?? "text-gray-400"}`}>{statusText[posState] ?? posState}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">SOL held</td>
              <td className="py-1.5 text-right text-white">
                {holding && st?.remaining_qty ? `${parseFloat(st.remaining_qty).toFixed(3)} SOL` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Entry price</td>
              <td className="py-1.5 text-right text-white">
                {holding && st?.entry_price ? `$${parseFloat(st.entry_price).toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Current price</td>
              <td className="py-1.5 text-right text-yellow-400">
                {livePrice != null ? `$${livePrice.toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Take profit</td>
              <td className="py-1.5 text-right text-green-400">
                {holding && st?.tp_price ? `$${parseFloat(st.tp_price).toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Stop loss</td>
              <td className="py-1.5 text-right text-red-400">
                {holding && st?.sl_price ? `$${parseFloat(st.sl_price).toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr>
              <td className="py-1.5 text-gray-400">Open PnL</td>
              <td className={`py-1.5 text-right font-bold ${
                openPnl == null ? "text-gray-600"
                : openPnl >= 0 ? "text-green-400" : "text-red-400"
              }`}>
                {openPnl != null && entryValue
                  ? `${openPnl >= 0 ? "+" : ""}${(openPnl / entryValue * 100).toFixed(2)}% (${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)})`
                  : "—"}
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
                  <th className="text-left pb-1">Reason</th>
                  <th className="text-left pb-1">Entry</th>
                  <th className="text-left pb-1">Exit</th>
                  <th className="text-right pb-1">PnL</th>
                  <th className="text-right pb-1">%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {trades.slice(0, 8).map((t: any) => {
                  const isWin = (t.pnl_usd ?? 0) > 0;
                  return (
                    <tr key={t.id} className="hover:bg-gray-800/30">
                      <td className={`py-1.5 ${t.exit_reason === "SL" ? "text-red-400" : "text-green-400"}`}>{t.exit_reason}</td>
                      <td className="py-1.5 text-gray-300">${t.entry_price ? parseFloat(t.entry_price).toFixed(2) : "—"}</td>
                      <td className="py-1.5 text-gray-300">${t.exit_price  ? parseFloat(t.exit_price).toFixed(2)  : "—"}</td>
                      <td className={`py-1.5 text-right ${isWin ? "text-green-400" : "text-red-400"}`}>
                        {isWin ? "+" : ""}${(t.pnl_usd ?? 0).toFixed(2)}
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
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Activity (state changes only)</p>
        <div className="h-56 overflow-y-auto space-y-0.5 font-mono text-sm pr-1">
          {activityRuns.length === 0 && <p className="text-gray-600">No state changes yet — waiting for an EMA cross.</p>}
          {activityRuns.map((r: any) => {
            const actions: any[] = (r.data?.actions ?? []).filter((a: any) => meaningfulActions.has(a.action));
            const time = r.run_at
              ? new Date(r.run_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
              : "";
            return (
              <div key={r.id} className="flex gap-2 items-start">
                <span className="text-gray-600 shrink-0">{time}</span>
                <div className="flex flex-col gap-0">
                  {actions.map((a: any, i: number) => {
                    const color = a.action === "ENTER" ? "text-yellow-400"
                      : a.action === "ARM" ? "text-blue-400"
                      : a.action === "DISARM" ? "text-gray-500"
                      : a.action === "TP_PARTIAL" ? "text-green-400"
                      : a.action === "BREAKEVEN_EXIT" ? "text-gray-400"
                      : a.action === "SL_FULL" ? "text-red-400"
                      : a.action === "ERROR" ? "text-red-400"
                      : "text-gray-500";
                    const text = a.action === "ENTER" ? `ENTER  qty=${parseFloat(a.qty).toFixed(3)} @ $${parseFloat(a.price).toFixed(2)}  SL=$${parseFloat(a.sl).toFixed(2)}  TP=$${parseFloat(a.tp).toFixed(2)}`
                      : a.action === "ARM" ? `ARMED — EMA9 crossed above EMA21`
                      : a.action === "DISARM" ? `DISARMED — ${a.reason}`
                      : a.action === "TP_PARTIAL" ? `TP HIT (half closed)  @ $${parseFloat(a.price).toFixed(2)}  pnl=$${a.pnlUsd}`
                      : a.action === "BREAKEVEN_EXIT" ? `BREAKEVEN EXIT (remaining half)  @ $${parseFloat(a.price).toFixed(2)}  pnl=$${a.pnlUsd}`
                      : a.action === "SL_FULL" ? `STOP HIT  @ $${parseFloat(a.price).toFixed(2)}  pnl=$${a.pnlUsd}`
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
  const [summaryData, setSummaryData] = useState<SummaryRow[] | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [solTrailContinuousState,   setSolTrailContinuousState]   = useState<any>(null);
  const [solTrailContinuousTrades,  setSolTrailContinuousTrades]  = useState<any[]>([]);
  const [solTrailContinuousRuns,    setSolTrailContinuousRuns]    = useState<any[]>([]);
  const [solTrailContinuousToggling, setSolTrailContinuousToggling] = useState(false);
  const [solTrailContinuousClearing, setSolTrailContinuousClearing] = useState(false);
  const [solJumpTrailState,   setSolJumpTrailState]   = useState<any>(null);
  const [solBookVolumeLog,    setSolBookVolumeLog]    = useState<any[]>([]);
  const [solJumpTrailToggling, setSolJumpTrailToggling] = useState(false);
  const [solJumpTrailClearing, setSolJumpTrailClearing] = useState(false);
  const [solEmaVwapState,   setSolEmaVwapState]   = useState<any>(null);
  const [solEmaVwapTrades,  setSolEmaVwapTrades]  = useState<any[]>([]);
  const [solEmaVwapRuns,    setSolEmaVwapRuns]    = useState<any[]>([]);
  const [solEmaVwapToggling, setSolEmaVwapToggling] = useState(false);
  const [solEmaVwapClearing, setSolEmaVwapClearing] = useState(false);

  async function load() {
    const [
      { data: surferSt },
      { data: surferTr },
      { data: surferRs },
      { data: surferUsdtSt },
      { data: surferUsdtTr },
      { data: surferUsdtRs },
      { data: solTrailContinuousSt },
      { data: solTrailContinuousTr },
      { data: solTrailContinuousRs },
      { data: solJumpTrailSt },
      { data: solBookVolumeLog },
      { data: solEmaVwapSt },
      { data: solEmaVwapTr },
      { data: solEmaVwapRs },
    ] = await Promise.all([
      getSupabase().from("surfer_state").select("*").eq("id", 1).single(),
      getSupabase().from("surfer_trades").select("*").order("exit_time", { ascending: false }).limit(5000),
      getSupabase().from("surfer_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
      getSupabase().from("surfer_usdt_state").select("*").eq("id", 1).single(),
      getSupabase().from("surfer_usdt_trades").select("*").order("exit_time", { ascending: false }).limit(5000),
      getSupabase().from("surfer_usdt_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
      getSupabase().from("sol_trail_continuous_state").select("*").eq("id", 1).single(),
      getSupabase().from("sol_trail_continuous_trades").select("*").order("exit_time", { ascending: false }).limit(5000),
      getSupabase().from("sol_trail_continuous_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
      getSupabase().from("sol_jump_trail_bitfinex_state").select("*").eq("id", 1).single(),
      getSupabase().from("sol_book_volume_log").select("*").order("logged_at", { ascending: false }).limit(300),
      getSupabase().from("sol_ema_vwap_state").select("*").eq("id", 1).single(),
      getSupabase().from("sol_ema_vwap_trades").select("*").order("exit_time", { ascending: false }).limit(5000),
      getSupabase().from("sol_ema_vwap_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
    ]);
    setSurferState(surferSt ?? null);
    setSurferTrades(surferTr ?? []);
    setSurferRuns(surferRs ?? []);
    setSurferUsdtState(surferUsdtSt ?? null);
    setSurferUsdtTrades(surferUsdtTr ?? []);
    setSurferUsdtRuns(surferUsdtRs ?? []);
    setSolTrailContinuousState(solTrailContinuousSt ?? null);
    setSolTrailContinuousTrades(solTrailContinuousTr ?? []);
    setSolTrailContinuousRuns(solTrailContinuousRs ?? []);
    setSolJumpTrailState(solJumpTrailSt ?? null);
    setSolBookVolumeLog((solBookVolumeLog ?? []).slice().reverse());
    setSolEmaVwapState(solEmaVwapSt ?? null);
    setSolEmaVwapTrades(solEmaVwapTr ?? []);
    setSolEmaVwapRuns(solEmaVwapRs ?? []);
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

  async function handleSolTrailContinuousToggle() {
    setSolTrailContinuousToggling(true);
    await fetch("/api/sol-trail-continuous/toggle", { method: "POST" });
    await load();
    setSolTrailContinuousToggling(false);
  }

  async function handleSolTrailContinuousClearHistory() {
    if (!confirm("Delete all SOL OCO Live trade history and run logs?")) return;
    setSolTrailContinuousClearing(true);
    await fetch("/api/sol-trail-continuous/clear-history", { method: "POST" });
    await load();
    setSolTrailContinuousClearing(false);
  }

  async function handleSolJumpTrailToggle() {
    setSolJumpTrailToggling(true);
    await fetch("/api/sol-jump-trail-bitfinex/toggle", { method: "POST" });
    await load();
    setSolJumpTrailToggling(false);
  }

  async function handleSolJumpTrailClearHistory() {
    if (!confirm("Delete all SOL Jump Trail trade history and run logs?")) return;
    setSolJumpTrailClearing(true);
    await fetch("/api/sol-jump-trail-bitfinex/clear-history", { method: "POST" });
    await load();
    setSolJumpTrailClearing(false);
  }

  async function handleSolEmaVwapToggle() {
    setSolEmaVwapToggling(true);
    await fetch("/api/sol-ema-vwap/toggle", { method: "POST" });
    await load();
    setSolEmaVwapToggling(false);
  }

  async function handleSolEmaVwapClearHistory() {
    if (!confirm("Delete all EMA/VWAP trade history and run logs?")) return;
    setSolEmaVwapClearing(true);
    await fetch("/api/sol-ema-vwap/clear-history", { method: "POST" });
    await load();
    setSolEmaVwapClearing(false);
  }

  function formatElapsed(ms: number): string {
    if (ms <= 0) return "just started";
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const remMins = mins % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${remMins}m`;
    return `${remMins}m`;
  }

  async function handleShowSummary() {
    setSummaryLoading(true);
    const sb = getSupabase();

    // Surfer SOLBTC's first real trade sized $50 as 0.00075241 BTC at deployment —
    // same $50 seed as every other bot, just BTC-denominated.
    const SURFER_BTC_INITIAL = 0.00075241;

    // venue/symbol for the buy-and-hold comparison — the asset each bot actually trades
    const bots = [
      { name: "Surfer SOLBTC",  badge: "LIVE",  state: surferState,     runsTable: "surfer_runs",         pnlField: "realized_pnl_btc",  initial: SURFER_BTC_INITIAL, unit: "₿", venue: "us" as const, symbol: "SOLBTC" },
      { name: "Surfer SOLUSDT", badge: "LIVE",  state: surferUsdtState, runsTable: "surfer_usdt_runs",    pnlField: "realized_pnl_usdt", initial: 50, unit: "$", venue: "us" as const,       symbol: "SOLUSDT" },
      { name: "SOL OCO Live", badge: "LIVE", state: solTrailContinuousState, runsTable: "sol_trail_continuous_runs", pnlField: "realized_pnl_usd", initial: 20, unit: "$", venue: "bitfinex" as const, symbol: "tSOLUSD" },
    ];

    const rows: SummaryRow[] = [];

    for (const b of bots) {
      const { data: firstRun } = await sb.from(b.runsTable).select("run_at").order("run_at", { ascending: true }).limit(1).single();
      const startMs = firstRun?.run_at ? new Date(firstRun.run_at).getTime() : null;
      const elapsedMs = startMs ? Date.now() - startMs : 0;
      const running = startMs ? formatElapsed(elapsedMs) : "unknown";
      const days = Math.max(elapsedMs / 86400000, 1 / 24); // floor at 1 hour to avoid divide-by-near-zero
      const pnl = b.state?.[b.pnlField] ?? 0;
      const trades = b.state?.total_trades ?? 0;
      const wins = b.state?.total_wins ?? 0;
      const winRateNum = trades > 0 ? (wins / trades * 100) : -1;
      const winRate = trades > 0 ? `${winRateNum.toFixed(1)}%` : "—";
      const returnPctNum = pnl / b.initial * 100;
      const returnPct = `${returnPctNum >= 0 ? "+" : ""}${returnPctNum.toFixed(1)}%`;
      const ratePerDay = returnPctNum / days;
      const ratePerDayDisplay = `${ratePerDay >= 0 ? "+" : ""}${ratePerDay.toFixed(2)}%/day`;

      let holdReturnPctNum: number | null = null;
      let holdReturnDisplay = "—";
      if (startMs) {
        try {
          const res = await fetch(`/api/buy-hold?venue=${b.venue}&symbol=${b.symbol}&sinceMs=${startMs}`);
          const data = await res.json();
          if (data.ok) {
            const pct: number = data.pctChange;
            holdReturnPctNum = pct;
            holdReturnDisplay = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
          }
        } catch { /* leave as unknown */ }
      }

      rows.push({
        name: b.name, badge: b.badge, trades, winRate, winRateNum, running, elapsedMs,
        pnl,
        pnlDisplay: b.unit === "₿" ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(8)}₿` : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
        positive: pnl >= 0, returnPct, returnPctNum, ratePerDay, ratePerDayDisplay,
        holdReturnPctNum, holdReturnDisplay,
      });
    }

    rows.sort((a, b) => b.ratePerDay - a.ratePerDay);
    setSummaryData(rows);
    setSummaryLoading(false);
  }

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
    const ch17 = sb.channel("sol-trail-continuous")
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_trail_continuous_state" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_trail_continuous_trades" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_trail_continuous_runs" }, debouncedLoad)
      .subscribe();
    const ch18 = sb.channel("sol-jump-trail-bitfinex")
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_jump_trail_bitfinex_state" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_book_volume_log" }, debouncedLoad)
      .subscribe();
    const ch19 = sb.channel("sol-ema-vwap")
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_ema_vwap_state" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_ema_vwap_trades" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_ema_vwap_runs" }, debouncedLoad)
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      sb.removeChannel(ch1); sb.removeChannel(ch2); sb.removeChannel(ch17); sb.removeChannel(ch18); sb.removeChannel(ch19);
    };
  }, []);

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">TradeBot Dashboard</h1>
          <button
            onClick={handleShowSummary}
            disabled={summaryLoading}
            className="text-xs font-semibold px-3 py-1.5 rounded-md bg-gray-800 text-gray-300 hover:bg-gray-700 transition-all disabled:opacity-50"
          >
            {summaryLoading ? "Loading…" : "Show Summary"}
          </button>
        </div>

        {summaryData && <SummaryCards rows={summaryData} />}

        {/* ── Live bots ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
          <SurferUsdtPanel
            trades={surferUsdtTrades}
            surferState={surferUsdtState}
            runs={surferUsdtRuns}
            loading={loading}
            enabled={surferUsdtState?.enabled ?? false}
            onToggle={handleSurferUsdtToggle}
            toggling={surferUsdtToggling}
            onSellAll={handleSurferUsdtSellAll}
            sellingAll={surferUsdtSellingAll}
            onClearHistory={handleSurferUsdtClearHistory}
            clearingHistory={surferUsdtClearing}
          />
          <SurferPanel
            trades={surferTrades}
            surferState={surferState}
            runs={surferRuns}
            loading={loading}
            enabled={surferState?.enabled ?? false}
            onToggle={handleSurferToggle}
            toggling={surferToggling}
            onSellAll={handleSurferSellAll}
            sellingAll={surferSellingAll}
            onClearHistory={handleSurferClearHistory}
            clearingHistory={surferClearing}
          />
        </div>

        {/* ── Bitfinex Trail: always-on continuous worker ── */}
        <div className="grid grid-cols-1 gap-6 items-start">
          <SolTrailContinuousPanel
            trades={solTrailContinuousTrades}
            state={solTrailContinuousState}
            runs={solTrailContinuousRuns}
            loading={loading}
            enabled={solTrailContinuousState?.enabled ?? false}
            onToggle={handleSolTrailContinuousToggle}
            toggling={solTrailContinuousToggling}
            onClearHistory={handleSolTrailContinuousClearHistory}
            clearingHistory={solTrailContinuousClearing}
          />
        </div>

        {/* ── Book volume research logger: full width for more room to analyze ── */}
        <div className="grid grid-cols-1 gap-6 items-start">
          <SolJumpTrailBitfinexPanel
            log={solBookVolumeLog}
            state={solJumpTrailState}
            loading={loading}
            enabled={solJumpTrailState?.enabled ?? false}
            onToggle={handleSolJumpTrailToggle}
            toggling={solJumpTrailToggling}
            onClearHistory={handleSolJumpTrailClearHistory}
            clearingHistory={solJumpTrailClearing}
          />
        </div>

        {/* ── EMA9/EMA21 + VWAP scalper: cron-based, below the always-on workers ── */}
        <div className="grid grid-cols-1 gap-6 items-start">
          <SolEmaVwapPanel
            trades={solEmaVwapTrades}
            state={solEmaVwapState}
            runs={solEmaVwapRuns}
            loading={loading}
            enabled={solEmaVwapState?.enabled ?? false}
            onToggle={handleSolEmaVwapToggle}
            toggling={solEmaVwapToggling}
            onClearHistory={handleSolEmaVwapClearHistory}
            clearingHistory={solEmaVwapClearing}
          />
        </div>

      </div>
    </main>
  );
}
