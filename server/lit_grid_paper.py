"""
Paper-only LIT/USDC grid bot (2026-10-18, direct request).

NOT a real-money bot: no exchange credentials anywhere in this file, no order placement -- it
only reads Lighter's public LIT/USDC 1-minute candle feed (market_id 2049, no auth needed) and
simulates fills against the configured grid, logging paired round-trips to
lighter_lit_grid_trades for the dashboard panel to show.

Runs as a second, fully isolated asyncio task inside Worker 4's existing Render process
(see the bottom of lighter_stoch_dca_btc_worker4.py) rather than its own service, to avoid the
cost of a dedicated Render service for something still being tested. Every tick is wrapped so
nothing here can ever raise out to the caller and cancel Worker 4's real trading task.

Grid math is a direct, line-for-line port of the already-validated research scripts
(research/grid-bot-2026-10-17/grid_paired_cycle_sim.mjs and grid_compounding_sim.mjs):
  - geometric level index: round(log(price) / log(1 + spacing_pct/100))
  - a candle's intrabar sub-path is approximated as open -> (low, high) or (high, low) depending
    on whether the candle closed up or down -> close, and every integer level crossed along that
    path is one fill event (this walks level-by-level, so -- unlike the historical backtest's
    batch "did we gap past the window" analysis -- it does not model real order-arming delay;
    it's a paper screening model, same simplification the uploaded Oct 17 audit doc used for its
    own grid simulation).
  - LIMIT fills are capped at 25% of that candle's real traded volume (same assumption validated
    this session); MARKET fills pay a fixed ~0.103% assumed round-trip spread cost instead.
  - completed pairs are matched LIFO against the opposite side's open stack (buy pairs with the
    most recent unpaired sell, and vice versa) -- the correct accounting method identified this
    session, not the naive "crossings / 2" approximation from earlier in the research.
  - order_size_lit is capital_usd / (sum of price at each configured down-level) -- the same
    "full worst-case reserve against levels_down" sizing used throughout this session's manual
    calculations, so the panel's capital number means what it meant in chat.
"""
import asyncio
import math
import os
import time
import json as jsonlib
from datetime import datetime, timedelta, timezone

import aiohttp

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

MARKET_ID = 2049  # LIT/USDC spot
TABLE_STATE = "lighter_lit_grid_state"
TABLE_TRADES = "lighter_lit_grid_trades"
TABLE_RUNS = "lighter_lit_grid_runs"

PARTICIPATION = 0.25          # validated assumption: at most 25% of a candle's real volume fills
MARKET_ROUNDTRIP_COST_PCT = 0.103  # validated live-spread snapshot, applied once per completed pair
TICK_EVERY = 60.0             # matches the 1-minute candle resolution everything was validated on
LOCK_REFRESH_EVERY = 5.0
LOCK_STALE_AFTER = 20.0


def level_of(price: float, step: float) -> int:
    return round(math.log(price) / step)


def candle_path(candle: dict) -> list:
    o, h, l, c = candle["o"], candle["h"], candle["l"], candle["c"]
    return [o, l, h, c] if c >= o else [o, h, l, c]


def compute_order_size_lit(capital_usd: float, current_price: float, spacing_pct: float, levels_down: int) -> float:
    """capital_usd / sum(price at each down-level) -- full reserve against the configured depth."""
    r = 1.0 / (1.0 + spacing_pct / 100.0)
    price_sum = 0.0
    p = current_price
    for _ in range(max(1, levels_down)):
        p *= r
        price_sum += p
    if price_sum <= 0:
        return 0.0
    return capital_usd / price_sum


