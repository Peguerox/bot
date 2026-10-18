"""
REAL-MONEY LIT/USDC grid bot (2026-10-18, direct request after Worker 4's BTC stochastic clone
had a bad weekend). Places real resting LIMIT orders on Lighter's LIT/USDC spot market
(market_id 2049) and tracks them durably. Reuses the pure grid math already proven in
server/lit_grid_paper.py (level_of, compute_order_size_lit, levels_for_drawdown) and the
websocket price feed (LiveBook) -- only the EXECUTION layer here is new, not the decision math.

THE CORE SAFETY REQUIREMENT (direct user request, stated explicitly before any of this was
built): a durable log of every real order, with a stable ID and the ACTUAL filled price, that
survives a restart -- so the bot never ends up holding LIT with no record of what it cost.
lighter_lit_grid_live_orders is that ledger: one row per order, written BEFORE the order is even
sent (status='pending'), updated in place as its real status resolves -- never a new row per
event. On every start (restart, redeploy, manual enable), reconcile_pending_orders() checks every
non-terminal row against the exchange's own account_orders() before any new decision is made, and
a periodic balance-divergence check compares ledger-derived holdings against the real exchange
balance, pausing new orders (never silently trusting internal bookkeeping) if they disagree by
more than a rounding step.

Nothing in this codebase has placed a real LIMIT order before this (stoch_bot_core.py's
place_order only ever sends MARKET orders; native SL/TP are the only conditional orders that
exist). The Lighter SDK (lighter.SignerClient.create_order) supports real ORDER_TYPE_LIMIT with
ORDER_TIME_IN_FORCE_POST_ONLY -- used here specifically because Lighter's maker fee on this pair
is confirmed 0%, so POST_ONLY guarantees every fill is a maker fill, matching this session's own
"limit beats market" research conclusion for this strategy.

Precision (2026-10-18, confirmed live against Lighter's own orderBooks endpoint for market 2049):
price to 4 decimals, size to 2 decimals, hard minimum 1.00 LIT per order -- no dynamic
market-metadata fetch exists anywhere in this codebase (every bot hardcodes decimals per market,
same convention here). clamp_order_size() refuses (returns None) rather than ever place an
undersized order that the exchange would reject.

OPEN VERIFICATION ITEM, flagged honestly rather than silently assumed: whether the SDK's
account_orders() response (filled_base_amount/filled_quote_amount) comes back in the same raw
integer units the REQUEST side uses (price * 10**PRICE_DECIMALS, size * 10**SIZE_DECIMALS) or
already human-scaled. _order_fill_amounts() isolates this one conversion in a single place,
assumes raw integer units (matching the SDK's general request/response symmetry elsewhere in
this codebase), and reconcile_pending_orders() logs the RAW response alongside the computed
values specifically so the first real order placed (the single-order live-fire test called for
before enabling the full ladder) can confirm or correct this in one place before real capital
depends on it.

Starts disabled. Nothing here ever places a real order until enabled=true is set from the
dashboard -- explicitly the user's call, same standing rule as every other live bot.
"""
import asyncio
import contextlib
import math
import os
import time
import json as jsonlib
from datetime import datetime, timezone

import aiohttp
import lighter

from lit_grid_paper import (
    level_of, compute_order_size_lit, levels_for_drawdown, LiveBook,
    STREAM_URL, BOOK_MAX_AGE, BOOK_WS_RECONNECT_AFTER,
)

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
LIGHTER_URL = "https://mainnet.zklighter.elliot.ai"

MARKET_ID = 2049  # LIT/USDC spot
TABLE_STATE = "lighter_lit_grid_live_state"
TABLE_ORDERS = "lighter_lit_grid_live_orders"
TABLE_RUNS = "lighter_lit_grid_live_runs"

