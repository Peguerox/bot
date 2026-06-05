"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import PnLChart from "@/components/PnLChart";
import TradeHistory from "@/components/TradeHistory";
import OpenPositions from "@/components/OpenPositions";

const PAPER_INITIAL  = 2000;
const LIVE_INITIAL   = 200;
const FAKING_INITIAL = 200;

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
  if (action === "OPEN")         return "text-green-400";
  if (action === "TP_FILLED")    return "text-green-400";
  if (action === "SL_FILLED" || action === "SL_LEGACY") return "text-red-400";
  if (action.startsWith("ERROR") || action === "ENTRY_ROLLBACK") return "text-red-400";
  if (action === "WARN_ATOM_NO_POS") return "text-orange-400";
  if (action === "CHASE_UP")     return "text-yellow-400";
  if (action === "CHASE_HOLD")   return "text-gray-500";
  if (action === "HOLD" || action === "HOLD_LEGACY") return "text-gray-500";
  if (action === "SKIP_NO_FUNDS") return "text-orange-400";
  if (action === "WATCH")        return "text-gray-600";
  return "text-gray-400";
}

function formatAction(a: any): string {
  if (a.action === "WATCH")           return `WATCH  z=${parseFloat(a.z).toFixed(2)}  $${a.price}`;
  if (a.action === "OPEN")            return `OPEN  entry=$${a.entry}  tp=$${a.tp}  sl=$${a.sl}  z=${parseFloat(a.z).toFixed(2)}`;
  if (a.action === "HOLD")            return `HOLD  [${a.hold}/${6}]  $${a.currentPrice}`;
  if (a.action === "CHASE_UP")        return `CHASE UP  $${a.currentPrice} → tp=$${a.newTp}`;
  if (a.action === "CHASE_HOLD")      return `CHASE HOLD  $${a.currentPrice}`;
  if (a.action === "TP_FILLED")       return `TP FILLED  exit=$${a.exit}  pnl=$${parseFloat(a.pnl).toFixed(2)}`;
  if (a.action === "SL_FILLED")       return `SL FILLED  exit=$${a.exit}  pnl=$${parseFloat(a.pnl).toFixed(2)}`;
  if (a.action === "WARN_ATOM_NO_POS") return `BLOCKED — ${parseFloat(a.atomFree).toFixed(2)} ATOM held, no DB position`;
  if (a.action === "SKIP_NO_FUNDS")   return `NO FUNDS  $${parseFloat(a.balance).toFixed(2)} USDT`;
  if (a.action === "ENTRY_ROLLBACK")  return `ROLLBACK (${a.stage}): ${a.error}`;
  if (a.action === "ERROR")           return `ERROR (${a.stage}): ${a.error}`;
  if (a.action === "CANCELLED_EXTERNAL") return `CANCELLED EXTERNALLY`;
  return a.action;
}