class LitGridPaper:
    def __init__(self, http: aiohttp.ClientSession):
        self.http = http
        self._lock_id = f"{os.environ.get('RENDER_INSTANCE_ID', 'local')}:lit-grid"
        self._lock_held = False
        self._lock_checked_at = 0.0
        self._lock_blocked_logged = False
        self._last_candle_t = None
        self._last_level = None

    # ── Supabase (same pattern as stoch_bot_core.py's sb/get_state/update_state/log_run) ──────
    async def sb(self, method, path, body=None):
        url = f"{SUPABASE_URL}/rest/v1/{path}"
        headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
        }
        if method in ("POST", "PATCH"):
            headers["Prefer"] = "return=representation"
        async with self.http.request(method, url, json=body, headers=headers,
                                      timeout=aiohttp.ClientTimeout(total=8.0)) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise RuntimeError(f"supabase {resp.status} on {method} {path}: {text[:200]}")
            return jsonlib.loads(text) if text else None

    async def get_state(self):
        rows = await self.sb("GET", f"{TABLE_STATE}?id=eq.1")
        return rows[0]

    async def update_state(self, patch):
        await self.sb("PATCH", f"{TABLE_STATE}?id=eq.1", patch)

    async def log_run(self, action, detail):
        print(f"[lit-grid:{action}] {detail}", flush=True)
        try:
            await self.sb("POST", TABLE_RUNS, {"action": action, "detail": detail})
        except Exception as e:
            print(f"  (lit-grid log_run failed: {e})", flush=True)

    async def log_trade(self, side, opened_at, closed_at, entry_price, exit_price, qty, pnl_usd, order_type):
        row = {
            "side": side, "opened_at": opened_at, "closed_at": closed_at,
            "entry_price": entry_price, "exit_price": exit_price,
            "qty_lit": qty, "pnl_usd": pnl_usd, "order_type": order_type,
        }
        try:
            await self.sb("POST", TABLE_TRADES, row)
        except Exception as e:
            await self.log_run("log_trade_failed", {"error": str(e)[:300]})

    # ── Single-instance lock (same PostgREST-conditional-PATCH idea as stoch_bot_core.py) ──────
    async def acquire_lock(self):
        now = time.time()
        if now - self._lock_checked_at < LOCK_REFRESH_EVERY:
            return self._lock_held
        self._lock_checked_at = now
        stale_before = datetime.now(timezone.utc) - timedelta(seconds=LOCK_STALE_AFTER)
        stale_iso = stale_before.isoformat().replace("+00:00", "Z")
        guard = (f"or=(lock_owner.is.null,lock_heartbeat.is.null,"
                 f"lock_owner.eq.{self._lock_id},lock_heartbeat.lt.{stale_iso})")
        try:
            rows = await self.sb(
                "PATCH", f"{TABLE_STATE}?id=eq.1&{guard}",
                {"lock_owner": self._lock_id, "lock_heartbeat": datetime.now(timezone.utc).isoformat()},
            )
        except Exception as e:
            was_held = self._lock_held
            self._lock_held = False
            if was_held:
                await self.log_run("instance_lock_refresh_failed", {"error": str(e)[:200]})
            return False
        if rows:
            if not self._lock_held:
                await self.log_run("instance_lock_acquired", {"lock_id": self._lock_id})
            self._lock_held = True
            self._lock_blocked_logged = False
            return True
        self._lock_held = False
        if not self._lock_blocked_logged:
            self._lock_blocked_logged = True
            await self.log_run("instance_lock_busy", {"lock_id": self._lock_id})
        return False

    async def release_lock(self):
        if not self._lock_held:
            return
        self._lock_held = False
        try:
            await self.sb("PATCH", f"{TABLE_STATE}?id=eq.1&lock_owner=eq.{self._lock_id}",
                           {"lock_owner": None, "lock_heartbeat": None})
        except Exception:
            pass

    # ── Candles (public endpoint, no auth) ──────────────────────────────────────────────────────
    async def fetch_latest_candles(self, count=5):
        end_ms = int(time.time() * 1000)
        url = (f"https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id={MARKET_ID}"
               f"&resolution=1m&start_timestamp=0&end_timestamp={end_ms}&count_back={count}")
        async with self.http.get(url, timeout=aiohttp.ClientTimeout(total=8.0)) as resp:
            text = await resp.text()
            content_type = resp.headers.get("Content-Type", "")
            if resp.status >= 400 or "json" not in content_type:
                raise RuntimeError(f"fetch_latest_candles {resp.status} ct={content_type}: {text[:150]}")
            data = jsonlib.loads(text)
        return sorted(data.get("c", []), key=lambda c: c["t"])

    # ── One grid tick: process every new closed candle since the last tick ─────────────────────
    async def process_candle(self, candle, state):
        spacing_pct = float(state["spacing_pct"])
        step = math.log(1 + spacing_pct / 100.0)
        order_type = state["order_type"]
        capital = float(state["current_capital_usd"] if state["compounding_enabled"] else state["capital_usd"])
        order_size = compute_order_size_lit(capital, candle["c"], spacing_pct, int(state["levels_down"]))

        positions = state.get("open_positions_json") or {"buys": [], "sells": []}
        open_buys = positions.get("buys", [])
        open_sells = positions.get("sells", [])

        path = candle_path(candle)
        if self._last_level is None:
            self._last_level = level_of(path[0], step)
        lvl = self._last_level
        events = []
        for i in range(1, len(path)):
            new_lvl = level_of(path[i], step)
            while new_lvl > lvl:
                lvl += 1
                events.append(("sell", math.exp(lvl * step)))
            while new_lvl < lvl:
                lvl -= 1
                events.append(("buy", math.exp(lvl * step)))
        self._last_level = lvl

        if order_type == "limit":
            cap = int((PARTICIPATION * (candle.get("v") or 0)) / order_size) if order_size > 0 else 0
            take = events[:max(0, cap)]
        else:
            take = events

        realized_pnl = 0.0
        closed_at = datetime.fromtimestamp(candle["t"] / 1000, tz=timezone.utc).isoformat()
        for side, price in take:
            if side == "sell":
                if open_buys:
                    entry = open_buys.pop()
                    pnl = (price - entry["price"]) * entry["qty"]
                    if order_type == "market":
                        pnl -= (MARKET_ROUNDTRIP_COST_PCT / 100.0) * ((price + entry["price"]) / 2) * entry["qty"]
                    realized_pnl += pnl
                    await self.log_trade("buy_then_sell", entry["opened_at"], closed_at,
                                          entry["price"], price, entry["qty"], pnl, order_type)
                else:
                    open_sells.append({"price": price, "qty": order_size, "opened_at": closed_at})
            else:
                if open_sells:
                    entry = open_sells.pop()
                    pnl = (entry["price"] - price) * entry["qty"]
                    if order_type == "market":
                        pnl -= (MARKET_ROUNDTRIP_COST_PCT / 100.0) * ((price + entry["price"]) / 2) * entry["qty"]
                    realized_pnl += pnl
                    await self.log_trade("sell_then_buy", entry["opened_at"], closed_at,
                                          entry["price"], price, entry["qty"], pnl, order_type)
                else:
                    open_buys.append({"price": price, "qty": order_size, "opened_at": closed_at})

        new_capital = float(state["current_capital_usd"]) + realized_pnl if state["compounding_enabled"] else float(state["current_capital_usd"])
        await self.update_state({
            "live_price": candle["c"],
            "live_level": lvl,
            "order_size_lit": order_size,
            "current_capital_usd": new_capital,
            "open_positions_json": {"buys": open_buys, "sells": open_sells},
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })

    async def tick(self):
        state = await self.get_state()
        if not state.get("enabled"):
            return
        candles = await self.fetch_latest_candles(count=5)
        for c in candles:
            if self._last_candle_t is not None and c["t"] <= self._last_candle_t:
                continue
            await self.process_candle(c, state)
            self._last_candle_t = c["t"]
            state = await self.get_state()  # re-read so a multi-candle catch-up compounds correctly


async def run_lit_grid_paper():
    """Entrypoint for the embedded task. Never raises -- every tick is caught and logged so a
    bug here can never cancel the sibling real-money task it's gathered with."""
    async with aiohttp.ClientSession() as http:
        bot = LitGridPaper(http)
        await bot.log_run("started", {})
        try:
            while True:
                try:
                    if await bot.acquire_lock():
                        await bot.tick()
                except Exception as e:
                    try:
                        await bot.log_run("tick_error", {"error": str(e)[:300]})
                    except Exception:
                        print(f"[lit-grid] tick_error (and log_run also failed): {e}", flush=True)
                await asyncio.sleep(TICK_EVERY)
        finally:
            await bot.release_lock()
