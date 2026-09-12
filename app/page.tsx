"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import PnLChart from "@/components/PnLChart";
import { SEED_USD as DCA_SEED_USD, TRAIL_PCT as DCA_TRAIL_PCT, DCA_DROP_PCT, MULT as DCA_MULT, TP_PCT as DCA_TP_PCT, RESERVE_DIVISOR as DCA_RESERVE_DIVISOR } from "@/lib/sol-dca-config";
import { SEED_USD as HT_SEED_USD, dropPctForLevel as htDropPctForLevel } from "@/lib/sol-hypertrade-config";

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

function SolDcaBitfinexPanel({
  trades, state, runs, loading,
  enabled, onToggle, toggling,
  onClearHistory, clearingHistory,
}: {
  trades: any[]; state: any; runs: any[]; loading: boolean;
  enabled: boolean; onToggle: () => void; toggling: boolean;
  onClearHistory: () => void; clearingHistory: boolean;
}) {
  const SEED = DCA_SEED_USD;
  const st = state;
  const balance = st?.balance ?? SEED;
  const totalPnl = st?.realized_pnl_usd ?? 0;
  const totalTrades = st?.total_trades ?? 0;
  const wins = st?.total_wins ?? 0;
  const losses = totalTrades - wins;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : "—";
  const mode = st?.mode ?? "USD";
  const positions: any[] = st?.positions ?? [];
  const dcaCount = st?.dca_count ?? 0;

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

  const statusText = mode === "SOL" ? `Holding (level ${dcaCount + 1})` : "Watching (5m signal)";
  const statusColor = mode === "SOL" ? (st?.dca_triggered ? "text-yellow-400" : "text-green-400") : "text-gray-400";
  const chartTrades = trades.map((t: any) => ({ ...t, pnl: t.pnl_usd, exit_time: t.exit_time }));

  const totalCost = st?.total_cost ?? 0;
  const totalSolQty = positions.reduce((s: number, p: any) => s + (p.sol_qty ?? 0), 0);
  const portfolioValue = mode === "SOL" && livePrice ? totalSolQty * livePrice : null;
  const openPnl = portfolioValue != null && totalCost > 0 ? portfolioValue - totalCost : null;

  const maxPrice = st?.max_price ? parseFloat(st.max_price) : null;
  const trailStop = maxPrice != null ? maxPrice * (1 - DCA_TRAIL_PCT / 100) : null;
  const tpTarget = st?.tp_target ? parseFloat(st.tp_target) : null;

  const lockAge = st?.lock_heartbeat ? Date.now() - new Date(st.lock_heartbeat).getTime() : null;
  const workerAlive = lockAge != null && lockAge < 30_000;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">SOL DCA-Martingale Live (Worker 1)</h2>
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
              title={enabled ? "Pause bot before clearing" : `Delete all trade history and run logs, reset balance to $${DCA_SEED_USD}`}
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
        <p className="text-gray-500 text-xs">VWAP(24h)+EMA(9/20)+volume-expansion entry on 5m candles, long-only · trail {DCA_TRAIL_PCT}% (arms only once profitable) · DCA rescue at -{DCA_DROP_PCT}% per level, {DCA_MULT}x size, +{DCA_TP_PCT}% blended TP, uncapped · position size compounds: balance ÷ {DCA_RESERVE_DIVISOR} per new trade · orders + fills over WS (same fast path as Worker 2), bid/ask from the real order book · LIVE · REAL MONEY · ${DCA_SEED_USD} seed</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="PnL"
            value={`${totalPnl >= 0 ? "+" : ""}${(totalPnl / SEED * 100).toFixed(2)}%`}
            sub={`${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} · balance $${balance.toFixed(2)}`}
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
            sub={mode === "SOL" ? `${totalSolQty.toFixed(4)} SOL, $${totalCost.toFixed(2)} deployed` : "flat"}
            color={statusColor}
          />
          <Stat
            label="SOL/USD"
            value={livePrice != null ? `$${livePrice.toFixed(2)}` : "—"}
            sub={
              (mode === "SOL" && st?.dca_triggered ? `TP target $${tpTarget?.toFixed(2)}` : mode === "SOL" ? `trail stop $${trailStop?.toFixed(2)}` : "watching") +
              (liveSpreadPct != null ? ` · spread ${liveSpreadPct.toFixed(4)}%` : "")
            }
            color="text-yellow-400"
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
              <td className="py-1.5 text-gray-400">Mode</td>
              <td className={`py-1.5 text-right font-bold ${statusColor}`}>{statusText}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">SOL held</td>
              <td className="py-1.5 text-right text-white">
                {mode === "SOL" ? `${totalSolQty.toFixed(4)} SOL` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Entry price (level 1)</td>
              <td className="py-1.5 text-right text-white">
                {mode === "SOL" && st?.entry_price ? `$${parseFloat(st.entry_price).toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Last entry price</td>
              <td className="py-1.5 text-right text-white">
                {mode === "SOL" && st?.last_entry_price ? `$${parseFloat(st.last_entry_price).toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Current price (spread)</td>
              <td className="py-1.5 text-right text-yellow-400">
                {livePrice != null ? `$${livePrice.toFixed(2)}` : "—"}
                {liveSpreadPct != null ? <span className="text-gray-500"> ({liveSpreadPct.toFixed(4)}%)</span> : null}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Peak since entry</td>
              <td className="py-1.5 text-right text-green-400">
                {mode === "SOL" && maxPrice != null ? `$${maxPrice.toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">Trailing stop</td>
              <td className="py-1.5 text-right text-red-400">
                {mode === "SOL" && !st?.dca_triggered && trailStop != null ? `$${trailStop.toFixed(2)}` : "—"}
              </td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">DCA level / TP target</td>
              <td className="py-1.5 text-right text-orange-400">
                {mode === "SOL"
                  ? st?.dca_triggered
                    ? `level ${dcaCount + 1}, target $${tpTarget?.toFixed(2)}`
                    : `level 1 (no DCA yet)`
                  : "—"}
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
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL (USD)</p>
        <PnLChart trades={chartTrades} initial={SEED} />
      </div>

      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">DCA Legs ({positions.length} leg{positions.length === 1 ? "" : "s"})</p>
        {mode !== "SOL" || positions.length === 0 ? (
          <p className="text-gray-600 text-sm">No open position — watching for entry signal</p>
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
                  <td className="py-1.5 text-right text-white">${parseFloat(p.price).toFixed(2)}</td>
                  <td className="py-1.5 text-right text-white">${parseFloat(p.usd_size).toFixed(2)}</td>
                  <td className="py-1.5 text-right text-white">{parseFloat(p.sol_qty).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
                  <th className="text-left pb-1">Levels</th>
                  <th className="text-left pb-1">Exit reason</th>
                  <th className="text-right pb-1">PnL</th>
                  <th className="text-right pb-1">%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {trades.slice(0, 8).map((t: any) => {
                  const isWin = (t.pnl_usd ?? 0) > 0;
                  return (
                    <tr key={t.id} className="hover:bg-gray-800/30">
                      <td className="py-1.5 text-gray-300">{(t.dca_levels ?? 0) + 1}</td>
                      <td className="py-1.5 text-gray-300">{t.exit_reason ?? "—"}</td>
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
                    const color = a.action === "ENTRY" ? "text-yellow-400"
                      : a.action === "DCA_ADD" ? "text-orange-400"
                      : a.action === "EXIT_TRAIL" || a.action === "EXIT_DCA_TP" ? (parseFloat(a.pnlUsd) >= 0 ? "text-green-400" : "text-red-400")
                      : a.action === "HOLD_DCA" ? "text-gray-500"
                      : a.action === "SIGNAL_CHECK" ? (a.stage?.startsWith("ARMED") ? "text-yellow-400" : a.longTrend ? "text-blue-400" : "text-gray-600")
                      : a.action === "CHECK" ? "text-gray-600"
                      : a.action === "ERROR" ? "text-red-400"
                      : "text-gray-500";
                    const text = a.action === "ENTRY" ? `ENTRY  $${a.usdSize?.toFixed?.(2) ?? a.usdSize} @ $${parseFloat(a.price).toFixed(2)}`
                      : a.action === "DCA_ADD" ? `DCA_ADD level=${a.level}  $${a.usdSize?.toFixed?.(2) ?? a.usdSize} @ $${parseFloat(a.price).toFixed(2)}  tpTarget=$${a.tpTarget?.toFixed?.(2) ?? a.tpTarget}`
                      : a.action === "EXIT_TRAIL" ? `EXIT_TRAIL  @ $${parseFloat(a.price).toFixed(2)}  pnl $${a.pnlUsd}  balance=$${a.newBalance}`
                      : a.action === "EXIT_DCA_TP" ? `EXIT_DCA_TP  @ $${parseFloat(a.price).toFixed(2)}  pnl $${a.pnlUsd}  balance=$${a.newBalance}`
                      : a.action === "HOLD_DCA" ? `holding  dca=${a.dcaCount}  cost=$${a.totalCost?.toFixed?.(2) ?? a.totalCost}  target=$${a.tpTarget?.toFixed?.(2) ?? a.tpTarget}  value=$${a.portfolioValue?.toFixed?.(2) ?? a.portfolioValue}`
                      : a.action === "SIGNAL_CHECK" ? `5m check: ${a.stage}  ($${parseFloat(a.price).toFixed(2)}, vwap=$${parseFloat(a.vwap).toFixed(2)})`
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

  const chartTrades = trades.map((t: any) => ({ ...t, pnl: t.pnl_usd, exit_time: t.exit_time }));

  const lockAge = st?.lock_heartbeat ? Date.now() - new Date(st.lock_heartbeat).getTime() : null;
  const workerAlive = lockAge != null && lockAge < 30_000;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">SOL Hypertrade Paper (Worker 2)</h2>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">PAPER</span>
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
        <p className="text-gray-500 text-xs">Continuous grid, no directional signal · always re-enters after every close · variable-rate formula: decaying size multiplier (~1.66x→1x), widening DCA gap (~8.03%→), shrinking TP target (~1.52%→0.05% floor) as levels stack · UNCAPPED depth, compounding base size · fills use the real bid/ask spread, no assumed slippage · PAPER ONLY, no real orders · verified worst-case ~9 levels / $2,535 bare reserve per $100 base (Binance Global 5yr + Bitfinex 2yr) · deployed at 35x reserve (2 levels of margin, confirmed robust to start-date sensitivity) · ${HT_SEED_USD} starting seed</p>
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
            value={inPosition ? `Level ${level}` : "Entering…"}
            sub={inPosition ? `${totalSolQty.toFixed(4)} SOL, $${totalCost.toFixed(2)} deployed` : "—"}
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
              <td className="py-1.5 text-right text-red-400">{nextDcaPrice != null ? `$${nextDcaPrice.toFixed(4)}` : "—"}</td>
            </tr>
            <tr className="border-b border-gray-800/50">
              <td className="py-1.5 text-gray-400">TP target (price)</td>
              <td className="py-1.5 text-right text-green-400">
                {tpTarget != null && totalSolQty > 0 ? `$${(tpTarget / totalSolQty).toFixed(4)}` : "—"}
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
  const [solDcaState,   setSolDcaState]   = useState<any>(null);
  const [solDcaTrades,  setSolDcaTrades]  = useState<any[]>([]);
  const [solDcaRuns,    setSolDcaRuns]    = useState<any[]>([]);
  const [solDcaToggling, setSolDcaToggling] = useState(false);
  const [solDcaClearing, setSolDcaClearing] = useState(false);
  const [htState,   setHtState]   = useState<any>(null);
  const [htTrades,  setHtTrades]  = useState<any[]>([]);
  const [htRuns,    setHtRuns]    = useState<any[]>([]);
  const [htToggling, setHtToggling] = useState(false);
  const [htClearing, setHtClearing] = useState(false);

  async function load() {
    const [
      { data: surferSt },
      { data: surferTr },
      { data: surferRs },
      { data: surferUsdtSt },
      { data: surferUsdtTr },
      { data: surferUsdtRs },
      { data: solDcaSt },
      { data: solDcaTr },
      { data: solDcaRs },
      { data: htSt },
      { data: htTr },
      { data: htRs },
    ] = await Promise.all([
      getSupabase().from("surfer_state").select("*").eq("id", 1).single(),
      getSupabase().from("surfer_trades").select("*").order("exit_time", { ascending: false }).limit(5000),
      getSupabase().from("surfer_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
      getSupabase().from("surfer_usdt_state").select("*").eq("id", 1).single(),
      getSupabase().from("surfer_usdt_trades").select("*").order("exit_time", { ascending: false }).limit(5000),
      getSupabase().from("surfer_usdt_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
      getSupabase().from("sol_trail_bitfinex_state").select("*").eq("id", 1).single(),
      getSupabase().from("sol_trail_bitfinex_trades").select("*").order("exit_time", { ascending: false }).limit(5000),
      getSupabase().from("sol_trail_bitfinex_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
      getSupabase().from("sol_hypertrade_paper_state").select("*").eq("id", 1).single(),
      getSupabase().from("sol_hypertrade_paper_trades").select("*").order("exit_time", { ascending: false }).limit(5000),
      getSupabase().from("sol_hypertrade_paper_runs").select("id,run_at,data").order("run_at", { ascending: false }).limit(120),
    ]);
    setSurferState(surferSt ?? null);
    setSurferTrades(surferTr ?? []);
    setSurferRuns(surferRs ?? []);
    setSurferUsdtState(surferUsdtSt ?? null);
    setSurferUsdtTrades(surferUsdtTr ?? []);
    setSurferUsdtRuns(surferUsdtRs ?? []);
    setSolDcaState(solDcaSt ?? null);
    setSolDcaTrades(solDcaTr ?? []);
    setSolDcaRuns(solDcaRs ?? []);
    setHtState(htSt ?? null);
    setHtTrades(htTr ?? []);
    setHtRuns(htRs ?? []);
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


  async function handleSolDcaToggle() {
    setSolDcaToggling(true);
    await fetch("/api/sol-dca-bitfinex/toggle", { method: "POST" });
    await load();
    setSolDcaToggling(false);
  }

  async function handleSolDcaClearHistory() {
    if (!confirm(`Delete all SOL DCA trade history and run logs, and reset balance to $${DCA_SEED_USD}?`)) return;
    setSolDcaClearing(true);
    await fetch("/api/sol-dca-bitfinex/clear-history", { method: "POST" });
    await load();
    setSolDcaClearing(false);
  }

  async function handleHtToggle() {
    setHtToggling(true);
    await fetch("/api/sol-hypertrade-paper/toggle", { method: "POST" });
    await load();
    setHtToggling(false);
  }

  async function handleHtClearHistory() {
    if (!confirm("Delete all hypertrade paper trade history and run logs, and reset state?")) return;
    setHtClearing(true);
    await fetch("/api/sol-hypertrade-paper/clear-history", { method: "POST" });
    await load();
    setHtClearing(false);
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
      { name: "SOL DCA-Martingale Live (Worker 1)", badge: "LIVE", state: solDcaState, runsTable: "sol_trail_bitfinex_runs", pnlField: "realized_pnl_usd", initial: DCA_SEED_USD, unit: "$", venue: "bitfinex" as const, symbol: "tSOLUSD" },
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
    const ch19 = sb.channel("sol-dca-bitfinex")
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_trail_bitfinex_state" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_trail_bitfinex_trades" }, debouncedLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "sol_trail_bitfinex_runs" }, debouncedLoad)
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      sb.removeChannel(ch1); sb.removeChannel(ch2); sb.removeChannel(ch19);
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

        {/* ── SOL DCA-Martingale: Worker 1 (repurposed from BTC ML predictor), third live real-money bot ── */}
        <div className="grid grid-cols-1 gap-6 items-start">
          <SolDcaBitfinexPanel
            trades={solDcaTrades}
            state={solDcaState}
            runs={solDcaRuns}
            loading={loading}
            enabled={solDcaState?.enabled ?? false}
            onToggle={handleSolDcaToggle}
            toggling={solDcaToggling}
            onClearHistory={handleSolDcaClearHistory}
            clearingHistory={solDcaClearing}
          />
        </div>

        {/* ── SOL Hypertrade Paper: Worker 2 (replaced Jump Trail), paper-only continuous-grid DCA ── */}
        <div className="grid grid-cols-1 gap-6 items-start">
          <SolHypertradePaperPanel
            trades={htTrades}
            state={htState}
            runs={htRuns}
            loading={loading}
            enabled={htState?.enabled ?? false}
            onToggle={handleHtToggle}
            toggling={htToggling}
            onClearHistory={handleHtClearHistory}
            clearingHistory={htClearing}
          />
        </div>

      </div>
    </main>
  );
}