# Confirmed live 2026-10-18 against GET /api/v1/orderBooks, market_id=2049:
# supported_price_decimals=4, supported_size_decimals=2, min_base_amount="1.00".
PRICE_DECIMALS = 4
SIZE_DECIMALS = 2
MIN_BASE_AMOUNT = 1.00

TICK_EVERY = 3.0
REST_TIMEOUT = 8.0
ORDER_TIMEOUT = 12.0
AUTH_TOKEN_LIFETIME_S = 10 * 60
AUTH_TOKEN_REFRESH_MARGIN_S = 60.0
LOCK_REFRESH_EVERY = 5.0
LOCK_STALE_AFTER = 30.0
RATE_LIMIT_BACKOFF_START = 15.0
RATE_LIMIT_BACKOFF_MAX = 120.0
# How often to re-check ledger-derived holdings against the real exchange balance (independent
# of TICK_EVERY -- this hits a REST endpoint, unlike the push-based price feed, so it runs much
# less often, same "don't add request-heavy loops" discipline as everywhere else in this codebase).
BALANCE_RECONCILE_EVERY = 60.0
# Tolerance before a balance mismatch pauses new order placement -- a bit more than one rounding
# step (0.01 LIT), so float noise from repeated roundings never false-positives a real divergence.
BALANCE_DIVERGENCE_TOLERANCE_LIT = 0.03


def round_price(price):
    return round(price, PRICE_DECIMALS)


def round_size(qty):
    return round(qty, SIZE_DECIMALS)


def clamp_order_size(qty):
    """Rounds to the exchange's real size precision and enforces its real minimum. Returns None
    (never a too-small order) if the result would round below MIN_BASE_AMOUNT -- the caller must
    treat None as "can't place this, pause/defer", exactly like the paper bot defers a buy it
    can't afford."""
    sized = round_size(qty)
    if sized < MIN_BASE_AMOUNT:
        return None
    return sized


def price_to_int(price):
    return int(round(price * (10 ** PRICE_DECIMALS)))


def size_to_int(qty):
    return int(round(qty * (10 ** SIZE_DECIMALS)))