function LagBotPanel({
  mode, trades, openPositions, loading,
  usdtBalance, atomBalance, enabled, onToggle, toggling, onReset, resetting, onClearHistory, clearingHistory,
  runs,
}: {
  mode:              "paper" | "live" | "faking";
  trades:            any[];
  openPositions:     any[];
  loading:           boolean;
  usdtBalance?:      number;
  atomBalance?:      number;
  enabled?:          boolean;
  onToggle?:         () => void;
  toggling?:         boolean;
  onReset?:          () => void;
  resetting?:        boolean;
  onClearHistory?:   () => void;
  clearingHistory?:  boolean;
  runs?:             any[];
}) {
  const initial    = mode === "paper" ? PAPER_INITIAL : mode === "faking" ? FAKING_INITIAL : LIVE_INITIAL;
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

  const isLive     = mode === "live" || mode === "faking";
  const balance    = initial + totalPnL;
  const balanceSub = isLive
    ? `${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)} PnL · $${Number(usdtBalance ?? 0).toFixed(2)} USDT · ${Number(atomBalance ?? 0).toFixed(2)} ATOM`
    : `${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)} paper PnL`;

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-5 flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-white font-bold text-lg">Lag Bot</h2>
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full shrink-0 ${
              mode === "live"   ? "bg-green-500/20 text-green-400"  :
              mode === "faking" ? "bg-orange-500/20 text-orange-400" :
                                  "bg-blue-500/20 text-blue-400"
            }`}>{mode === "live" ? "LIVE" : mode === "faking" ? "FAKING" : "PAPER"}</span>
          </div>
          <p className="text-gray-500 text-xs mt-0.5">
            {mode === "live" ? "ATOM/USDT · $200" : mode === "faking" ? "ATOM/USDT · $200" : "BNB + ATOM · $2,000"} · 1m · Z=2.0 · TP 0.8% · SL 0.3%
          </p>
        </div>

        {isLive ? (
          <div className="flex items-center gap-1.5 shrink-0">
            {onClearHistory && (
              <button
                onClick={onClearHistory}
                disabled={clearingHistory || enabled}
                title={enabled ? "Pause bot before clearing" : "Delete all closed trade history"}
                className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {clearingHistory ? "Clearing…" : "Clear"}
              </button>
            )}
            <button
              onClick={onReset}
              disabled={resetting || enabled}
              title={enabled ? "Pause bot before resetting" : "Cancel all orders & clear position"}
              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-gray-800 text-red-400/70 hover:bg-red-950/60 hover:text-red-400 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {resetting ? "Resetting…" : "Reset"}
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

      {/* Live Activity Log — faking bot only */}
      {mode === "faking" && runs && (
        <div>
          <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Live Activity</p>
          <div className="space-y-0.5 font-mono text-xs">
            {runs.length === 0 && (
              <p className="text-gray-600">No runs yet.</p>
            )}
            {runs.map((r: any) => {
              const actions = r.actions ?? [];
              const time = r.created_at
                ? new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
                : "";
              return (
                <div key={r.id} className="flex gap-2 items-start">
                  <span className="text-gray-600 shrink-0">{time}</span>
                  <div className="flex flex-col gap-0">
                    {actions.map((a: any, i: number) => (
                      <span key={i} className={actionColor(a.action)}>
                        {formatAction(a)}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [trades, setTrades]                   = useState<any[]>([]);
  const [open, setOpen]                       = useState<any[]>([]);
  const [liveSettings, setLiveSettings]       = useState<any>(null);
  const [liveOpen, setLiveOpen]               = useState<any[]>([]);
  const [liveTrades, setLiveTrades]           = useState<any[]>([]);
  const [fakingSettings, setFakingSettings]   = useState<any>(null);
  const [fakingOpen, setFakingOpen]           = useState<any[]>([]);
  const [fakingTrades, setFakingTrades]       = useState<any[]>([]);
  const [fakingRuns, setFakingRuns]           = useState<any[]>([]);
  const [atomBalance, setAtomBalance]         = useState<number>(0);
  const [loading, setLoading]                 = useState(true);
  const [toggling, setToggling]               = useState(false);
  const [resetting, setResetting]             = useState(false);
  const [fakingToggling, setFakingToggling]         = useState(false);
  const [fakingResetting, setFakingResetting]       = useState(false);
  const [fakingClearing, setFakingClearing]         = useState(false);

  async function load() {
    const [
      { data: closed },
      { data: openPos },
      { data: liveSt },
      { data: liveOp },
      { data: liveCl },
      { data: fakingSt },
      { data: fakingOp },
      { data: fakingCl },
      { data: fakingRs },
    ] = await Promise.all([
      getSupabase().from("positions").select("*").eq("status", "closed").order("exit_time", { ascending: false }),
      getSupabase().from("positions").select("*").in("status", ["open", "chasing"]),
      getSupabase().from("live_settings").select("*").single(),
      getSupabase().from("live_positions").select("*").in("status", ["pending", "open", "chasing"]),
      getSupabase().from("live_positions").select("*").eq("status", "closed").order("exit_time", { ascending: false }).limit(20),
      getSupabase().from("faking_settings").select("*").single(),
      getSupabase().from("faking_positions").select("*").in("status", ["open", "chasing"]),
      getSupabase().from("faking_positions").select("*").eq("status", "closed").order("exit_time", { ascending: false }).limit(20),
      getSupabase().from("faking_runs").select("id,created_at,actions").order("created_at", { ascending: false }).limit(15),
    ]);
    setTrades(closed ?? []);
    setOpen(openPos ?? []);
    setLiveSettings(liveSt ?? null);
    setLiveOpen((liveOp ?? []).map((p: any) => ({ ...p, pair: "ATOM" })));
    setLiveTrades(liveCl ?? []);
    setFakingSettings(fakingSt ?? null);
    setFakingOpen((fakingOp ?? []).map((p: any) => ({ ...p, pair: "ATOM" })));
    setFakingTrades(fakingCl ?? []);
    setFakingRuns(fakingRs ?? []);
    setLoading(false);
    // Fetch live balances from Binance
    fetch("/api/live/balances").then(r => r.json()).then(b => setAtomBalance(b.atom ?? 0)).catch(() => {});
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

  async function handleFakingToggle() {
    setFakingToggling(true);
    await fetch("/api/faking/toggle", { method: "POST" });
    await load();
    setFakingToggling(false);
  }

  async function handleFakingReset() {
    if (!confirm("Cancel all open ATOM orders and clear faking position?")) return;
    setFakingResetting(true);
    await fetch("/api/faking/reset", { method: "POST" });
    await load();
    setFakingResetting(false);
  }

  async function handleFakingClearHistory() {
    if (!confirm("Delete all closed faking trade history? This cannot be undone.")) return;
    setFakingClearing(true);
    await fetch("/api/faking/clear-history", { method: "POST" });
    await load();
    setFakingClearing(false);
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
    const ch4 = sb.channel("faking")
      .on("postgres_changes", { event: "*", schema: "public", table: "faking_positions" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "faking_settings" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "faking_runs" }, load)
      .subscribe();
    return () => { sb.removeChannel(ch1); sb.removeChannel(ch3); sb.removeChannel(ch4); };
  }, []);

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        <h1 className="text-2xl font-bold text-white">TradeBot Dashboard</h1>

        {/* All three bots */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
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
            atomBalance={atomBalance}
            enabled={liveSettings?.enabled}
            onToggle={handleToggle}
            toggling={toggling}
            onReset={handleReset}
            resetting={resetting}
          />
          <LagBotPanel
            mode="faking"
            trades={fakingTrades}
            openPositions={fakingOpen}
            loading={loading}
            usdtBalance={fakingSettings?.usdt_balance}
            atomBalance={atomBalance}
            enabled={fakingSettings?.enabled}
            onToggle={handleFakingToggle}
            toggling={fakingToggling}
            onReset={handleFakingReset}
            resetting={fakingResetting}
            onClearHistory={handleFakingClearHistory}
            clearingHistory={fakingClearing}
            runs={fakingRuns}
          />
        </div>


</div>
    </main>
  );
}
