"""
Paper-only LIT/USDC grid bot (2026-10-18, direct request).

NOT a real-money bot: no exchange credentials anywhere in this file, no order placement -- it
only reads Lighter's public LIT/USDC live trade price (market_id 2049, no auth needed) and
simulates fills against the configured grid, logging each individual buy and sell fill as its
own row to lighter_lit_grid_trades the instant it happens for the dashboard panel to show.

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

Three fixes from an independent external audit (2026-10-18, see LIT_GRID_BOT_AUDIT_2026-10-18.md
for the full writeup), all confirmed directly against this code before fixing:
  - level_of now takes an optional `reference` (the currently held level) and refuses to accept a
    new level unless the boundary is cleared by GUARD_FRAC of a full step -- a price confined to a
    band straddling one exact grid line could otherwise flip the detected level on pure noise and
    book a fill at a line real price never meaningfully cleared (demonstrated live: ~$3.87 of
    fictitious profit from a price band ~0.003% wide). Only engages right at a boundary; a
    genuine multi-level move clears it by far more than the guard and is unaffected.
  - arm_grid's initial seed now sizes the down-side reserve and the up-side buy with ONE unified
    formula (capital / (price_sum_over_down_levels + levels_up * price)) instead of sizing the
    down side off the FULL capital and then separately spending some of that same capital on the
    up-side seed -- the old version's real down-side reserve (capital minus the up-side spend) was
    always less than what the down-side math assumed, exhausting it before the configured
    drawdown depth (demonstrated live: 265 levels of reserve instead of the intended 286).
  - a spacing-change re-arm now remaps every existing holding to the level implied by its REAL
    cost under the NEW step, instead of leaving old level-index keys in place to be reinterpreted
    under a different step -- the old version let a position bought to sell at ~$3.10 silently
    retarget to an unrelated price (demonstrated live: $3.1012 -> $2.4733) purely from a spacing
    change, with no real price move at all.
  - process_price now persists state (balances/holdings/level) immediately after EACH individual
    fill, writing it BEFORE logging that fill's trade row, instead of accumulating a whole tick's
    fills in memory and writing once at the end -- a crash partway through a multi-level walk used
    to leave fills already logged to lighter_lit_grid_trades while the position/level that
    governs the NEXT tick was still the pre-walk value, so a restart would replay and re-log the
    same fills a second time. Narrows the remaining failure window to "this one fill's trade-log
    row might be missing" (harmless, already fault-tolerant in log_fill) instead of "this whole
    tick's fills might be double-counted."
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
# Guard band for level_of's hysteresis (2026-10-18, external audit finding -- see module
# docstring). Expressed as a fraction of ONE grid step so it automatically scales with whatever
# spacing_pct is configured, rather than a fixed price amount that would be too loose at wide
# spacing and too tight at narrow spacing. 2% of a step is comfortably larger than any float
# round-trip noise through log()/exp() (~1e-12 relative) while leaving genuine small moves (which
# clear a boundary by a much larger margin) completely unaffected.
LEVEL_GUARD_FRAC = 0.02


def level_of(price: float, step: float, reference: int = None) -> int:
    # floor(), not round() (2026-10-18, Opus audit -- confirmed by reproducing it directly).
    # round() made a crossing trigger at the MIDPOINT between two grid lines (half a spacing
    # step away), while the fill price recorded a FULL step's move -- so price noise smaller
    # than the configured spacing could still flip the detected level and book a full-size
    # "profitable" fill that never happened: real price moved ~0.00002 in the reproduction, but
    # the bot recorded a full-level profitable round trip anyway. floor() makes the trigger
    # threshold a real grid line (a full spacing step away), matching the fill price distance,
    # so sub-spacing noise can no longer move the detected level at all.
    raw = math.log(price) / step
    lvl = math.floor(raw)
    if reference is not None and lvl != reference:
        # Residual case floor() alone doesn't cover (2026-10-18, external audit, confirmed):
        # price sitting almost exactly ON a boundary can still flip floor()'s result on pure
        # noise. Require the move to clear the boundary (the first line between `reference` and
        # `lvl`, whichever direction) by more than a small guard margin before accepting it --
        # a genuine multi-level move clears this by far more than the guard and is unaffected.
        boundary = (reference + 1) if lvl > reference else reference
        if abs(raw - boundary) < LEVEL_GUARD_FRAC:
            return reference
    return lvl


def _price_sum_for_levels(current_price: float, spacing_pct: float, levels_down: int) -> float:
    """Sum of price at each of levels_down descending geometric steps below current_price."""
    r = 1.0 / (1.0 + spacing_pct / 100.0)
    price_sum = 0.0
    p = current_price
    for _ in range(max(1, levels_down)):
        p *= r
        price_sum += p
    return price_sum


def compute_order_size_lit(capital_usd: float, current_price: float, spacing_pct: float, levels_down: int) -> float:
    """capital_usd / sum(price at each down-level) -- full reserve against the configured depth."""
    price_sum = _price_sum_for_levels(current_price, spacing_pct, levels_down)
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

    async def log_fill(self, side, price, qty, pnl_usd, order_type, at):
        """Direct correction (2026-10-18): "buy and sell, not a round trip -- I need to know the
        order so we know what's happening, matching the price going up and down." Logs each
        individual fill as its own row the instant it happens (a buy the moment it fills, a sell
        the moment it fills), instead of waiting for a sell to close a position and writing one
        combined round-trip row. side is literally 'buy' or 'sell'. Reuses the existing
        entry_price/exit_price columns (both set to the single fill price) rather than adding a
        migration -- a buy row's pnl_usd is 0 (nothing realized yet), a sell row's is the real
        profit from closing whatever it paired against.

        Called AFTER the matching update_state in process_price (2026-10-18, external audit fix)
        -- a failure here is already fault-tolerant (caught below, logged, never raised), and
        this ordering means the position/balance state that governs the NEXT tick is never left
        pointing at a fill that failed to get logged, only (at worst) a logged fill missing its
        own audit row."""
        row = {
            "side": side, "opened_at": at, "closed_at": at,
            "entry_price": price, "exit_price": price,
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
        quantity sells AT when reached: holdings[L] = {"qty", "cost"} means "resting sell armed
        at L+1, for this qty, bought at this real cost". Reaching L+1 sells exactly that qty at
        a profit of (fill_price - cost), no matter what path price took to get there --
        including repeated chop between the same two adjacent lines in a flat market, which is
        the actual point of a grid bot. No held LIT at L -> reaching L+1 just does nothing there
        (a Long grid only ever sells inventory it actually bought, no naked shorts).

        `cost` is usually exp(L*step) (an organic buy really did fill at that exact line), but
        NOT always: the initial seed (see arm_grid) buys everything at ONE real market price and
        distributes it across several target levels, so those entries carry that one shared real
        cost instead of each level's own price -- recording it as the level's own price would
        understate real future profit on that inventory (found live 2026-10-18, user noticed
        Total PNL looked off and asked why).

        Real usdc_balance/lit_balance are the source of truth for every fill -- a buy that can't
        be afforded from real usdc_balance does not happen (deferred, like a real unfilled
        resting order), not re-derived from the full original capital every tick.

        Walks level-by-level between the last seen price and this new one (2026-10-18: now a
        real consecutive live-price pair, not an OHLC approximation of a whole closed minute) --
        every line crossed in between is its own fill event, so a fast multi-level move still
        fills every line it actually passed through, not just the endpoint.

        State is persisted after EACH individual fill, not once at the end of the walk (2026-10-18,
        external audit fix -- see module docstring): a crash mid-walk must never leave fills
        already logged while the position/level that governs the next tick is still pre-walk,
        which used to cause the next tick to replay and duplicate them."""
        spacing_pct = float(state["spacing_pct"])
        step = math.log(1 + spacing_pct / 100.0)
        order_type = state["order_type"]
        usdc_balance = float(state["usdc_balance"])
        lit_balance = float(state["lit_balance"])
        bot_profit_usd = float(state["bot_profit_usd"])
        if state["compounding_enabled"]:
            # Direct correction (2026-10-18): "you can get less money with compounding. It is
            # impossible." Was right -- the old basis (usdc_balance + lit_balance*price, the
            # TOTAL real account value) can genuinely shrink during a down-trend purely from
            # unrealized LIT mark-to-market loss, which shrank order size below what flat
            # capital would have used, producing LESS realized profit than flat. Compounding
            # must grow from REALIZED winnings only (capital_usd + bot_profit_usd), which can
            # only ever increase or stay flat -- never dragged down by the market's own swings
            # on inventory still held. This guarantees compounding's order size is always >=
            # flat's fixed size.
            compounding_basis = float(state["capital_usd"]) + bot_profit_usd
            sizing_levels = levels_for_drawdown(spacing_pct, float(state.get("drawdown_pct") or 30.0))
            order_size = compute_order_size_lit(compounding_basis, price, spacing_pct, sizing_levels)
        else:
            # Fixed at whatever arm_grid computed from the full original capital -- not
            # recomputed every tick, since compounding is off.
            order_size = float(state.get("order_size_lit") or 0.0)

        positions = state.get("open_positions_json") or {"holdings": {}}
        # Back-compat: older rows may still have plain qty numbers instead of {qty, cost}
        # objects (pre-2026-10-18 cost-basis fix) -- treat a bare number as cost = its own level.
        holdings = {}
        for k, v in (positions.get("holdings") or {}).items():
            lvl_k = int(k)
            if isinstance(v, dict):
                holdings[lvl_k] = {"qty": float(v["qty"]), "cost": float(v["cost"])}
            else:
                holdings[lvl_k] = {"qty": float(v), "cost": math.exp(lvl_k * step)}

        if self._last_level is None:
            self._last_level = level_of(price, step)
        lvl = self._last_level
        target_lvl = level_of(price, step, reference=lvl)

        blocked = False  # ran out of real USDC -- stop advancing entirely, defer the rest
        # A fresh timestamp per individual fill (not once per tick) -- a fast multi-level move
        # can fill several lines in one tick, and each fill needs its own correctly-ordered time
        # so the panel's chronological fill log reads in the real order they happened.
        def fill_now():
            return datetime.now(timezone.utc).isoformat()

        while lvl != target_lvl and not blocked:
            if target_lvl > lvl:
                lvl += 1
                fill_price = math.exp(lvl * step)
                buy_level = lvl - 1
                entry = holdings.get(buy_level)
                if entry and entry["qty"] > 0:
                    qty, buy_price = entry["qty"], entry["cost"]
                    proceeds = fill_price * qty
                    pnl = (fill_price - buy_price) * qty
                    if order_type == "market":
                        cost = (MARKET_ROUNDTRIP_COST_PCT / 100.0) * ((fill_price + buy_price) / 2) * qty
                        proceeds -= cost
                        pnl -= cost
                    lit_balance -= qty
                    usdc_balance += proceeds
                    bot_profit_usd += pnl
                    del holdings[buy_level]
                    self._last_level = lvl
                    fill_at = fill_now()
                    await self.update_state({
                        "live_price": price, "live_level": lvl, "order_size_lit": order_size,
                        "usdc_balance": usdc_balance, "lit_balance": lit_balance, "bot_profit_usd": bot_profit_usd,
                        "open_positions_json": {"holdings": {str(k): v for k, v in holdings.items() if v["qty"] > 0}},
                        "internal_last_level": lvl, "internal_spacing_pct": spacing_pct,
                        "updated_at": fill_at,
                    })
                    await self.log_fill("sell", fill_price, qty, pnl, order_type, fill_at)
                else:
                    # No holding at buy_level -- no resting sell order armed here, do nothing.
                    self._last_level = lvl
            else:
                lvl -= 1
                fill_price = math.exp(lvl * step)
                cost = fill_price * order_size
                if usdc_balance >= cost:
                    usdc_balance -= cost
                    lit_balance += order_size
                    existing = holdings.get(lvl)
                    if existing and existing["qty"] > 0:
                        # Weighted-average cost if this exact level already holds something
                        # (rare -- normally cleared by a sell before being revisited).
                        total_qty = existing["qty"] + order_size
                        avg_cost = (existing["qty"] * existing["cost"] + order_size * fill_price) / total_qty
                        holdings[lvl] = {"qty": total_qty, "cost": avg_cost}
                    else:
                        holdings[lvl] = {"qty": order_size, "cost": fill_price}
                    self._last_level = lvl
                    fill_at = fill_now()
                    await self.update_state({
                        "live_price": price, "live_level": lvl, "order_size_lit": order_size,
                        "usdc_balance": usdc_balance, "lit_balance": lit_balance, "bot_profit_usd": bot_profit_usd,
                        "open_positions_json": {"holdings": {str(k): v for k, v in holdings.items() if v["qty"] > 0}},
                        "internal_last_level": lvl, "internal_spacing_pct": spacing_pct,
                        "updated_at": fill_at,
                    })
                    await self.log_fill("buy", fill_price, order_size, 0, order_type, fill_at)
                else:
                    blocked = True

        self._last_level = lvl
        # Display-only refresh -- always runs, even when this tick produced zero fills (the
        # common case), so the panel's live price keeps moving. Never touches balances/holdings.
        await self.update_state({
            "live_price": price, "live_level": lvl, "order_size_lit": order_size,
            "updated_at": datetime.now(timezone.utc).isoformat(),
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
        only enough LIT to cover `levels_up` sell orders. Each of those `levels_up` orders is
        its own separate holdings[level] entry (see process_price) so each one sells
        independently and correctly when its own specific level is reached -- not one lump sum.
        Only applies on a genuine first-ever start (never on a spacing-change re-arm, which must
        remap the existing position instead -- see below).

        Sizing (2026-10-18, external audit fix -- see module docstring): order_size is now ONE
        unified value solved from capital_usd = order_size * (price_sum_over_down_levels +
        levels_up * center_price), so the up-side seed buy and the down-side reserve are sized
        against the SAME total capital instead of the down side being sized off the full
        capital_usd while the up-side seed quietly spends some of that same capital -- which
        used to exhaust the real reserve before the configured drawdown depth.

        Spacing-change remap (2026-10-18, external audit fix -- see module docstring): when this
        is NOT a fresh seed, any existing holdings are remapped from their old level-index key to
        level_of(their real cost, NEW step) -- so a position bought to sell one level above its
        real cost keeps meaning that under the new spacing, instead of its old integer key being
        silently reinterpreted as a different price."""
        self._last_level = center_lvl
        spacing_pct = float(state["spacing_pct"])
        usdc_balance = float(state["usdc_balance"])
        lit_balance = float(state["lit_balance"])

        patch = {}
        if seed_initial_position:
            capital_usd = float(state["capital_usd"])
            down_sizing_levels = levels_for_drawdown(spacing_pct, float(state.get("drawdown_pct") or 30.0))
            levels_up = max(1, int(state["levels_up"]))
            price_sum = _price_sum_for_levels(center_price, spacing_pct, down_sizing_levels)
            denom = price_sum + levels_up * center_price
            order_size = capital_usd / denom if denom > 0 else 0.0
            lit_value_usd = order_size * levels_up * center_price
            # Safety clamp: never let the up-side allocation eat so much of the capital that
            # the down side (the much deeper, more important reserve) is starved. Rarely binds
            # now that the unified formula above already budgets both sides within capital_usd.
            lit_value_usd = min(lit_value_usd, capital_usd * 0.9)
            actual_order_size = lit_value_usd / levels_up / center_price if levels_up > 0 else 0.0
            usdc_balance = capital_usd - lit_value_usd
            lit_balance = actual_order_size * levels_up
            # One holding per level, exactly like Bitsgap pre-arming a separate sell order at
            # each level above price -- NOT one lump entry. holdings[center_lvl + k] represents
            # "sells when price reaches one level above it". Cost basis for every one of these
            # is the SAME real price (center_price) -- this is one real market buy for the whole
            # up-side quantity at today's price, distributed across several future sell targets,
            # not several buys at each target's own (higher) price.
            patch["open_positions_json"] = {
                "holdings": {str(center_lvl + k): {"qty": actual_order_size, "cost": center_price}
                             for k in range(levels_up)}
            }
            patch["usdc_balance"] = usdc_balance
            patch["lit_balance"] = lit_balance
            patch["order_size_lit"] = order_size
        else:
            # Spacing-change re-arm on an already-running position: keep using whatever
            # order_size is already in effect (recomputed fresh every tick in process_price
            # when compounding is on; otherwise it stays fixed from the original arm).
            order_size = float(state.get("order_size_lit") or 0.0)

            old_spacing_pct = state.get("internal_spacing_pct")
            new_step = math.log(1 + spacing_pct / 100.0)
            old_step = math.log(1 + float(old_spacing_pct) / 100.0) if old_spacing_pct is not None else new_step
            old_holdings = (state.get("open_positions_json") or {}).get("holdings") or {}
            remapped = {}
            for k, v in old_holdings.items():
                if isinstance(v, dict):
                    qty, cost = float(v["qty"]), float(v["cost"])
                else:
                    # Legacy bare-number holding, no recorded cost -- recover its real cost
                    # from the OLD step (its key WAS its level under the spacing then in effect).
                    qty, cost = float(v), math.exp(int(k) * old_step)
                if qty <= 0:
                    continue
                new_lvl = level_of(cost, new_step)
                existing = remapped.get(new_lvl)
                if existing:
                    total_qty = existing["qty"] + qty
                    avg_cost = (existing["qty"] * existing["cost"] + qty * cost) / total_qty
                    remapped[new_lvl] = {"qty": total_qty, "cost": avg_cost}
                else:
                    remapped[new_lvl] = {"qty": qty, "cost": cost}
            patch["open_positions_json"] = {"holdings": {str(k): v for k, v in remapped.items()}}

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
