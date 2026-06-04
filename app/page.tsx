"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import PnLChart from "@/components/PnLChart";
import TradeHistory from "@/components/TradeHistory";
import OpenPositions from "@/components/OpenPositions";

const PAPER_INITIAL = 2000;
const LIVE_INITIAL  = 200;

function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="bg-gray-800/60 rounded-lg p-3">
      <p className="text-gray-500 text-xs uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${color}`}>{value}</p>
      <p className="text-gray-600 text-xs mt-0.5">{sub}</p>
    </div>
  );
}

function LagBotPanel({
  mode, trades, openPositions, loading,
  usdtBalance, enabled, onToggle, toggling, onReset, resetting,
}: {
  mode:           "paper" | "live";
  trades:         any[];
  openPositions:  any[];
  loading:        boolean;
  usdtBalance?:   number;
  enabled?:       boolean;
  onToggle?:      () => void;
  toggling?:      boolean;
  onReset?:       () => void;
  resetting?:     boolean;
}) {
  const initial    = mode === "paper" ? PAPER_INITIAL : LIVE_INITIAL;
  const totalPnL   = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const decided    = trades.filter(t => t.result !== "EXPIRE" && t.result !== "MISSED");
  const wins       = decided.filter(t => t.pnl > 0);
  const losses     = decided.filter(t => t.pnl < 0);
  const winRate    = decided.length > 0 ? (wins.length / decided.length * 100).toFixed(1) : "—";
  const grossWin   = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf         = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";
  let peak = initial, maxDD = 0, runBal = initial;
  [...trades].reverse().forEach(t => {
    runBal += t.pnl ?? 0;
    if (runBal > peak) peak = runBal;
    const dd = (runBal - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  });

  const isLive     = mode === "live";
  const balance    = initial + totalPnL;
  const balanceSub = isLive
    ? `${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)} PnL · $${Number(usdtBalance ?? 0).toFixed(2)} avail`
    : `${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)} paper PnL`;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">Lag Bot</h2>
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
              isLive ? "bg-green-500/20 text-green-400" : "bg-blue-500/20 text-blue-400"
            }`}>{isLive ? "LIVE" : "PAPER"}</span>
          </div>
          <p className="text-gray-500 text-xs mt-0.5">
            {isLive ? "ATOM/USDT · $200" : "BNB + ATOM · $2,000"} · 1m · Z=2.0 · TP 0.8% · SL 0.3%
          </p>
        </div>

        {isLive ? (
          <div className="flex items-center gap-3">
            <button
              onClick={onReset}
              disabled={resetting || enabled}
              title={enabled ? "Turn bot OFF before resetting" : "Cancel all orders & clear position"}
              className={`text-xs px-2 py-1 rounded border border-red-500/50 text-red-400 transition-colors ${
                resetting ? "opacity-50 cursor-not-allowed" :
                enabled   ? "opacity-30 cursor-not-allowed" :
                "hover:bg-red-500/20 cursor-pointer"
              }`}
            >
              {resetting ? "Resetting…" : "Reset"}
            </button>
            <button
              onClick={onToggle}
              disabled={toggling}
              className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors ${
                enabled ? "bg-green-500" : "bg-gray-700"
              } ${toggling ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
            >
              <span className={`inline-block h-6 w-6 transform rounded-full bg-white shadow transition-transform ${
                enabled ? "translate-x-7" : "translate-x-1"
              }`} />
            </button>
            <span className={`text-xs font-bold w-8 ${enabled ? "text-green-400" : "text-gray-500"}`}>
              {enabled ? "ON" : "OFF"}
            </span>
          </div>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-green-400 text-xs font-medium">Running</span>
          </span>
        )}
      </div>

      {/* Stats */}
      {loading ? (
        <div className="grid grid-cols-2 gap-2 animate-pulse">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="Balance"
            value={`$${balance.toFixed(2)}`}
            sub={balanceSub}
            color={balance >= initial ? "text-green-400" : "text-red-400"}
          />
          <Stat label="Win Rate"      value={`${winRate}%`}        sub={`${wins.length}W / ${losses.length}L of ${decided.length}`} color="text-blue-400" />
          <Stat label="Profit Factor" value={pf}                   sub={openPositions.length > 0 ? `${openPositions.length} open` : "No open positions"} color="text-purple-400" />
          <Stat label="Max Drawdown"  value={`${maxDD.toFixed(1)}%`} sub={`${trades.length} total trades`} color={maxDD < -10 ? "text-red-400" : "text-yellow-400"} />
        </div>
      )}

      {/* PnL Chart */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Cumulative PnL</p>
        <PnLChart trades={trades} initial={initial} />
      </div>

      {/* Open Positions */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">
          Open Positions
          {openPositions.length > 0 && (
            <span className="ml-1 bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full text-xs">{openPositions.length}</span>
          )}
        </p>
        <OpenPositions positions={openPositions} loading={loading} />
      </div>

      {/* Trade History */}
      <div className="flex-1">
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Recent Trades</p>
        <TradeHistory trades={trades.slice(0, 10)} loading={loading} />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [trades, setTrades]             = useState<any[]>([]);
  const [open, setOpen]                 = useState<any[]>([]);
  const [liveSettings, setLiveSettings] = useState<any>(null);
  const [liveOpen, setLiveOpen]         = useState<any[]>([]);
  const [liveTrades, setLiveTrades]     = useState<any[]>([]);
  const [loading, setLoading]           = useState(true);
  const [toggling, setToggling]         = useState(false);
  const [resetting, setResetting]       = useState(false);

  async function load() {
    const [
      { data: closed },
      { data: openPos },
      { data: liveSt },
      { data: liveOp },
      { data: liveCl },
    ] = await Promise.all([
      getSupabase().from("positions").select("*").eq("status", "closed").order("exit_time", { ascending: false }),
      getSupabase().from("positions").select("*").in("status", ["open", "chasing"]),
      getSupabase().from("live_settings").select("*").single(),
      getSupabase().from("live_positions").select("*").in("status", ["pending", "open", "chasing"]),
      getSupabase().from("live_positions").select("*").eq("status", "closed").order("exit_time", { ascending: false }).limit(20),
    ]);
    setTrades(closed ?? []);
    setOpen(openPos ?? []);
    setLiveSettings(liveSt ?? null);
    // normalize live open positions to match paper format
    setLiveOpen((liveOp ?? []).map((p: any) => ({ ...p, pair: "ATOM" })));
    setLiveTrades(liveCl ?? []);
    setLoading(false);
  }

  async function handleToggle() {
    setToggling(true);
    await fetch("/api/live/toggle", { method: "POST" });
    await load();
    setToggling(false);
  }

  async function handleReset() {
    if (!confirm("Cancel all open ATOM orders and clear position?")) return;
    setResetting(true);
    await fetch("/api/live/reset", { method: "POST" });
    await load();
    setResetting(false);
  }

  useEffect(() => {
    load();
    const sb = getSupabase();
    const ch1 = sb.channel("positions")
      .on("postgres_changes", { event: "*", schema: "public", table: "positions" }, load)
      .subscribe();
    const ch3 = sb.channel("live")
      .on("postgres_changes", { event: "*", schema: "public", table: "live_positions" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "live_settings" }, load)
      .subscribe();
    return () => { sb.removeChannel(ch1); sb.removeChannel(ch3); };
  }, []);

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        <h1 className="text-2xl font-bold text-white">TradeBot Dashboard</h1>

        {/* Lag bots side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <LagBotPanel
            mode="paper"
            trades={trades}
            openPositions={open}
            loading={loading}
          />
          <LagBotPanel
            mode="live"
            trades={liveTrades}
            openPositions={liveOpen}
            loading={loading}
            usdtBalance={liveSettings?.usdt_balance}
            enabled={liveSettings?.enabled}
            onToggle={handleToggle}
            toggling={toggling}
            onReset={handleReset}
            resetting={resetting}
          />
        </div>


</div>
    </main>
  );
}
