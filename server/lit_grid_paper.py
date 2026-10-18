"""
Paper-only LIT/USDC grid bot (2026-10-18, direct request).

NOT a real-money bot: no exchange credentials anywhere in this file, no order placement -- it
only reads Lighter's public LIT/USDC live trade price (market_id 2049, no auth needed) and
simulates fills against the configured grid, logging paired round-trips to
lighter_lit_grid_trades for the dashboard panel to show.

Runs as a second, fully isolated asyncio task inside Worker 4's existing Render process
(see the bottom of lighter_stoch_dca_btc_worker4.py) rather than its own service, to avoid the
cost of a dedicated Render service for something still being tested. Every tick is wrapped so
nothing here can ever raise out to the caller and cancel Worker 4's real trading task.

Live price polling, not 1-minute candles (2026-10-18, direct correction -- "use the price so we
can buy and sell fast"): the original version polled closed 1-minute candles once a minute, so a
real crossing could sit unacted-on for up to ~2 minutes (one minute for the candle to close, up
to another minute for the next tick). Polls the public recentTrades endpoint for the latest trade
price every TICK_EVERY seconds instead -- a real price feed, not an approximation -- and walks
directly from the last seen price to the new one, same level-crossing logic, just driven off real
consecutive price samples instead of an OHLC approximation of a whole closed minute.

Grid math, mostly unchanged from the research scripts (research/grid-bot-2026-10-17/
grid_paired_cycle_sim.mjs, grid_compounding_sim.mjs), with corrections found via an Opus audit
and direct confirmation against Bitsgap's own documentation on 2026-10-18:
  - geometric level index: floor(log(price) / log(1 + spacing_pct/100)) -- floor, not round (see
    level_of's docstring for why round() caused phantom profit from sub-spacing noise).
  - each buy fill at level L ties to a SPECIFIC sell order exactly one level above, at L+1, not a
    generic "whatever's most recently open" LIFO match (see process_price's docstring) --
    confirmed directly against Bitsgap's own docs; this is what lets repeated chop between two
    adjacent lines profit on every touch, the actual point of a grid bot.
  - order_size_lit is capital / (sum of price across the levels implied by drawdown_pct) -- sizes
    the order only, the bot never actually builds/tracks that many levels; it just keeps
    recreating the next line dynamically as price moves. levels_up/levels_down are a separate,
    small, active-tracking window, unrelated to the sizing depth.
  - MARKET fills pay a fixed ~0.103% assumed round-trip spread cost; LIMIT fills do not (no
    volume-based fill cap anymore -- removed along with the candle-volume concept it depended on;
    every fill is still constrained by real usdc_balance/holdings, just not additionally throttled
    by an assumed participation rate).

Real balance accounting (2026-10-18, confirmed against Bitsgap): this is a Long spot grid --
starts with capital split proportionally to levels_up/levels_down (LIT bought upfront to arm the
up side, the rest kept as USDC for the down side), and only ever sells LIT it actually holds (no
naked shorts). Every fill is constrained by the real balance. Three numbers are tracked
separately, matching Bitsgap's own panel: Investment (capital_usd, fixed), Bot profit
(bot_profit_usd, realized round-trips only), and Total PNL (current real account value --
usdc_balance + lit_balance at the live price -- minus Investment, which also captures whatever is
sitting unsold in LIT).
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

MARKET_ROUNDTRIP_COST_PCT = 0.103  # validated live-spread snapshot, applied once per completed pair
# Live price poll interval (2026-10-18, direct correction -- was 60s candle polling, meaning a
# real crossing could sit unacted-on for up to ~2 minutes). 3s keeps reaction fast without
# hammering the public endpoint (a plain recentTrades call, ~0.6s round trip observed live).
TICK_EVERY = 3.0
LOCK_REFRESH_EVERY = 5.0
# Must stay comfortably above the actual heartbeat cadence (LOCK_REFRESH_EVERY, since
# acquire_lock() only writes a fresh heartbeat that often even though tick() itself runs more
# frequently). 30s is a 6x margin -- generous enough that a genuinely alive instance never looks
# stale, short enough that a truly dead one is reclaimed quickly given how fast ticks are now.
LOCK_STALE_AFTER = 30.0


def level_of(price: float, step: float) -> int:
    # floor(), not round() (2026-10-18, Opus audit -- confirmed by reproducing it directly).
    # round() made a crossing trigger at the MIDPOINT between two grid lines (half a spacing
    # step away), while the fill price recorded a FULL step's move -- so price noise smaller
    # than the configured spacing could still flip the detected level and book a full-size
    # "profitable" fill that never happened: real price moved ~0.00002 in the reproduction, but
    # the bot recorded a full-level profitable round trip anyway. floor() makes the trigger
    # threshold a real grid line (a full spacing step away), matching the fill price distance,
    # so sub-spacing noise can no longer move the detected level at all.
    return math.floor(math.log(price) / step)


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


def levels_for_drawdown(spacing_pct: float, drawdown_pct: float) -> int:
    """How many grid levels a given % price decline spans, at this spacing -- used only to size
    the order (2026-10-18, direct correction: drawdown_pct sizes the order so the capital would
    last through that whole decline WITHOUT the bot ever actually building/tracking that many
    levels -- it just keeps recreating the next line as price moves, same dynamic window as
    always. levels_up/levels_down are a separate, small, active-tracking window, not a depth."""
    drawdown_pct = min(max(drawdown_pct, 0.01), 99.0)
    ratio = 1.0 - drawdown_pct / 100.0
    step = math.log(1 + spacing_pct / 100.0)
    return max(1, math.ceil(math.log(1 / ratio) / step))


class LitGridPaper:
    def __init__(self, http: aiohttp.ClientSession):
        self.http = http
        self._lock_id = f"{os.environ.get('RENDER_INSTANCE_ID', 'local')}:lit-grid"
        self._lock_held = False
        self._lock_checked_at = 0.0
        self._lock_blocked_logged = False
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

    # ── Live price (public endpoint, no auth) ───────────────────────────────────────────────────
    async def fetch_current_price(self):
        """Latest real trade price -- a lightweight, fast poll (not a full candle fetch), so the
        bot can react within TICK_EVERY seconds of a real price move instead of waiting for a
        1-minute candle to close."""
        url = f"https://mainnet.zklighter.elliot.ai/api/v1/recentTrades?market_id={MARKET_ID}&limit=1"
        async with self.http.get(url, timeout=aiohttp.ClientTimeout(total=8.0)) as resp:
            text = await resp.text()
            content_type = resp.headers.get("Content-Type", "")
            if resp.status >= 400 or "json" not in content_type:
                raise RuntimeError(f"fetch_current_price {resp.status} ct={content_type}: {text[:150]}")
            data = jsonlib.loads(text)
        trades = data.get("trades") or []
        if not trades:
            return None
        return float(trades[0]["price"])

    # ── One tick: walk from the last seen price to the new one ─────────────────────────────────
    async def process_price(self, price, state):
        """Real Bitsgap-style grid mechanic (2026-10-18, confirmed against Bitsgap's own
        documentation -- see arm_grid's docstring for the funding side of this).

        Each buy fill at level L ties to a SPECIFIC sell order one level above, at L+1 -- not a
        generic "whatever's most recently open" match. `holdings` is keyed by the level a LIT
        quantity was bought at: holdings[L] = qty means "bought at L, resting sell armed at
        L+1". Reaching L+1 sells exactly that qty, for exactly one spacing's profit, no matter
        what path price took to get there -- including repeated chop between the same two
        adjacent lines in a flat market, which is the actual point of a grid bot. No held LIT at
        L -> reaching L+1 just does nothing there (a Long grid only ever sells inventory it
        actually bought, no naked shorts).

        Real usdc_balance/lit_balance are the source of truth for every fill -- a buy that can't
        be afforded from real usdc_balance does not happen (deferred, like a real unfilled
        resting order), not re-derived from the full original capital every tick.

        Walks level-by-level between the last seen price and this new one (2026-10-18: now a
        real consecutive live-price pair, not an OHLC approximation of a whole closed minute) --
        every line crossed in between is its own fill event, so a fast multi-level move still
        fills every line it actually passed through, not just the endpoint."""
        spacing_pct = float(state["spacing_pct"])
        step = math.log(1 + spacing_pct / 100.0)
        order_type = state["order_type"]
        usdc_balance = float(state["usdc_balance"])
        lit_balance = float(state["lit_balance"])
        bot_profit_usd = float(state["bot_profit_usd"])
        total_value = usdc_balance + lit_balance * price
        if state["compounding_enabled"]:
            sizing_levels = levels_for_drawdown(spacing_pct, float(state.get("drawdown_pct") or 30.0))
            order_size = compute_order_size_lit(total_value, price, spacing_pct, sizing_levels)
        else:
            # Fixed at whatever arm_grid computed from the full original capital -- not
            # recomputed every tick, since compounding is off.
            order_size = float(state.get("order_size_lit") or 0.0)

        positions = state.get("open_positions_json") or {"holdings": {}}
        holdings = {int(k): v for k, v in (positions.get("holdings") or {}).items()}

        if self._last_level is None:
            self._last_level = level_of(price, step)
        lvl = self._last_level
        target_lvl = level_of(price, step)

        now_iso = datetime.now(timezone.utc).isoformat()
        blocked = False  # ran out of real USDC -- stop advancing entirely, defer the rest

        while lvl != target_lvl and not blocked:
            if target_lvl > lvl:
                lvl += 1
                fill_price = math.exp(lvl * step)
                buy_level = lvl - 1
                qty = holdings.get(buy_level, 0.0)
                if qty > 0:
                    proceeds = fill_price * qty
                    buy_price = math.exp(buy_level * step)
                    pnl = (fill_price - buy_price) * qty
                    if order_type == "market":
                        cost = (MARKET_ROUNDTRIP_COST_PCT / 100.0) * ((fill_price + buy_price) / 2) * qty
                        proceeds -= cost
                        pnl -= cost
                    lit_balance -= qty
                    usdc_balance += proceeds
                    bot_profit_usd += pnl
                    del holdings[buy_level]
                    await self.log_trade("buy_then_sell", now_iso, now_iso, buy_price, fill_price, qty, pnl, order_type)
                # No holding at buy_level -- no resting sell order armed at this level, do nothing.
            else:
                lvl -= 1
                fill_price = math.exp(lvl * step)
                cost = fill_price * order_size
                if usdc_balance >= cost:
                    usdc_balance -= cost
                    lit_balance += order_size
                    holdings[lvl] = holdings.get(lvl, 0.0) + order_size
                else:
                    blocked = True

        self._last_level = lvl
        await self.update_state({
            "live_price": price,
            "live_level": lvl,
            "order_size_lit": order_size,
            "usdc_balance": usdc_balance,
            "lit_balance": lit_balance,
            "bot_profit_usd": bot_profit_usd,
            "open_positions_json": {"holdings": {str(k): v for k, v in holdings.items() if v > 0}},
            "updated_at": now_iso,
        })

    async def arm_grid(self, state, center_price, center_lvl, note, seed_initial_position=False):
        """(Re)establish the level tracker at a fresh reference point and persist it, so a
        restart can resume from here instead of silently re-arming from scratch while stale
        open_positions_json from before the restart sits at the OLD levels (Opus audit,
        2026-10-18: this reintroduced the non-adjacent-pair bug through a different path --
        every Render redeploy resets in-memory state, but the position stack survives in the
        DB). Also re-arms whenever spacing_pct changes mid-run, since a level INDEX computed
        under the old spacing means something different under a new one (reproduced live:
        a spacing change made the walk "discover" hundreds of phantom levels in one candle).

        seed_initial_position (2026-10-18, confirmed directly against Bitsgap's own
        documentation): a real grid bot funds BOTH sides from the start -- every level above
        current price starts with a resting sell order, every level below starts with a resting
        buy order, and Bitsgap buys whatever base currency is missing at market price to arm the
        sell side. The split is proportional to the configured window, not a blind 50/50: buy
        only enough LIT to cover `levels_up` sell orders (direct example given: 3 up / 15 down
        means buy 3 orders' worth of LIT, keep the rest as cash for the 15 down levels). Each of
        those `levels_up` orders is its own separate holdings[level] entry (see process_price)
        so each one sells independently and correctly when its own specific level is reached --
        not one lump sum. Only applies on a genuine first-ever start (never on a spacing-change
        re-arm, which must not touch an already-established position)."""
        self._last_level = center_lvl
        spacing_pct = float(state["spacing_pct"])
        usdc_balance = float(state["usdc_balance"])
        lit_balance = float(state["lit_balance"])

        patch = {}
        if seed_initial_position:
            capital_usd = float(state["capital_usd"])
            down_sizing_levels = levels_for_drawdown(spacing_pct, float(state.get("drawdown_pct") or 30.0))
            # Base order size off the FULL capital against the down-side depth -- this is the
            # per-level LIT quantity used both to seed the up side and for every ongoing fill.
            base_order_size = compute_order_size_lit(capital_usd, center_price, spacing_pct, down_sizing_levels)
            levels_up = max(1, int(state["levels_up"]))
            lit_value_usd = base_order_size * levels_up * center_price
            # Safety clamp: never let the up-side allocation eat so much of the capital that
            # the down side (the much deeper, more important reserve) is starved.
            lit_value_usd = min(lit_value_usd, capital_usd * 0.9)
            actual_order_size = lit_value_usd / levels_up / center_price if levels_up > 0 else 0.0
            usdc_balance = capital_usd - lit_value_usd
            lit_balance = actual_order_size * levels_up
            # One holding per level, exactly like Bitsgap pre-arming a separate sell order at
            # each level above price -- NOT one lump entry. holdings[center_lvl + k] represents
            # "bought at this level, sells when price reaches one level above it".
            patch["open_positions_json"] = {
                "holdings": {str(center_lvl + k): actual_order_size for k in range(levels_up)}
            }
            patch["usdc_balance"] = usdc_balance
            patch["lit_balance"] = lit_balance
            patch["order_size_lit"] = base_order_size
            order_size = base_order_size
        else:
            # Spacing-change re-arm on an already-running position: keep using whatever
            # order_size is already in effect (recomputed fresh every tick in process_price
            # when compounding is on; otherwise it stays fixed from the original arm).
            order_size = float(state.get("order_size_lit") or 0.0)

        await self.log_run(note, {
            "center_price": center_price, "center_level": center_lvl, "spacing_pct": spacing_pct,
            "levels_up": state["levels_up"], "levels_down": state["levels_down"],
            "seeded_initial_lit": lit_balance if seed_initial_position else None,
        })
        patch.update({
            "live_price": center_price,
            "live_level": center_lvl,
            "order_size_lit": order_size,
            "internal_last_level": center_lvl,
            "internal_spacing_pct": spacing_pct,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        await self.update_state(patch)

    async def tick(self):
        state = await self.get_state()
        if not state.get("enabled"):
            # Reset in-memory tracking while paused so re-enabling re-arms fresh instead of
            # jumping straight from the OLD level to wherever price is now in one leap.
            self._last_level = None
            return
        price = await self.fetch_current_price()
        if price is None:
            return

        spacing_pct = float(state["spacing_pct"])
        step = math.log(1 + spacing_pct / 100.0)
        persisted_level = state.get("internal_last_level")
        persisted_spacing = state.get("internal_spacing_pct")
        spacing_changed = persisted_spacing is not None and float(persisted_spacing) != spacing_pct

        if self._last_level is None:
            if persisted_level is not None and not spacing_changed:
                # Resume from where a previous process instance left off, so the holdings dict
                # (which survived in the DB) stays level-consistent with the tracker.
                self._last_level = int(persisted_level)
                return
            center_lvl = level_of(price, step)
            is_genuinely_fresh = persisted_level is None
            await self.arm_grid(state, price, center_lvl,
                                 "grid_rearmed_spacing_changed" if spacing_changed else "grid_armed",
                                 seed_initial_position=is_genuinely_fresh)
            return

        if spacing_changed:
            center_lvl = level_of(price, step)
            await self.arm_grid(state, price, center_lvl, "grid_rearmed_spacing_changed")
            return

        await self.process_price(price, state)
        await self.update_state({"internal_last_level": self._last_level, "internal_spacing_pct": spacing_pct})


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