def _order_fill_amounts(order):
    """Isolates the one open scaling assumption called out in the module docstring. Returns
    (filled_qty, filled_price) or (0.0, None) if nothing has filled yet. The PRICE is safe
    either way (filled_quote/filled_base is a ratio, unit-invariant regardless of scaling) --
    only the raw QTY depends on getting this right, which is why it's isolated here."""
    filled_base_raw = float(getattr(order, "filled_base_amount", 0) or 0)
    filled_quote_raw = float(getattr(order, "filled_quote_amount", 0) or 0)
    if filled_base_raw <= 0:
        return 0.0, None
    filled_price = filled_quote_raw / filled_base_raw
    filled_qty = filled_base_raw / (10 ** SIZE_DECIMALS)
    return filled_qty, filled_price


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class LitGridLive:
    def __init__(self, http: aiohttp.ClientSession):
        self.http = http
        self._lock_id = f"{os.environ.get('RENDER_INSTANCE_ID', 'local')}:lit-grid-live"
        self._lock_held = False
        self._lock_checked_at = 0.0
        self._lock_blocked_logged = False
        self._last_level = None
        self.live = LiveBook(MARKET_ID)
        self._book_ws_connected_at = 0.0
        self.client = None
        self.account_index = None
        self._order_api = None
        self._account_api = None
        self._auth_token = None
        self._auth_token_expiry_at = 0.0
        self._last_balance_check = 0.0
        self._balance_paused = False

    # ── Supabase (same pattern as lit_grid_paper.py) ────────────────────────────────────────────
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
        print(f"[lit-grid-live:{action}] {detail}", flush=True)
        try:
            await self.sb("POST", TABLE_RUNS, {"action": action, "detail": detail})
        except Exception as e:
            print(f"  (lit-grid-live log_run failed: {e})", flush=True)

    # ── Order ledger (the core safety requirement) ──────────────────────────────────────────────
    async def place_grid_order(self, level, side, limit_price, size):
        """Writes the ledger row FIRST, status='pending', before the real order is even sent.
        If the send itself raises/times out, the row stays 'pending' -- the outcome is genuinely
        UNKNOWN (the order may have gone through even if reading our own response failed), and
        reconcile_pending_orders() checks the exchange for the real answer on the next pass,
        exactly like confirm_fill's "unknown is not the same as no fill" philosophy elsewhere in
        this codebase. Returns the ledger row id, or None if the exchange explicitly rejected it."""
        co_idx = int(time.time() * 1000) % 500_000_000
        row = {
            "level": level, "side": side, "client_order_index": co_idx,
            "status": "pending", "limit_price": limit_price, "size": size,
            "placed_at": now_iso(),
        }
        inserted = await self.sb("POST", TABLE_ORDERS, row)
        row_id = inserted[0]["id"]
        is_ask = (side == "sell")
        price_int = price_to_int(limit_price)
        size_int = size_to_int(size)
        try:
            _order, _resp, err = await asyncio.wait_for(
                self.client.create_order(
                    market_index=MARKET_ID, client_order_index=co_idx,
                    base_amount=size_int, price=price_int, is_ask=is_ask,
                    order_type=self.client.ORDER_TYPE_LIMIT,
                    time_in_force=self.client.ORDER_TIME_IN_FORCE_POST_ONLY,
                    reduce_only=False,
                ),
                timeout=ORDER_TIMEOUT,
            )
            if err:
                await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row_id}",
                               {"status": "rejected", "error": str(err)[:200]})
                return None
        except Exception as e:
            await self.log_run("order_place_unknown", {"row_id": row_id, "error": str(e)[:200]})
            return row_id  # left 'pending' on purpose -- reconciliation resolves it for real
        await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row_id}", {"status": "open"})
        return row_id

    async def cancel_order_row(self, row):
        """Cancels one specific resting order by its real exchange order_index -- the SDK does
        support selective cancel (lighter.SignerClient.cancel_order), unlike every other bot in
        this codebase which only ever uses the blanket cancel_all_orders (they never run more
        than one resting order at a time, so blanket was always safe for them; a grid ladder
        with many simultaneous resting orders needs selective cancel so touching one level never
        disturbs the others)."""
        order_index = row.get("exchange_order_id")
        if order_index is None:
            return  # never got a real order_index back -- nothing on the book to cancel
        try:
            await asyncio.wait_for(
                self.client.cancel_order(market_index=MARKET_ID, order_index=int(order_index)),
                timeout=ORDER_TIMEOUT,
            )
        except Exception as e:
            await self.log_run("cancel_order_failed", {"row_id": row["id"], "error": str(e)[:200]})
            return
        await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row['id']}",
                       {"status": "cancelled", "filled_at": now_iso()})

    async def reconcile_pending_orders(self):
        """Runs before every tick's new decisions -- checks every non-terminal ledger row against
        the exchange's own account_orders() (by OUR OWN client_order_index, up to 20 at a time).
        This is what makes a restart safe: nothing here is ever assumed from memory, only from
        what the exchange itself reports right now."""
        pending = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=in.(pending,open)&select=*&order=id.asc")
        if not pending:
            return
        auth = self._get_auth_token()
        for batch in _chunks(pending, 20):
            co_idxs = ",".join(str(r["client_order_index"]) for r in batch)
            try:
                resp = await asyncio.wait_for(
                    self._order_api.account_orders(
                        authorization=auth, client_order_indexes=co_idxs,
                        account_index=self.account_index, _request_timeout=REST_TIMEOUT,
                    ),
                    timeout=REST_TIMEOUT + 2.0,
                )
            except Exception as e:
                await self.log_run("reconcile_read_failed", {"error": str(e)[:200]})
                continue
            by_co = {int(o.client_order_index): o for o in (resp.orders or [])}
            for r in batch:
                o = by_co.get(r["client_order_index"])
                if o is None:
                    continue  # still genuinely unknown -- leave pending, retry next pass
                filled_qty, filled_price = _order_fill_amounts(o)
                status = str(getattr(o, "status", "") or "").lower()
                patch = {"exchange_order_id": o.order_index}
                if filled_qty > 0:
                    patch.update({"status": "filled", "filled_qty": filled_qty,
                                  "filled_price": filled_price, "filled_at": now_iso()})
                elif status in ("cancelled", "canceled", "rejected", "expired"):
                    patch["status"] = "cancelled" if "cancel" in status else "rejected"
                else:
                    patch["status"] = "open"  # confirmed resting, nothing filled yet
                await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{r['id']}", patch)
                await self.log_run("reconciled_order", {
                    "row_id": r["id"], "raw_status": status,
                    "raw_filled_base": getattr(o, "filled_base_amount", None),
                    "raw_filled_quote": getattr(o, "filled_quote_amount", None),
                    "computed_filled_qty": filled_qty, "computed_filled_price": filled_price,
                })

    async def real_balances(self):
        """Ground truth, straight from the exchange -- never the ledger, never a cached value.
        DetailedAccount.assets is a list of {symbol, balance, locked_balance, ...}; locked_balance
        covers funds committed to open orders (LIT in resting sells, USDC in resting buys), so
        TOTAL real holding of each is balance+locked. Returns (usdc, lit)."""
        auth = self._get_auth_token()
        resp = await asyncio.wait_for(
            self._account_api.account(by="index", value=str(self.account_index),
                                       _headers={"authorization": auth} if auth else None,
                                       _request_timeout=REST_TIMEOUT),
            timeout=REST_TIMEOUT + 2.0,
        )
        acct = resp.accounts[0] if getattr(resp, "accounts", None) else resp
        usdc, lit = 0.0, 0.0
        for asset in (getattr(acct, "assets", None) or []):
            symbol = getattr(asset, "symbol", None)
            total = float(asset.balance or 0) + float(asset.locked_balance or 0)
            if symbol == "LIT":
                lit = total
            elif symbol == "USDC":
                usdc = total
        return usdc, lit

    async def check_balance_divergence(self):
        """Periodic, not every tick (a real REST call) -- sums ledger-derived holdings (every
        'filled' buy not yet matched by a 'filled' sell one level above) and compares against the
        real exchange LIT balance. A mismatch beyond tolerance pauses new order placement and
        logs loudly -- real balance is always ground truth over internal bookkeeping, same
        philosophy as every other live bot in this codebase. Returns True if it's safe to place
        new orders."""
        now = time.time()
        if now - self._last_balance_check < BALANCE_RECONCILE_EVERY:
            return not self._balance_paused
        self._last_balance_check = now
        holdings = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=eq.filled&side=eq.buy&select=level,filled_qty")
        sells = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=eq.filled&side=eq.sell&select=level")
        sold_levels = {s["level"] - 1 for s in (sells or [])}  # a sell at L+1 closes the buy at L
        ledger_lit = sum(float(h["filled_qty"] or 0) for h in (holdings or [])
                          if h["level"] not in sold_levels)
        try:
            real_usdc, real_lit = await self.real_balances()
            await self.update_state({"usdc_balance": real_usdc, "lit_balance": real_lit})
        except Exception as e:
            await self.log_run("balance_check_failed", {"error": str(e)[:200]})
            return not self._balance_paused
        diverged = abs(ledger_lit - real_lit) > BALANCE_DIVERGENCE_TOLERANCE_LIT
        if diverged and not self._balance_paused:
            await self.log_run("balance_divergence_paused",
                                {"ledger_lit": ledger_lit, "real_lit": real_lit})
        elif not diverged and self._balance_paused:
            await self.log_run("balance_divergence_cleared",
                                {"ledger_lit": ledger_lit, "real_lit": real_lit})
        self._balance_paused = diverged
        return not diverged

    # ── Auth (identical caching pattern to stoch_bot_core.py's _get_auth_token) ─────────────────
    def _get_auth_token(self):
        now = time.time()
        if self._auth_token is not None and now < self._auth_token_expiry_at - AUTH_TOKEN_REFRESH_MARGIN_S:
            return self._auth_token
        token, err = self.client.create_auth_token_with_expiry()
        if err:
            return None
        self._auth_token = token
        self._auth_token_expiry_at = now + AUTH_TOKEN_LIFETIME_S
        return self._auth_token

    # ── Single-instance lock (same pattern as every other live bot) ────────────────────────────
    async def acquire_lock(self):
        now = time.time()
        if now - self._lock_checked_at < LOCK_REFRESH_EVERY:
            return self._lock_held
        self._lock_checked_at = now
        stale_before = datetime.now(timezone.utc).timestamp() - LOCK_STALE_AFTER
        stale_iso = datetime.fromtimestamp(stale_before, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        guard = (f"or=(lock_owner.is.null,lock_heartbeat.is.null,"
                 f"lock_owner.eq.{self._lock_id},lock_heartbeat.lt.{stale_iso})")
        try:
            rows = await self.sb(
                "PATCH", f"{TABLE_STATE}?id=eq.1&{guard}",
                {"lock_owner": self._lock_id, "lock_heartbeat": now_iso()},
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

    # ── Live price (push-based, same LiveBook as the paper bot) ────────────────────────────────
    async def fetch_current_price(self):
        return self.live.best_mid()

    async def _book_ws_session(self):
        ws = lighter.WsClient(
            order_book_ids=[MARKET_ID], account_ids=[],
            on_order_book_update=self.live.on_order_book_update,
            ws_url=STREAM_URL,
        )
        self._book_ws_connected_at = time.time()
        await ws.run_async()

    async def run_book_ws_forever(self):
        while True:
            task = asyncio.create_task(self._book_ws_session())
            try:
                while not task.done():
                    await asyncio.sleep(2.0)
                    quiet_since = max(self.live.updated_at, self._book_ws_connected_at)
                    age = time.time() - quiet_since
                    if age > BOOK_WS_RECONNECT_AFTER:
                        await self.log_run("book_ws_watchdog_reconnect", {"ob_age": round(age, 1)})
                        break
                if task.done() and not task.cancelled():
                    exc = task.exception()
                    if exc is not None:
                        await self.log_run("book_ws_disconnected", {"error": str(exc)[:300]})
            except Exception as e:
                await self.log_run("book_ws_supervisor_error", {"error": str(e)[:300]})
            finally:
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task
            await asyncio.sleep(1.0)

    # ── Window maintenance: the real-order analogue of the paper bot's process_price ───────────
    async def current_holdings(self):
        """Reconstructs holdings[level] = {qty, cost} purely from the ledger's filled rows --
        never from memory. A filled buy at level L is "open" (not yet sold) unless a filled sell
        at L+1 closes it -- same tied one-level-above pairing as the paper bot, just driven by
        real fills instead of simulated ones."""
        buys = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=eq.filled&side=eq.buy&select=level,filled_qty,filled_price&order=id.asc")
        sells = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=eq.filled&side=eq.sell&select=level")
        sold_levels = {s["level"] - 1 for s in (sells or [])}
        holdings = {}
        for b in (buys or []):
            lvl = b["level"]
            if lvl in sold_levels:
                continue
            holdings[lvl] = {"qty": float(b["filled_qty"] or 0), "cost": float(b["filled_price"] or 0)}
        return holdings

    async def resting_orders_by_level(self):
        rows = await self.sb("GET", f"{TABLE_ORDERS}?status=in.(pending,open)&select=*")
        by_level = {}
        for r in (rows or []):
            by_level.setdefault(r["level"], []).append(r)
        return by_level

    async def maintain_window(self, state, price):
        """Each tick: make sure the small active window around the current price has exactly the
        resting orders it should, placing new ones for newly-active levels and cancelling ones
        that fell out of the window -- the real-order analogue of the paper bot's instant-fill
        walk, except real orders rest asynchronously instead of filling the instant a level is
        crossed. levels_up/levels_down here are the SAME "small active-tracking window" concept
        already documented in lit_grid_paper.py, not the sizing depth (drawdown_pct is)."""
        spacing_pct = float(state["spacing_pct"])
        step = math.log(1 + spacing_pct / 100.0)
        levels_up = max(1, int(state["levels_up"]))
        levels_down = max(1, int(state["levels_down"]))
        cur_lvl = level_of(price, step)

        order_size_lit = state.get("order_size_lit")
        if order_size_lit is None:
            # Unlike the paper bot's arm_grid, there's no upfront lump-sum seed here -- real
            # resting orders only exist once a buy actually fills, so sizing is just capital
            # against the configured drawdown depth, recomputed once after a settings change
            # (the settings route nulls this out) and cached until the next one.
            down_sizing_levels = levels_for_drawdown(spacing_pct, float(state.get("drawdown_pct") or 10.0))
            order_size_lit = compute_order_size_lit(
                float(state["capital_usd"]), price, spacing_pct, down_sizing_levels)
            await self.update_state({"order_size_lit": order_size_lit})
        order_size = clamp_order_size(float(order_size_lit or 0.0))

        holdings = await self.current_holdings()
        resting = await self.resting_orders_by_level()

        # Cancel resting orders that fell outside the active window (a buy below the down-side
        # window, or a sell whose paired level is no longer current -- conservative: only cancel
        # buys that drifted too far, never touch a resting sell, since that one's paired to a
        # real held buy and must stay until it fills regardless of price wandering).
        for lvl, rows in resting.items():
            for r in rows:
                if r["side"] == "buy" and (lvl > cur_lvl - 1 or lvl < cur_lvl - levels_down):
                    await self.cancel_order_row(r)

        # Place resting BUYS for every empty level in the active down-window.
        if order_size is not None:
            for lvl in range(cur_lvl - 1, cur_lvl - 1 - levels_down, -1):
                if lvl in resting or lvl in holdings:
                    continue
                limit_price = round_price(math.exp(lvl * step))
                await self.place_grid_order(lvl, "buy", limit_price, order_size)

        # Place resting SELLS for every held (filled buy) level that doesn't already have one.
        for lvl, h in holdings.items():
            sell_lvl = lvl + 1
            if sell_lvl in resting:
                continue
            sell_size = clamp_order_size(h["qty"])
            if sell_size is None:
                continue
            limit_price = round_price(math.exp(sell_lvl * step))
            await self.place_grid_order(sell_lvl, "sell", limit_price, sell_size)

    async def market_sell_all(self, qty):
        """A real MARKET order (not a resting limit) -- used ONLY by flatten_all. Every other
        order this bot places is a resting POST_ONLY limit (see module docstring for why); an
        emergency flatten needs a guaranteed real fill instead, same banded-execution-price
        pattern stoch_bot_core.py's place_order already uses for its own market orders."""
        sized = clamp_order_size(qty)
        if sized is None:
            return None
        price = self.live.best_mid()
        if price is None:
            return None
        band_price = round_price(price * 0.995)  # tolerate up to 0.5% slippage, prefer a fill
        co_idx = int(time.time() * 1000) % 500_000_000
        row = {"level": -1, "side": "sell", "client_order_index": co_idx, "status": "pending",
               "limit_price": band_price, "size": sized, "placed_at": now_iso()}
        inserted = await self.sb("POST", TABLE_ORDERS, row)
        row_id = inserted[0]["id"]
        try:
            _o, _r, err = await asyncio.wait_for(
                self.client.create_market_order(
                    market_index=MARKET_ID, client_order_index=co_idx,
                    base_amount=size_to_int(sized), avg_execution_price=price_to_int(band_price),
                    is_ask=True, reduce_only=False,
                ),
                timeout=ORDER_TIMEOUT,
            )
            if err:
                await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row_id}",
                               {"status": "rejected", "error": str(err)[:200]})
                return None
        except Exception as e:
            await self.log_run("flatten_sell_unknown", {"row_id": row_id, "error": str(e)[:200]})
            return row_id
        await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row_id}", {"status": "open"})
        return row_id

    async def flatten_all(self):
        """Emergency path: cancel every resting order, market-sell all held LIT back to USDC,
        then disable. The dashboard route never touches the exchange directly (Python-only
        signing SDK, same reason as every other bot here) -- it only sets flatten_requested=true
        on the state row; this worker picks it up on its next tick and executes through this
        tested path, same flag-based pattern as the hedge panel's Close Both."""
        resting = await self.resting_orders_by_level()
        for rows in resting.values():
            for r in rows:
                await self.cancel_order_row(r)
        holdings = await self.current_holdings()
        total_lit = sum(h["qty"] for h in holdings.values())
        if total_lit > 0:
            await self.market_sell_all(total_lit)
        await self.update_state({"flatten_requested": False, "enabled": False})
        await self.log_run("flatten_completed", {"total_lit_at_start": total_lit})

    async def tick(self):
        state = await self.get_state()
        if state.get("flatten_requested"):
            await self.flatten_all()
            return
        if not state.get("enabled"):
            self._last_level = None
            return
        await self.reconcile_pending_orders()
        if not await self.check_balance_divergence():
            return  # paused -- real balance disagrees with the ledger, never place blind
        price = await self.fetch_current_price()
        if price is None:
            return
        await self.maintain_window(state, price)
        await self.update_state({"live_price": price, "updated_at": now_iso()})


