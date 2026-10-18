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

Second-pass fixes, all from an independent external audit (2026-10-18, after commit 49a64ef),
each confirmed against this code before fixing (several independently re-verified -- e.g. the
fill-amount scaling claim was checked directly against Lighter's own read-schema docs, which show
filled_base_amount as a human-decimal string like "68.0066", not a raw scaled integer):

  - _order_fill_amounts() no longer divides by 10**SIZE_DECIMALS -- the SDK's read responses are
    already human-scaled. The earlier assumption (and the earlier claim that quote/base is
    unit-invariant regardless of scaling) was wrong when base and quote use different scale
    factors, which they do on the request side; it happens to not matter now only because both
    are already real units on the read side.
  - current_holdings() now does FIFO pairing of buys-to-sells WITHIN each level (by ledger row
    id order), not a flat "this level was ever sold" set -- the old version let a second buy
    cycle at a previously-sold level vanish from inventory entirely (reproduced: buy, sell,
    buy-again at the same level returned an empty holdings dict). Multiple still-open buys at one
    level (shouldn't happen by design, defended anyway) are aggregated, not overwritten.
  - reconcile_pending_orders() now uses the order's real `remaining_base_amount` as the primary
    "is this actually done" signal, not "any positive fill = terminal". A genuine partial fill
    now stays `status='open'` (still reconciled every pass, fill progress recorded) until the
    exchange reports nothing left to fill -- the old version marked any partial fill terminal and
    silently stopped tracking further fills on that order forever.
  - flatten_all() now reconciles pending orders FIRST (so a flatten right after placing an order
    can find its real exchange id instead of silently skipping it), checks every cancel's and the
    market sell's real result, and re-reads the REAL exchange LIT balance before ever reporting
    completion -- any failure, or real LIT still above tolerance, leaves flatten_requested=true so
    the next tick retries instead of falsely marking the position flat.
  - reconcile_pending_orders() and check_balance_divergence() both now FAIL CLOSED: an API error
    blocks new order placement for that tick instead of silently letting it proceed (the old
    balance check especially defaulted to "safe to trade" on its very first, unverified call).
  - cancel_order_row() checks the SDK's returned error instead of assuming success whenever no
    exception was raised, and returns a real bool so callers (flatten_all) know whether it worked.
  - maintain_window() takes one in-tick snapshot of resting orders and mutates it in memory as
    THIS tick places/cancels orders, instead of two passes both reading the same stale pre-tick
    state -- the old version could submit a buy and a sell at the identical price in one tick.
    Sells (closing real inventory) are placed before buys and always win a same-level conflict.
    Buy/sell occupancy is now tracked as two separate sets, not one shared "is anything here" set
    keyed only by level.
  - Every buy placement is now checked against real, currently-available usdc_balance (updated by
    check_balance_divergence) before being sent, stopping the loop once real cash runs out --
    capital_usd was previously just an input to a sizing formula, never an enforced spending cap,
    so a small drawdown_pct with a larger levels_down could submit far more notional than the
    configured capital (reproduced: $500 capital, 0.1% drawdown, 50 levels down attempted
    $24,229 of buys).
  - A held lot's sell target is now computed from its REAL recorded cost under the CURRENT
    spacing (`level_of(cost, step) + 1`), not from its stored placement-time level reinterpreted
    under a possibly-changed spacing -- the exact bug already fixed in the paper bot and missed
    here. A spacing change also now triggers a clean cancel-all of every resting order (detected
    via internal_spacing_pct, persisted) before the next tick places anything fresh.
  - The single-instance lock's heartbeat is now touched after every individual order
    placement/cancellation inside a tick, not only once per outer loop iteration -- a tick
    processing several orders (each with up to ORDER_TIMEOUT=12s) could previously run past
    LOCK_STALE_AFTER=30s with its heartbeat still showing stale, letting a second instance
    believe the first was dead and steal the lock mid-flight.
  - Disabling (`enabled=false`) no longer skips reconciliation and existing-position management
    entirely -- it now only blocks placing NEW buys; resting sells for inventory already held
    keep getting maintained, same "lock/pause gates entries only, never exits" principle used
    everywhere else in this codebase.
  - New `max_open_buys` (defaults to 1): a code-enforced cap on new buy placement, not just a
    manual-settings convention -- the earlier "single order test" had nothing in code actually
    limiting it to one order.
  - `lighter_lit_grid_live_orders.client_order_index` now has a real unique constraint
    (migration) as defense-in-depth against the timestamp-derived id colliding.

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
BALANCE_RECONCILE_EVERY = 60.0
BALANCE_DIVERGENCE_TOLERANCE_LIT = 0.03
# Exchange statuses containing any of these substrings are terminal regardless of remaining
# quantity (covers canceled-post-only, canceled-expired, canceled-invalid-balance, etc. without
# needing the exact enum -- external audit finding, 2026-10-18).
TERMINAL_STATUS_SUBSTRINGS = ("cancel", "reject", "expir")


def round_price(price):
    return round(price, PRICE_DECIMALS)


def round_size(qty):
    return round(qty, SIZE_DECIMALS)


def clamp_order_size(qty):
    """Rounds to the exchange's real size precision and enforces its real minimum. Returns None
    (never a too-small order) if the result would round below MIN_BASE_AMOUNT."""
    sized = round_size(qty)
    if sized < MIN_BASE_AMOUNT:
        return None
    return sized


def price_to_int(price):
    return int(round(price * (10 ** PRICE_DECIMALS)))


def size_to_int(qty):
    return int(round(qty * (10 ** SIZE_DECIMALS)))


def _order_fill_amounts(order):
    """Lighter's read-side order fields are already human-scaled decimal strings (confirmed
    2026-10-18 against the SDK's own read-schema docs: filled_base_amount example "68.0066") --
    NOT raw integers needing division by 10**decimals the way request-side fields do. Returns
    (filled_qty, filled_price) or (0.0, None) if nothing has filled yet."""
    filled_base = float(getattr(order, "filled_base_amount", 0) or 0)
    filled_quote = float(getattr(order, "filled_quote_amount", 0) or 0)
    if filled_base <= 0:
        return 0.0, None
    return filled_base, filled_quote / filled_base


def _order_is_terminal(order):
    """True once an order can never receive another fill -- primarily decided by
    remaining_base_amount hitting zero (works regardless of the exact status vocabulary), with a
    substring fallback on status for a cancel/reject/expiry reported with nonzero remaining."""
    remaining = getattr(order, "remaining_base_amount", None)
    if remaining is not None and float(remaining) <= 0:
        return True
    status = str(getattr(order, "status", "") or "").lower()
    return any(p in status for p in TERMINAL_STATUS_SUBSTRINGS)


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class LiveSnapshot:
    """In-tick mutable view of what's resting, built once per maintain_window() call and updated
    as THAT SAME tick places/cancels orders -- fixes a same-tick buy+sell-at-the-same-price race
    (external audit finding, 2026-10-18) that a re-query-per-pass design can't avoid, since two
    passes reading the same stale pre-tick snapshot have no way to see what the OTHER pass just
    did. Buy and sell occupancy are tracked as two separate sets (also an audit finding: a shared
    "is anything resting here" set keyed only by level wrongly let one side block the other)."""
    def __init__(self, resting_by_level):
        self.rows_by_level = resting_by_level
        self.buy_levels = {lvl for lvl, rows in resting_by_level.items()
                            if any(r["side"] == "buy" for r in rows)}
        self.sell_levels = {lvl for lvl, rows in resting_by_level.items()
                             if any(r["side"] == "sell" for r in rows)}


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
        If the send itself raises/times out, the row stays 'pending' -- reconcile_pending_orders()
        checks the exchange for the real answer on the next pass. Returns the ledger row id, or
        None if the exchange explicitly rejected it."""
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
                await self._touch_lock_heartbeat()
                return None
        except Exception as e:
            await self.log_run("order_place_unknown", {"row_id": row_id, "error": str(e)[:200]})
            await self._touch_lock_heartbeat()
            return row_id  # left 'pending' on purpose -- reconciliation resolves it for real
        await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row_id}", {"status": "open"})
        await self._touch_lock_heartbeat()
        return row_id

    async def cancel_order_row(self, row):
        """Cancels one specific resting order by its real exchange order_index. Returns True only
        on a confirmed, error-free cancel -- callers (flatten_all) must not assume success just
        because no exception was raised; the SDK's own returned error is checked too."""
        order_index = row.get("exchange_order_id")
        if order_index is None:
            # No real order_index on file -- can't cancel something we can't identify. The
            # caller should reconcile first so a 'pending' row gets a chance to resolve.
            return False
        try:
            _tx, _resp, err = await asyncio.wait_for(
                self.client.cancel_order(market_index=MARKET_ID, order_index=int(order_index)),
                timeout=ORDER_TIMEOUT,
            )
            if err:
                await self.log_run("cancel_order_failed", {"row_id": row["id"], "error": str(err)[:200]})
                await self._touch_lock_heartbeat()
                return False
        except Exception as e:
            await self.log_run("cancel_order_failed", {"row_id": row["id"], "error": str(e)[:200]})
            await self._touch_lock_heartbeat()
            return False
        await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row['id']}",
                       {"status": "cancelled", "filled_at": now_iso()})
        await self._touch_lock_heartbeat()
        return True

    async def cancel_all_resting(self):
        """Cancels every pending/open ledger row -- used on a spacing change (a clean slate
        before the next tick places anything fresh) and available for flatten_all."""
        resting = await self.resting_orders_by_level()
        for rows in resting.values():
            for r in rows:
                await self.cancel_order_row(r)

    async def reconcile_pending_orders(self):
        """Runs before every tick's new decisions -- checks every non-terminal ledger row against
        the exchange's own account_orders() (by OUR OWN client_order_index, up to 20 at a time).
        Returns True only if every batch was successfully read; callers must treat False as "the
        current state can't be trusted this tick" and skip new decisions (external audit fix,
        2026-10-18 -- a read failure used to be silently swallowed and trading continued anyway).

        Partial fills (external audit fix): status only becomes a terminal 'filled'/'cancelled'
        once the order itself is genuinely done (_order_is_terminal) -- a fill with quantity
        still outstanding stays 'open' so the NEXT pass keeps checking it, instead of being
        marked terminal on the first positive fill and never looked at again."""
        pending = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=in.(pending,open)&select=*&order=id.asc")
        if not pending:
            return True
        auth = self._get_auth_token()
        all_ok = True
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
                all_ok = False
                continue
            by_co = {int(o.client_order_index): o for o in (resp.orders or [])}
            for r in batch:
                o = by_co.get(r["client_order_index"])
                if o is None:
                    continue  # still genuinely unknown -- leave pending, retry next pass
                filled_qty, filled_price = _order_fill_amounts(o)
                terminal = _order_is_terminal(o)
                status_raw = str(getattr(o, "status", "") or "").lower()
                patch = {"exchange_order_id": o.order_index}
                if filled_qty > 0:
                    patch["filled_qty"] = filled_qty
                    patch["filled_price"] = filled_price
                if terminal:
                    patch["status"] = "filled" if filled_qty > 0 else (
                        "cancelled" if any(p in status_raw for p in TERMINAL_STATUS_SUBSTRINGS) else "rejected")
                    if filled_qty > 0:
                        patch["filled_at"] = now_iso()
                else:
                    patch["status"] = "open"
                await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{r['id']}", patch)
                await self.log_run("reconciled_order", {
                    "row_id": r["id"], "raw_status": status_raw, "terminal": terminal,
                    "raw_filled_base": getattr(o, "filled_base_amount", None),
                    "raw_filled_quote": getattr(o, "filled_quote_amount", None),
                    "raw_remaining": getattr(o, "remaining_base_amount", None),
                    "computed_filled_qty": filled_qty, "computed_filled_price": filled_price,
                })
        return all_ok

    async def real_balances(self):
        """Ground truth, straight from the exchange -- never the ledger, never a cached value.
        Returns (usdc, lit).

        Confirmed live 2026-10-18 (real account, margin_mode="enabled"): an asset's plain
        `balance` field reads 0.000000 even when real funds are present -- the actual usable
        amount sits in `margin_balance` (account-level `collateral` reads the same number).
        margin_balance is therefore the PRIMARY source per asset here, not a fallback-when-zero
        guess; `balance + locked_balance` (the non-margin, pure-spot shape) is the fallback, used
        only if an asset carries no margin_balance at all."""
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
            margin = getattr(asset, "margin_balance", None)
            if margin is not None:
                try:
                    total = float(margin)
                except (TypeError, ValueError):
                    total = float(asset.balance or 0) + float(asset.locked_balance or 0)
            else:
                total = float(asset.balance or 0) + float(asset.locked_balance or 0)
            if symbol == "LIT":
                lit = total
            elif symbol == "USDC":
                usdc = total
        return usdc, lit

    async def check_balance_divergence(self):
        """Periodic (a real REST call) -- sums ledger-derived holdings and compares against the
        real exchange LIT balance. A mismatch beyond tolerance, OR an inability to even check,
        pauses new order placement (external audit fix, 2026-10-18: this used to fail OPEN --
        an unverifiable balance, including on the very first-ever call, defaulted to "safe to
        trade" instead of blocking until a real read actually succeeds)."""
        now = time.time()
        if now - self._last_balance_check < BALANCE_RECONCILE_EVERY:
            return not self._balance_paused
        try:
            holdings = await self.current_holdings()
            real_usdc, real_lit = await self.real_balances()
        except Exception as e:
            await self.log_run("balance_check_failed", {"error": str(e)[:200]})
            self._balance_paused = True
            return False
        self._last_balance_check = now  # only consumed on a call that actually succeeded
        await self.update_state({"usdc_balance": real_usdc, "lit_balance": real_lit})
        ledger_lit = sum(h["qty"] for h in holdings.values())
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

    async def _touch_lock_heartbeat(self):
        """Refreshes the heartbeat without re-running the full acquire logic -- called after
        every individual order placement/cancellation (external audit fix, 2026-10-18): a tick
        placing several real orders, each with up to ORDER_TIMEOUT=12s, could previously run
        past LOCK_STALE_AFTER=30s with a stale heartbeat, letting a second instance believe the
        first was dead and steal the lock mid-flight."""
        if not self._lock_held:
            return
        try:
            await self.sb("PATCH", f"{TABLE_STATE}?id=eq.1&lock_owner=eq.{self._lock_id}",
                           {"lock_heartbeat": now_iso()})
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
        """Reconstructs {stored_level: {qty, cost}} purely from the ledger's filled rows, pairing
        each level's buys to its sells FIFO (external audit fix, 2026-10-18): a flat "this level
        was ever sold" set used to erase ALL inventory at a level the instant even one sell ever
        happened there, including a brand new cycle's buy long after. Any buys beyond the matched
        count at a level are open and aggregated (summed qty, weighted-avg cost) as defense in
        depth against more than one open lot at a level, which shouldn't happen by construction
        but must never silently lose quantity if it does."""
        buys = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=eq.filled&side=eq.buy&select=id,level,filled_qty,filled_price&order=id.asc")
        sells = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=eq.filled&side=eq.sell&select=id,level&order=id.asc")
        buys_by_level = {}
        for b in (buys or []):
            buys_by_level.setdefault(b["level"], []).append(b)
        sell_count_by_buy_level = {}
        for s in (sells or []):
            buy_level = s["level"] - 1
            sell_count_by_buy_level[buy_level] = sell_count_by_buy_level.get(buy_level, 0) + 1
        holdings = {}
        for lvl, blist in buys_by_level.items():
            closed = sell_count_by_buy_level.get(lvl, 0)
            open_buys = blist[closed:]  # FIFO: the earliest `closed` buys at this level are matched
            if not open_buys:
                continue
            total_qty = sum(float(b["filled_qty"] or 0) for b in open_buys)
            if total_qty <= 0:
                continue
            total_cost = sum(float(b["filled_qty"] or 0) * float(b["filled_price"] or 0) for b in open_buys)
            holdings[lvl] = {"qty": total_qty, "cost": total_cost / total_qty}
        return holdings

    async def resting_orders_by_level(self):
        rows = await self.sb("GET", f"{TABLE_ORDERS}?status=in.(pending,open)&select=*")
        by_level = {}
        for r in (rows or []):
            by_level.setdefault(r["level"], []).append(r)
        return by_level

    async def maintain_window(self, state, price, entries_allowed=True):
        """Each tick: make sure the resting orders match what they should be. Sells (closing real
        inventory) are placed before buys and always win a same-level conflict (external audit
        fix, 2026-10-18); entries_allowed=False (disabled, or balance-paused) still lets existing
        inventory get its sell placed/maintained, it just skips opening anything new -- same
        "pause gates entries only, never exits" principle used everywhere else in this codebase."""
        spacing_pct = float(state["spacing_pct"])
        step = math.log(1 + spacing_pct / 100.0)
        levels_down = max(1, int(state["levels_down"]))
        cur_lvl = level_of(price, step)
        max_open_buys = state.get("max_open_buys")
        max_open_buys = int(max_open_buys) if max_open_buys is not None else None

        order_size_lit = state.get("order_size_lit")
        if order_size_lit is None:
            down_sizing_levels = levels_for_drawdown(spacing_pct, float(state.get("drawdown_pct") or 10.0))
            order_size_lit = compute_order_size_lit(
                float(state["capital_usd"]), price, spacing_pct, down_sizing_levels)
            await self.update_state({"order_size_lit": order_size_lit})
        order_size = clamp_order_size(float(order_size_lit or 0.0))

        holdings = await self.current_holdings()
        resting = await self.resting_orders_by_level()
        snap = LiveSnapshot(resting)

        # Cancel resting buys that drifted outside the active window.
        for lvl, rows in list(resting.items()):
            for r in rows:
                if r["side"] == "buy" and (lvl > cur_lvl - 1 or lvl < cur_lvl - levels_down):
                    if await self.cancel_order_row(r):
                        snap.buy_levels.discard(lvl)

        # Place sells FIRST -- closing real inventory always wins a same-level conflict over
        # opening a new position. Sell target comes from the lot's REAL cost under the CURRENT
        # step (external audit fix, 2026-10-18), not its stored placement-time level, which could
        # be stale after a spacing change.
        for lvl, h in holdings.items():
            sell_target_lvl = level_of(h["cost"], step) + 1
            if sell_target_lvl in snap.sell_levels:
                continue
            sell_size = clamp_order_size(h["qty"])
            if sell_size is None:
                continue
            limit_price = round_price(math.exp(sell_target_lvl * step))
            await self.place_grid_order(sell_target_lvl, "sell", limit_price, sell_size)
            snap.sell_levels.add(sell_target_lvl)

        # Place buys for empty levels in the active down-window -- real affordability (updated by
        # check_balance_divergence) caps actual spend regardless of how the window is configured
        # (external audit fix, 2026-10-18), and max_open_buys is a code-enforced count cap, not
        # just a settings convention.
        if entries_allowed and order_size is not None:
            available_usdc = float(state.get("usdc_balance") or 0)
            open_buy_count = len(snap.buy_levels) + len(holdings)
            for lvl in range(cur_lvl - 1, cur_lvl - 1 - levels_down, -1):
                if lvl in snap.buy_levels or lvl in snap.sell_levels or lvl in holdings:
                    continue
                if max_open_buys is not None and open_buy_count >= max_open_buys:
                    break
                limit_price = round_price(math.exp(lvl * step))
                cost = limit_price * order_size
                if cost > available_usdc:
                    break  # real cash exhausted -- defer the rest, never overspend
                await self.place_grid_order(lvl, "buy", limit_price, order_size)
                snap.buy_levels.add(lvl)
                available_usdc -= cost
                open_buy_count += 1

    async def market_sell_all(self, qty):
        """A real MARKET order (not a resting limit) -- used ONLY by flatten_all. The pinned SDK
        implements this as immediate-or-cancel, not a guaranteed full fill -- flatten_all checks
        the real post-sell balance rather than trusting this call's own success as proof."""
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
        """Emergency path, retried every tick until VERIFIED complete (external audit fix,
        2026-10-18): reconciles pending orders first (so a just-placed order has a real
        exchange_order_id to cancel), checks every cancel's and the market sell's actual result,
        then re-reads the REAL exchange LIT balance -- never clears flatten_requested or disables
        on anything less than a confirmed-flat real balance with nothing left resting."""
        await self.reconcile_pending_orders()
        resting = await self.resting_orders_by_level()
        any_cancel_failed = False
        for rows in resting.values():
            for r in rows:
                if not await self.cancel_order_row(r):
                    any_cancel_failed = True

        holdings = await self.current_holdings()
        total_lit_ledger = sum(h["qty"] for h in holdings.values())
        sell_failed = False
        if total_lit_ledger > 0:
            row_id = await self.market_sell_all(total_lit_ledger)
            if row_id is None:
                sell_failed = True
            else:
                # Resolve the market sell's own real outcome before checking "still resting" --
                # it was just inserted as 'open' and would otherwise count as unresolved exposure
                # even on a real exchange where an IOC market order settles near-instantly.
                await self.reconcile_pending_orders()

        try:
            _usdc, real_lit = await self.real_balances()
        except Exception as e:
            await self.log_run("flatten_balance_check_failed", {"error": str(e)[:200]})
            return  # try again next tick

        still_resting = await self.resting_orders_by_level()
        if any_cancel_failed or sell_failed or real_lit > BALANCE_DIVERGENCE_TOLERANCE_LIT or still_resting:
            await self.log_run("flatten_incomplete", {
                "any_cancel_failed": any_cancel_failed, "sell_failed": sell_failed,
                "real_lit_remaining": real_lit, "still_resting_levels": list(still_resting.keys()),
            })
            return  # leave flatten_requested=true, retry next tick

        await self.update_state({"flatten_requested": False, "enabled": False})
        await self.log_run("flatten_completed", {"final_real_lit": real_lit})

    async def tick(self):
        state = await self.get_state()
        if state.get("flatten_requested"):
            await self.flatten_all()
            return
        reconciled_ok = await self.reconcile_pending_orders()
        if not reconciled_ok:
            return  # can't trust current order state this tick -- skip new decisions
        balance_ok = await self.check_balance_divergence()
        price = await self.fetch_current_price()
        if price is None:
            return
        entries_allowed = bool(state.get("enabled")) and balance_ok

        spacing_pct = float(state["spacing_pct"])
        persisted_spacing = state.get("internal_spacing_pct")
        if persisted_spacing is not None and float(persisted_spacing) != spacing_pct:
            await self.cancel_all_resting()
            await self.update_state({"internal_spacing_pct": spacing_pct, "order_size_lit": None})
            await self.log_run("spacing_changed_rearmed",
                                {"old": persisted_spacing, "new": spacing_pct})
            return  # let the next tick place fresh orders under the new spacing
        if persisted_spacing is None:
            await self.update_state({"internal_spacing_pct": spacing_pct})

        await self.maintain_window(state, price, entries_allowed=entries_allowed)
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
