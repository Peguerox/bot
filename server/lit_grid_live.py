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
event.

THIRD-PASS REWRITE (2026-10-18), after a second independent audit found the previous round's
sell-target fix had a real, high-frequency bug, plus several deeper issues in how inventory was
tracked. All confirmed against this code (the rounding bug independently reproduced with plain
arithmetic) before rewriting:

  - ROOT CAUSE of the worst finding: a held lot's sell target used to be computed as
    `level_of(real_cost, step) + 1` every tick. But every fill price is `exp(level * step)` --
    EXACTLY the lower boundary of its own bin, by construction. Rounding that to 4 decimals (the
    exchange's real precision) has roughly 50% odds of landing just BELOW the boundary, which
    floor()'s math then classifies as the PREVIOUS bin -- not rare, close to a coin flip on every
    single fill (reproduced directly: exp(905*step) rounds to a price whose own level_of() comes
    back 904, not 905). The sell would then target the SAME price as the buy, or the wrong level
    entirely, and -- because the old pairing logic (current_holdings) inferred "which buy does
    this sell close" purely from `sell.level - 1` -- a pairing drawn from the WRONG recomputed
    level broke inventory tracking too (a sold lot could still show as held, or an unrelated lot
    could appear sold).
  - THE FIX: sells no longer infer their target level by recomputing anything from a price.
    place_grid_order() now takes an explicit `closes_level` for a sell -- set directly from the
    real buy's own stored level at the moment the sell is decided, never recomputed later. The
    sell's own resting price is computed directly as `cost * (1 + spacing_pct/100)` (one real
    step above the real cost, no floor() involved at all). current_holdings() now walks each
    level's buy/sell events in chronological (id) order as a running balance -- quantity-aware
    (a partial sell correctly reduces remaining qty and cost proportionally, not "count one order
    closed, drop one whole buy row"), and pairs by `closes_level` (explicit) rather than
    `sell.level - 1` (inferred, and exactly what the rounding bug broke).
  - Cancel acknowledgment is not final confirmation (a request can race a fill on the exchange).
    cancel_order_row() now marks a successful cancel send as 'cancel_requested', an intermediate
    status -- reconcile_pending_orders() (which already polls pending/open/cancel_requested rows)
    resolves it to the REAL terminal outcome next pass (filled, filled-despite-the-cancel-attempt,
    or genuinely cancelled), never assumed from the send alone.
  - Flatten no longer places one lump-sum market sell at a fake level=-1 (which broke the
    level-based ledger entirely, pairing against a buy level that never existed). It now places
    one real market sell PER HELD LEVEL, each with the correct closes_level, so the ledger's
    accounting stays correct through a flatten too.
  - tick() used to read `state` once, then check_balance_divergence() wrote a FRESH usdc_balance
    to the database without updating that same local `state` object -- maintain_window() received
    the OLD (pre-check) cash figure. tick() now re-fetches state after a successful balance check.
  - The real spending cap now accounts for USDC already committed to this bot's own resting buy
    orders (not just the real account balance, which could overstate what's actually free), AND
    is capped at the user's configured capital_usd minus whatever's already deployed in holdings
    + resting buys -- not just whatever real cash happens to be sitting in the account (which
    could be far more than the user intended this strategy to use).
  - max_open_buys is now a REAL one-shot/lifetime cap (`lifetime_buy_count`, persisted, survives
    restarts), not a concurrent snapshot (open resting buys + held levels) that silently resets
    the moment one full buy-sell cycle completes -- the old version did not actually limit
    anything to "one order total" the way it was described.
  - A spacing change's cancel-all is no longer assumed to succeed -- internal_spacing_pct only
    advances (completing the "migration" to the new spacing) once every resting order is
    confirmed cancelled; a failure retries the next tick instead of silently moving on while an
    old order is still live.
  - Placing a sell now cancels any conflicting resting BUY at that exact target level FIRST --
    the sell (closing real inventory) always wins, enforced, not just a same-tick ordering
    assumption.

Nothing in this codebase has placed a real LIMIT order before this (stoch_bot_core.py's
place_order only ever sends MARKET orders; native SL/TP are the only conditional orders that
exist). The Lighter SDK (lighter.SignerClient.create_order) supports real ORDER_TYPE_LIMIT with
ORDER_TIME_IN_FORCE_POST_ONLY -- used here specifically because Lighter's maker fee on this pair
is confirmed 0%, so POST_ONLY guarantees every fill is a maker fill.

Precision (confirmed live against Lighter's own orderBooks endpoint for market 2049): price to 4
decimals, size to 2 decimals, hard minimum 1.00 LIT per order -- no dynamic market-metadata fetch
exists anywhere in this codebase (every bot hardcodes decimals per market, same convention here).
clamp_order_size() refuses (returns None) rather than ever place an undersized order.

Real balance: this account has margin_mode="enabled" -- a per-asset `balance` field reads
0.000000 even with real funds present; the actual usable amount sits in `margin_balance`
(confirmed live, account-level `collateral` reads the same number). margin_balance is the
PRIMARY source per asset here, falling back to balance+locked_balance only for an asset with no
margin_balance at all. NOTE (still unverified, flagged honestly): this was confirmed only for
USDC on this account -- a real LIT asset entry doesn't exist yet (zero held), so whether it
follows the same shape is unconfirmed until the bot actually holds some.

Starts disabled, max_open_buys defaults to 1. Nothing here ever places a real order until
enabled=true is set from the dashboard -- explicitly the user's call.
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
# Non-terminal statuses this bot still needs to poll (an in-flight cancel request is one of
# them now -- its real outcome isn't known until reconciliation confirms it).
OPEN_STATUSES = ("pending", "open", "cancel_requested")
TERMINAL_STATUS_SUBSTRINGS = ("cancel", "reject", "expir")


def round_price(price):
    return round(price, PRICE_DECIMALS)


def round_size(qty):
    return round(qty, SIZE_DECIMALS)


def clamp_order_size(qty):
    sized = round_size(qty)
    if sized < MIN_BASE_AMOUNT:
        return None
    return sized


def price_to_int(price):
    return int(round(price * (10 ** PRICE_DECIMALS)))


def size_to_int(qty):
    return int(round(qty * (10 ** SIZE_DECIMALS)))


def _order_fill_amounts(order):
    filled_base = float(getattr(order, "filled_base_amount", 0) or 0)
    filled_quote = float(getattr(order, "filled_quote_amount", 0) or 0)
    if filled_base <= 0:
        return 0.0, None
    return filled_base, filled_quote / filled_base


def _order_is_terminal(order):
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
    """In-tick mutable view of what's resting. buy_levels is keyed by a resting buy's own
    `level`. sell_closes is keyed by a resting sell's `closes_level` (explicit -- NOT its own
    display level, which is cosmetic only and never load-bearing for pairing/placement logic)."""
    def __init__(self, resting_by_level):
        self.rows_by_level = resting_by_level
        self.buy_levels = {lvl for lvl, rows in resting_by_level.items()
                            if any(r["side"] == "buy" for r in rows)}
        self.sell_closes = set()
        for rows in resting_by_level.values():
            for r in rows:
                if r["side"] == "sell" and r.get("closes_level") is not None:
                    self.sell_closes.add(r["closes_level"])


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

    # ── Supabase ─────────────────────────────────────────────────────────────────────────────
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

    # ── Order ledger ─────────────────────────────────────────────────────────────────────────
    async def place_grid_order(self, level, side, limit_price, size, closes_level=None):
        """Writes the ledger row FIRST, status='pending'. `closes_level` (sells only) is the
        REAL buy level this sell is intended to close -- set explicitly here, never recomputed
        later from a price (that recomputation is exactly what broke pairing before)."""
        co_idx = int(time.time() * 1000) % 500_000_000
        row = {
            "level": level, "side": side, "client_order_index": co_idx,
            "status": "pending", "limit_price": limit_price, "size": size,
            "placed_at": now_iso(), "closes_level": closes_level,
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
            return row_id
        await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row_id}", {"status": "open"})
        await self._touch_lock_heartbeat()
        return row_id

    async def cancel_order_row(self, row):
        """Submits a cancel. A clean SDK ack is NOT final confirmation (a fill can race the
        cancel on the exchange) -- marks 'cancel_requested' (an intermediate, still-polled
        status), never 'cancelled' directly. reconcile_pending_orders() resolves the REAL
        outcome next pass. Returns True only if the cancel request itself was sent cleanly."""
        order_index = row.get("exchange_order_id")
        if order_index is None:
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
        await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row['id']}", {"status": "cancel_requested"})
        await self._touch_lock_heartbeat()
        return True

    async def cancel_all_resting(self):
        """Returns True only if every resting order's cancel was sent cleanly."""
        resting = await self.resting_orders_by_level()
        all_ok = True
        for rows in resting.values():
            for r in rows:
                if not await self.cancel_order_row(r):
                    all_ok = False
        return all_ok

    async def reconcile_pending_orders(self):
        """Checks every non-terminal ledger row (pending/open/cancel_requested) against the
        exchange's own account_orders(). Returns True only if every batch was successfully read."""
        pending = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=in.({','.join(OPEN_STATUSES)})&select=*&order=id.asc")
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
                    continue
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
                    # Still genuinely live -- including a cancel_requested row the exchange
                    # hasn't resolved yet. Keep polling it, don't assume the cancel "worked".
                    patch["status"] = "open"
                await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{r['id']}", patch)
                await self.log_run("reconciled_order", {
                    "row_id": r["id"], "raw_status": status_raw, "terminal": terminal,
                    "computed_filled_qty": filled_qty, "computed_filled_price": filled_price,
                })
        return all_ok

    async def real_balances(self):
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
        self._last_balance_check = now
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

    # ── Auth ─────────────────────────────────────────────────────────────────────────────────
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

    # ── Single-instance lock ─────────────────────────────────────────────────────────────────
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
        if not self._lock_held:
            return
        try:
            await self.sb("PATCH", f"{TABLE_STATE}?id=eq.1&lock_owner=eq.{self._lock_id}",
                           {"lock_heartbeat": now_iso()})
        except Exception:
            pass

    # ── Live price ───────────────────────────────────────────────────────────────────────────
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

    # ── Holdings: quantity-aware running balance per level, paired by explicit closes_level ───
    async def current_holdings(self):
        """Walks each level's buy/sell fills in chronological (id) order as a running balance --
        quantity-aware (a partial sell reduces remaining qty/cost proportionally, never "count
        one order, drop one whole buy row") and paired via the sell's explicit `closes_level`,
        never inferred from a (possibly-rounded) price. Returns {level: {qty, cost}} for
        whatever's still open."""
        buys = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=eq.filled&side=eq.buy&select=id,level,filled_qty,filled_price&order=id.asc")
        sells = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=eq.filled&side=eq.sell&select=id,closes_level,filled_qty&order=id.asc")
        events_by_level = {}
        for b in (buys or []):
            events_by_level.setdefault(b["level"], []).append(
                ("buy", b["id"], float(b["filled_qty"] or 0), float(b["filled_price"] or 0)))
        for s in (sells or []):
            lvl = s.get("closes_level")
            if lvl is None:
                continue  # legacy/flatten rows with no explicit link -- never guessed at
            events_by_level.setdefault(lvl, []).append(
                ("sell", s["id"], float(s["filled_qty"] or 0), None))
        holdings = {}
        for lvl, events in events_by_level.items():
            events.sort(key=lambda e: e[1])
            qty = 0.0
            cost_total = 0.0
            for kind, _id, ev_qty, ev_price in events:
                if kind == "buy":
                    cost_total += ev_qty * ev_price
                    qty += ev_qty
                else:
                    if qty > 1e-12:
                        avg = cost_total / qty
                        take = min(ev_qty, qty)
                        cost_total -= take * avg
                        qty -= take
            if qty > 1e-9:
                holdings[lvl] = {"qty": qty, "cost": cost_total / qty}
        return holdings

    async def resting_orders_by_level(self):
        rows = await self.sb(
            "GET", f"{TABLE_ORDERS}?status=in.({','.join(OPEN_STATUSES)})&select=*")
        by_level = {}
        for r in (rows or []):
            by_level.setdefault(r["level"], []).append(r)
        return by_level

    async def maintain_window(self, state, price, entries_allowed=True):
        spacing_pct = float(state["spacing_pct"])
        step = math.log(1 + spacing_pct / 100.0)
        levels_down = max(1, int(state["levels_down"]))
        cur_lvl = level_of(price, step)
        max_open_buys = state.get("max_open_buys")
        max_open_buys = int(max_open_buys) if max_open_buys is not None else None
        lifetime_buy_count = int(state.get("lifetime_buy_count") or 0)

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

        # Place sells FIRST, keyed by the REAL buy level (closes_level), never a recomputed
        # price-bin. Cancel any conflicting resting BUY at the sell's own target price first --
        # the sell always wins a same-price conflict, enforced, not assumed.
        for lvl, h in holdings.items():
            if lvl in snap.sell_closes:
                continue
            sell_price = round_price(h["cost"] * (1 + spacing_pct / 100.0))
            sell_display_lvl = level_of(sell_price, step)  # cosmetic only, never load-bearing
            for r in list(snap.rows_by_level.get(sell_display_lvl, [])):
                if r["side"] == "buy":
                    if await self.cancel_order_row(r):
                        snap.buy_levels.discard(sell_display_lvl)
            sell_size = clamp_order_size(h["qty"])
            if sell_size is None:
                continue
            await self.place_grid_order(sell_display_lvl, "sell", sell_price, sell_size, closes_level=lvl)
            snap.sell_closes.add(lvl)

        # Place buys for empty levels in the active down-window. Real affordability caps actual
        # spend at the SMALLER of (a) real cash not already committed to this bot's own resting
        # buys, and (b) capital_usd minus whatever's already deployed in holdings + resting buys
        # -- not just whatever real cash happens to sit in the account. max_open_buys is now a
        # persistent, restart-surviving LIFETIME cap (lifetime_buy_count), not a concurrent
        # snapshot that resets the moment one cycle completes.
        if entries_allowed and order_size is not None:
            resting_buy_cost = sum(
                float(r["limit_price"]) * float(r["size"])
                for rows in resting.values() for r in rows if r["side"] == "buy"
            )
            real_usdc = float(state.get("usdc_balance") or 0)
            holdings_cost = sum(h["qty"] * h["cost"] for h in holdings.values())
            capital_committed = holdings_cost + resting_buy_cost
            capital_remaining = max(0.0, float(state["capital_usd"]) - capital_committed)
            available_usdc = min(real_usdc - resting_buy_cost, capital_remaining)

            for lvl in range(cur_lvl - 1, cur_lvl - 1 - levels_down, -1):
                if lvl in snap.buy_levels or lvl in snap.sell_closes or lvl in holdings:
                    continue
                if max_open_buys is not None and lifetime_buy_count >= max_open_buys:
                    break
                limit_price = round_price(math.exp(lvl * step))
                cost = limit_price * order_size
                if cost > available_usdc:
                    break
                await self.place_grid_order(lvl, "buy", limit_price, order_size)
                snap.buy_levels.add(lvl)
                available_usdc -= cost
                lifetime_buy_count += 1
                await self.update_state({"lifetime_buy_count": lifetime_buy_count})

    async def market_sell_level(self, level, qty):
        """Real MARKET sell closing ONE specific held level's lot -- flatten calls this once per
        held level (never one lump-sum sell) so the ledger's closes_level accounting stays
        correct through a flatten too. IOC per the SDK, not a guaranteed full fill -- flatten_all
        checks the real post-sell balance rather than trusting this call's own send as proof."""
        sized = clamp_order_size(qty)
        if sized is None:
            return None
        price = self.live.best_mid()
        if price is None:
            return None
        band_price = round_price(price * 0.995)
        co_idx = int(time.time() * 1000) % 500_000_000
        row = {"level": level, "side": "sell", "closes_level": level, "client_order_index": co_idx,
               "status": "pending", "limit_price": band_price, "size": sized, "placed_at": now_iso()}
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
        """Emergency path, retried every tick until VERIFIED complete: reconciles first, cancels
        every resting order, sells each held level separately (correct ledger accounting), then
        re-reads the REAL exchange LIT balance -- never clears flatten_requested or disables on
        anything less than a confirmed-flat real balance with nothing left resting."""
        await self.reconcile_pending_orders()
        resting = await self.resting_orders_by_level()
        any_cancel_failed = False
        for rows in resting.values():
            for r in rows:
                if not await self.cancel_order_row(r):
                    any_cancel_failed = True
        if resting:
            await self.reconcile_pending_orders()  # resolve the cancel_requested rows for real

        holdings = await self.current_holdings()
        sell_failed = False
        for lvl, h in holdings.items():
            row_id = await self.market_sell_level(lvl, h["qty"])
            if row_id is None:
                sell_failed = True
        if holdings:
            await self.reconcile_pending_orders()  # resolve the market sells' real outcomes

        try:
            _usdc, real_lit = await self.real_balances()
        except Exception as e:
            await self.log_run("flatten_balance_check_failed", {"error": str(e)[:200]})
            return

        still_resting = await self.resting_orders_by_level()
        if any_cancel_failed or sell_failed or real_lit > BALANCE_DIVERGENCE_TOLERANCE_LIT or still_resting:
            await self.log_run("flatten_incomplete", {
                "any_cancel_failed": any_cancel_failed, "sell_failed": sell_failed,
                "real_lit_remaining": real_lit, "still_resting_levels": list(still_resting.keys()),
            })
            return

        await self.update_state({"flatten_requested": False, "enabled": False})
        await self.log_run("flatten_completed", {"final_real_lit": real_lit})

    async def tick(self):
        state = await self.get_state()
        if state.get("flatten_requested"):
            await self.flatten_all()
            return
        reconciled_ok = await self.reconcile_pending_orders()
        if not reconciled_ok:
            return
        balance_ok = await self.check_balance_divergence()
        price = await self.fetch_current_price()
        if price is None:
            return
        if balance_ok:
            # Re-fetch: check_balance_divergence() just wrote a FRESH usdc_balance/lit_balance
            # to the database -- the `state` object read at the top of this tick is now stale
            # (external audit fix: maintain_window used to receive the pre-check cash figure).
            state = await self.get_state()
        entries_allowed = bool(state.get("enabled")) and balance_ok

        spacing_pct = float(state["spacing_pct"])
        persisted_spacing = state.get("internal_spacing_pct")
        if persisted_spacing is not None and float(persisted_spacing) != spacing_pct:
            cancelled_ok = await self.cancel_all_resting()
            if not cancelled_ok:
                await self.log_run("spacing_change_cancel_incomplete",
                                    {"old": persisted_spacing, "new": spacing_pct})
                return  # retry next tick -- don't advance internal_spacing_pct until clean
            await self.update_state({"internal_spacing_pct": spacing_pct, "order_size_lit": None})
            await self.log_run("spacing_changed_rearmed",
                                {"old": persisted_spacing, "new": spacing_pct})
            return
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