async def _run_tick_loop(bot):
    backoff = RATE_LIMIT_BACKOFF_START
    try:
        while True:
            sleep_for = TICK_EVERY
            try:
                if await bot.acquire_lock():
                    await bot.tick()
                backoff = RATE_LIMIT_BACKOFF_START
            except Exception as e:
                msg = str(e)
                try:
                    await bot.log_run("tick_error", {"error": msg[:300]})
                except Exception:
                    print(f"[lit-grid-live] tick_error (and log_run also failed): {e}", flush=True)
                if "429" in msg or "Too Many Requests" in msg:
                    sleep_for = backoff
                    backoff = min(backoff * 2, RATE_LIMIT_BACKOFF_MAX)
            await asyncio.sleep(sleep_for)
    finally:
        await bot.release_lock()


async def run_lit_grid_live():
    """Entrypoint. Starts disabled -- see module docstring. account_index/api_key_index/
    api_private_key read from this process's own LIGHTER_ACCOUNT_INDEX/LIGHTER_API_KEY_INDEX/
    LIGHTER_API_PRIVATE_KEY env vars, same default-path convention as every standalone bot in
    this codebase (stoch_bot_core.py's run())."""
    async with aiohttp.ClientSession() as http:
        bot = LitGridLive(http)
        bot.account_index = int(os.environ["LIGHTER_ACCOUNT_INDEX"])
        api_key_index = int(os.environ["LIGHTER_API_KEY_INDEX"])
        api_private_key = os.environ["LIGHTER_API_PRIVATE_KEY"]
        bot.client = lighter.SignerClient(
            url=LIGHTER_URL, account_index=bot.account_index,
            api_private_keys={api_key_index: api_private_key},
        )
        bot._order_api = lighter.OrderApi(bot.client.api_client)
        bot._account_api = lighter.AccountApi(bot.client.api_client)
        await bot.log_run("started", {})
        await asyncio.gather(_run_tick_loop(bot), bot.run_book_ws_forever(), return_exceptions=True)
