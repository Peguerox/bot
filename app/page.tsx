"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import PnLChart from "@/components/PnLChart";
import StatsCards from "@/components/StatsCards";
import OpenPositions from "@/components/OpenPositions";
import TradeHistory from "@/components/TradeHistory";

export default function Dashboard() {
  const [trades, setTrades]   = useState<any[]>([]);
  const [open, setOpen]       = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const [{ data: closed }, { data: openPos }] = await Promise.all([
      getSupabase().from("positions").select("*").eq("status", "closed").order("exit_time", { ascending: false }),
      getSupabase().from("positions").select("*").eq("status", "open"),
    ]);
    setTrades(closed ?? []);
    setOpen(openPos ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    const channel = getSupabase()
      .channel("positions")
      .on("postgres_changes", { event: "*", schema: "public", table: "positions" }, load)
      .subscribe();
    return () => { getSupabase().removeChannel(channel); };
  }, []);

  return (
    <main className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">TradeBot</h1>
            <p className="text-gray-400 text-sm mt-1">
              BNB + ATOM · 1m · Z=2.0 · TP 0.6% · SL 0.4% · Paper Trading
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-green-400 text-sm font-medium">Live</span>
          </div>
        </div>

        <StatsCards trades={trades} open={open} loading={loading} />

        <div className="bg-gray-900 rounded-xl p-5">
          <h2 className="text-gray-300 font-semibold mb-4">Cumulative PnL</h2>
          <PnLChart trades={trades} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-gray-900 rounded-xl p-5">
            <h2 className="text-gray-300 font-semibold mb-4">
              Open Positions
              {open.length > 0 && (
                <span className="ml-2 bg-blue-500/20 text-blue-400 text-xs px-2 py-0.5 rounded-full">
                  {open.length}
                </span>
              )}
            </h2>
            <OpenPositions positions={open} loading={loading} />
          </div>
          <div className="bg-gray-900 rounded-xl p-5">
            <h2 className="text-gray-300 font-semibold mb-4">Recent Trades</h2>
            <TradeHistory trades={trades.slice(0, 20)} loading={loading} />
          </div>
        </div>

      </div>
    </main>
  );
}
