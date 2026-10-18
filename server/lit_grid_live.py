"""
REAL-MONEY LIT/USDC grid bot (2026-10-18, direct request after Worker 4's BTC stochastic clone
had a bad weekend). Places real resting LIMIT orders on Lighter's LIT/USDC spot market
(market_id 2049) and tracks them durably. Reuses the pure grid math already proven in
server/lit_grid_paper.py (level_of, compute_order_size_lit, levels_for_drawdown) and the
websocket price feed (LiveBook) -- only the EXECUTION layer here is new, not the decision math.

THE CORE SAFETY REQUIREMENT (direct user request, stated explicitly before any of this was
built): a durable log of every real order, with a stable ID and the ACTUAL filled price, that
survives a restart -- so the bot never ends up holding LIT with no record of what it cost.

FOURTH-PASS FIXES (2026-10-18), from a third independent audit, each confirmed against this code
before fixing:

  - P1: the one-shot allowance (max_open_buys/lifetime_buy_count) could be exceeded after a
    crash between sending an order and persisting the counter -- those two writes were not
    atomic. The counter is now reserved with a conditional (optimistic-concurrency) PATCH
    BEFORE the order is ever sent, so an ambiguous send is already counted against the
    allowance, and a concurrent/restarted instance can never double-spend the same slot.
  - P1: flatten_all() could place a duplicate market sell for a level whose PREVIOUS flatten
    attempt's sell was still unresolved (not yet terminal) -- current_holdings() only looked at
    status='filled' rows, so an in-flight sell's real (possibly partial) execution was invisible.
    Sells now count toward holdings the moment they have ANY recorded filled_qty, terminal or
    not (buys deliberately still wait for terminal -- a conscious, asymmetric choice: a
    still-resting buy is not yet "ours" to manage, but a sell's execution is real money already
    gone the moment it's recorded). flatten_all() also now refuses to place a new sell for any
    level that still has an unresolved resting sell, reporting incomplete instead.
  - P1: a cancel's SDK ack (`cancel_order_row` returning True) was being treated as "confirmed
    cancelled" by callers -- it only means the request was SENT. The spacing-change gate now
    reconciles and re-checks real resting state before advancing internal_spacing_pct, and the
    sell-vs-buy conflict path cancels the conflicting buy and defers placing the sell to the
    NEXT tick (after reconciliation has a chance to confirm it's actually gone) instead of
    placing it in the same breath as an unconfirmed cancel.
  - P1: current_holdings() queried without pagination, so a long-running bot could eventually
    exceed PostgREST's default row cap and silently lose track of old inventory. Both the buy
    and sell queries now paginate to completion.
  - P1: losing the single-instance lock mid-tick was not detected -- _touch_lock_heartbeat's
    conditional write returning zero rows (another instance now owns it) was silently ignored,
    and the dethroned instance kept believing it still held the lock and kept sending orders.
    It now clears self._lock_held the moment a heartbeat write matches zero rows, and every
    order-placing loop checks it after each action and stops immediately if lost.
  - P2: the real cash figure used for the spending cap could be up to 60s stale (the balance
    refresh interval) even though a buy had JUST been confirmed filled by reconciliation this
    same tick. reconcile_pending_orders() now returns the net USDC delta from whatever it just
    confirmed, and tick() applies that delta to the in-memory cash figure immediately whenever
    the periodic real-balance refresh didn't ALSO run this same tick (avoiding double-counting).
  - P2: the same-price buy/sell conflict check matched by a RECOMPUTED display level, which
    could differ from a resting buy's own real stored level even at the exact same price. It now
    compares real integer price ticks directly, never a recomputed level.
  - P2: a terminal partial fill below the 1.00 LIT minimum had no exit path (clamp_order_size
    refuses it, forever) -- flatten now logs this distinctly (`flatten_dust_stuck`) instead of
    looking like an ordinary unresolved retry, so it's visible as something needing a manual
    decision rather than silently stuck.
  - P2: an order absent from the exchange's own lookup (account_orders has a finite history
    window) used to be silently skipped with no visibility. Now logs a distinct warning once an
    unresolved order has been missing for longer than a generous threshold.
  - P2: the active window recentered from the live price every tick with no hysteresis, so a
    resting buy sitting right at a boundary could get cancelled before ever having a chance to
    fill, wasting a one-shot allowance slot on nothing. The window center now reuses the same
    guard-banded level_of(..., reference=...) already proven in the paper bot, so pure
    boundary noise no longer shifts it.
  - The settings route had no way to actually CLEAR max_open_buys back to "no cap" (continuous
    production mode) -- null/undefined/empty were all treated as "leave unchanged". Submitting
    0 now explicitly means "remove the cap".

FIFTH-PASS FIXES (2026-10-18), from a fourth independent audit, each confirmed against this code
before fixing, plus a new feature (direct request):

  - P1: flatten_all() never checked the lock mid-flight -- its cancel/sell loops had no
    _lock_held guard at all, and market_sell_level() never touched the heartbeat. A dethroned
    worker could keep flattening after a handover, racing the replacement worker over the same
    inventory. Both loops now bail (and log flatten_aborted_lock_lost) the moment the lock is
    lost; the new lock-holder picks the same flatten_requested flag up on its own next tick.
  - P1: the lock heartbeat failed OPEN on a network error (an exception on the PATCH just
    returned, leaving _lock_held True) -- now fails CLOSED, consistent with every other check in
    this file. The heartbeat check also moved from AFTER each real order action to BEFORE it:
    checking after the fact let exactly one action slip through per lock-loss event (e.g. a long
    current_holdings() scan outlasting the lease before the next heartbeat caught it).
  - P2: a same-tick cash correction (see fourth-pass P2-7) only ever lived in a local variable --
    the NEXT tick's get_state() returned the stale pre-fill balance again, since nothing wrote
    the corrected figure back. It's now persisted immediately so it survives into the next tick.
  - P2: reconcile_pending_orders()'s own initial query was still a single unpaginated sb() call
    -- holdings/resting-orders were paginated last round, this exact same query was missed. Now
    uses sb_paginate() like everything else.
  - P2: an order missing from the exchange's own lookup past the stale threshold was logged but
    never gated anything -- new entries kept being placed elsewhere while that uncertainty sat
    unresolved. reconcile_pending_orders() now reports this back and tick() pauses new entries
    (never exits) the same way a real balance divergence already does.

PROFIT ALLOCATION (direct request, 2026-10-18): realized profit (computed the same way the paper
bot already does -- (sell_fill_price - cost_basis_at_time_of_sale) * qty, on every sell fill) is
credited to exactly one of three durable buckets, selected by `profit_mode` (never the bot's own
choice -- user-set only, like every other toggle):

  - 'rest' (default): profit just accumulates in profit_bucket_rest_usd. No effect on trading --
    it's the user's to withdraw from the real exchange account whenever they want.
  - 'cover_drop': profit accumulates in profit_bucket_cover_drop_usd. maintain_window() spends
    from it -- on top of the ordinary capital_usd ceiling, never replacing it -- only once a buy's
    cost would otherwise exceed what's left of the base capital_usd budget, letting the window
    keep buying further down than the original budget alone would allow. Spent dollars are
    deducted from the bucket as they're used.
  - 'compound': profit accumulates in profit_bucket_compound_usd. Folded into the sizing basis
    (capital_usd + this bucket, mirroring the paper bot's compounding_basis = capital_usd +
    bot_profit_usd) the next time order_size_lit is recomputed, producing a bigger order size.
    Unlike cover_drop this is never spent/decremented by that use -- it keeps growing as more
    profit lands in it, same as the paper bot's bot_profit_usd never shrinking from market swings.

Switching `profit_mode` only changes where NEWLY-realized profit gets credited going forward.
Money already sitting in a bucket is never moved to a different bucket on a mode switch -- it
stays earmarked for that bucket's own purpose (cover_drop still gets spent covering a drop,
compound still inflates sizing) regardless of which mode is currently selected; only crediting
new profit is mode-gated, spending an existing balance is not.

SIXTH-PASS FIXES (2026-10-18), from a fifth independent audit, each confirmed against this code
before fixing -- all concentrated in the profit-allocation feature's accounting, plus one
cash-accounting gap that predates it:

  - A cash-delta correction (fifth-pass P2) was only ever persisted AFTER the price check and
    the balance-divergence check -- a missing price, or anything else that returned early,
    silently skipped the write, permanently losing a correction that can never be recomputed
    once its order has already left the reconcilable (OPEN_STATUSES) set. Now persisted
    immediately after reconciliation, before anything that could return early, and fails CLOSED
    (pauses entries) if that persist write itself fails.
  - tick() selectively patched only usdc_balance onto its local state copy instead of re-reading
    fresh -- a profit-bucket credit that reconciliation had JUST written moments earlier was
    invisible to maintain_window()'s spend check later the SAME tick, so a cover_drop-funded buy
    could overwrite (not just fail to see) a same-tick credit. tick() now always re-reads state
    fresh after reconciliation, for every field, not just cash.
  - A rejected buy's cost was charged against cover_drop (and the base budget) exactly the same
    as an accepted one -- place_grid_order()'s return value was never checked. A confirmed
    rejection (a clean `None` return) is no longer charged; an ambiguous send (still returns a
    row id) is still charged, deliberately conservative, same philosophy as the one-shot
    allowance counter.
  - Compounding inflated the SIZING basis (capital_usd + profit_bucket_compound_usd) but the
    SPENDING ceiling only ever used capital_usd (plus cover_drop) -- a bigger order size just
    consumed the old, unexpanded budget sooner instead of the compound bucket actually funding
    more depth. The spending ceiling now folds in the same compound bucket the sizing basis uses.
  - cover_drop money, once spent funding a buy, never came back when that position was later
    sold -- the bucket just kept draining on every reuse even though the real exchange cash had
    already returned. Each buy's ledger row now records exactly how much of its own cost was
    drawn from the bucket (`funded_from_bucket_usd`); current_holdings() tracks a blended
    bucket-funded cost alongside the ordinary cost basis, and a sell now returns that fill's
    share of it to profit_bucket_cover_drop_usd -- on top of, and independent of, whatever
    profit_mode governs the newly-realized profit itself. This makes cover_drop properly
    revolving across repeated drops instead of a one-shot allowance.
  - A sell's profit/principal was credited to its bucket in the SAME pass that marked it
    'filled' -- if that credit write failed, the exception was logged and never retried, since a
    filled row drops out of every future reconcile scan by definition. The credit amount and its
    destination bucket are now recorded on the sell's own row ATOMICALLY with its 'filled'
    status (one PATCH, one SQL statement); a separate, idempotent _flush_uncredited_profit() step
    -- re-run every single tick regardless of whether anything new reconciled -- scans
    specifically for filled sells not yet credited and retries until it durably succeeds, so a
    restart or a transient write failure can no longer lose or duplicate a credit.
  - A multi-price partial fill (e.g. a market sell sweeping through several book levels) computed
    its cash/profit delta as new_qty_increment * overall_average_price -- not the real proceeds
    of just the new increment when per-fill prices differ. Cumulative filled_quote is now
    persisted alongside filled_qty, and every delta is computed from quote-amount deltas
    directly (new_quote - prior_quote), never qty-times-average-price.
  - Crediting the compound bucket now also clears the cached order_size_lit, so new profit
    actually triggers a resize at the very next tick instead of sitting inert until an unrelated
    settings change -- "startup" was never actually a recompute trigger (order_size_lit is
    persisted; a fresh process never clears it), a documentation inaccuracy in the prior
    writeup, corrected here along with the mechanism itself.

Nothing in this codebase has placed a real LIMIT order before this (stoch_bot_core.py's
place_order only ever sends MARKET orders; native SL/TP are the only conditional orders that
exist). The Lighter SDK (lighter.SignerClient.create_order) supports real ORDER_TYPE_LIMIT with
ORDER_TIME_IN_FORCE_POST_ONLY -- used here specifically because Lighter's maker fee on this pair
is confirmed 0%, so POST_ONLY guarantees every fill is a maker fill.

Precision (confirmed live against Lighter's own orderBooks endpoint for market 2049): price to 4
decimals, size to 2 decimals, hard minimum 1.00 LIT per order. clamp_order_size() refuses
(returns None) rather than ever place an undersized order.

Real balance: this account has margin_mode="enabled" -- a per-asset `balance` field reads
0.000000 even with real funds present; the actual usable amount sits in `margin_balance`
(confirmed live). Still unverified for a real LIT asset entry (zero held so far).

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
OPEN_STATUSES = ("pending", "open", "cancel_requested")
TERMINAL_STATUS_SUBSTRINGS = ("cancel", "reject", "expir")
PAGE_SIZE = 500
# How long an order can sit unresolved (absent from the exchange's own lookup) before this is
# logged distinctly rather than silently retried forever (external audit finding -- Lighter's
# account_orders endpoint has a finite history window, so a long enough outage can genuinely
# lose visibility into an order's real fate).
UNRESOLVED_ORDER_STALE_AFTER_S = 3600.0
PROFIT_MODES = ("rest", "cover_drop", "compound")
PROFIT_BUCKET_COLUMN = {
    "rest": "profit_bucket_rest_usd",
    "cover_drop": "profit_bucket_cover_drop_usd",
    "compound": "profit_bucket_compound_usd",
}


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


def _parse_iso(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


class LiveSnapshot:
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
        self._window_center = None  # guard-banded active-window center, external audit fix P2-11
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

    async def sb_paginate(self, path):
        """Fetches ALL rows matching a query, paginating past PostgREST's default row cap
        (external audit fix P1-5: an unpaginated query could silently truncate inventory
        history on a long-running bot)."""
        out = []
        offset = 0
        sep = "&" if "?" in path else "?"
        while True:
            page = await self.sb("GET", f"{path}{sep}limit={PAGE_SIZE}&offset={offset}")
            if not page:
                break
            out.extend(page)
            if len(page) < PAGE_SIZE:
                break
            offset += PAGE_SIZE
        return out

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
        # Lock validated BEFORE anything else (external audit fix, fifth pass): checking AFTER
        # the send let exactly one action slip through per lock-loss event.
        if not await self._touch_lock_heartbeat():
            return None
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
                return None
        except Exception as e:
            await self.log_run("order_place_unknown", {"row_id": row_id, "error": str(e)[:200]})
            return row_id
        await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row_id}", {"status": "open"})
        return row_id

    async def cancel_order_row(self, row):
        """Returns True only if the cancel REQUEST was sent cleanly -- this is NOT confirmation
        the order is actually gone (external audit fix P1-4). Callers must reconcile and check
        real resting state before treating a cancel as done."""
        if not await self._touch_lock_heartbeat():
            return False
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
                return False
        except Exception as e:
            await self.log_run("cancel_order_failed", {"row_id": row["id"], "error": str(e)[:200]})
            return False
        await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row['id']}", {"status": "cancel_requested"})
        return True

    async def cancel_all_resting(self):
        resting = await self.resting_orders_by_level()
        all_ok = True
        for rows in resting.values():
            for r in rows:
                if not self._lock_held:
                    return False
                if not await self.cancel_order_row(r):
                    all_ok = False
        return all_ok

    async def _flush_uncredited_profit(self):
        """Retry-safe profit/principal crediting (external audit fix, sixth pass). A sell's
        realized_profit_usd / bucket_principal_return_usd / profit_bucket_destination are
        recorded on ITS OWN row atomically with status='filled' (same PATCH, same SQL statement)
        -- never in a separate step that could fail independently and get lost, since a filled
        row drops out of every future OPEN_STATUSES scan by definition. This re-scans
        specifically for filled sells not yet credited, independent of status, and retries every
        single call (cheap: usually zero rows) until the credit durably succeeds -- a restart or
        a transient write failure can no longer lose or duplicate one."""
        uncredited = await self.sb_paginate(
            f"{TABLE_ORDERS}?status=eq.filled&side=eq.sell&profit_credited=eq.false"
            f"&realized_profit_usd=not.is.null"
            f"&select=id,realized_profit_usd,bucket_principal_return_usd,profit_bucket_destination")
        if not uncredited:
            return
        by_bucket = {}
        principal_total = 0.0
        all_ids = []
        for r in uncredited:
            dest = r.get("profit_bucket_destination") or "profit_bucket_rest_usd"
            by_bucket[dest] = by_bucket.get(dest, 0.0) + float(r.get("realized_profit_usd") or 0)
            principal_total += float(r.get("bucket_principal_return_usd") or 0)
            all_ids.append(r["id"])
        try:
            state_now = await self.get_state()
            updates = {}
            for dest, amount in by_bucket.items():
                updates[dest] = round(float(state_now.get(dest) or 0) + amount, 8)
                if dest == "profit_bucket_compound_usd":
                    # New compound profit should actually trigger a resize at the next tick,
                    # not sit inert until an unrelated settings change (external audit fix,
                    # sixth pass -- "startup" was never really a recompute trigger either, since
                    # order_size_lit is persisted and a fresh process never clears it).
                    updates["order_size_lit"] = None
            if principal_total > 0:
                base = updates.get("profit_bucket_cover_drop_usd",
                                    float(state_now.get("profit_bucket_cover_drop_usd") or 0))
                updates["profit_bucket_cover_drop_usd"] = round(base + principal_total, 8)
            await self.update_state(updates)
        except Exception as e:
            await self.log_run("profit_bucket_credit_failed", {"error": str(e)[:200]})
            return
        for rid in all_ids:
            await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{rid}", {"profit_credited": True})

    async def reconcile_pending_orders(self, profit_mode=None):
        """Checks every non-terminal ledger row against the exchange's own account_orders().
        Returns (all_ok, usdc_delta, has_stale_unresolved): all_ok is True only if every batch
        was successfully read; usdc_delta is the net REAL cash impact (negative for buys,
        positive for sells) of whatever just newly became terminal-with-a-fill THIS pass, so
        callers can apply it to an otherwise-stale cached balance immediately (external audit fix
        P2-7); has_stale_unresolved is True if any order has been missing from the exchange's own
        lookup for longer than UNRESOLVED_ORDER_STALE_AFTER_S -- callers use this to pause new
        entries (never exits) the same way a real balance divergence already does (external audit
        fix, fifth pass -- a stale-unresolved order used to only be logged, never gated anything).

        Realized profit on a sell fill -- computed from the REAL incremental quote-amount delta
        (new cumulative filled_quote minus prior), never qty-times-average-price, which can be
        wrong the moment a multi-partial fill crosses more than one price (external audit fix,
        sixth pass) -- is recorded directly on that sell's own row, atomically with its status
        write; _flush_uncredited_profit() (called first, every pass) is what actually applies it
        to a bucket, retry-safe. The cost basis (and bucket-funded share of it) is read via
        current_holdings() ONCE per pass, before this pass's own PATCHes change it."""
        await self._flush_uncredited_profit()
        pending = await self.sb_paginate(
            f"{TABLE_ORDERS}?status=in.({','.join(OPEN_STATUSES)})&select=*&order=id.asc")
        if not pending:
            return True, 0.0, False
        holdings_before = None
        if any(r["side"] == "sell" for r in pending):
            holdings_before = await self.current_holdings()
        auth = self._get_auth_token()
        all_ok = True
        usdc_delta = 0.0
        has_stale_unresolved = False
        now = datetime.now(timezone.utc)
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
                    placed_at = _parse_iso(r.get("placed_at"))
                    if placed_at and (now - placed_at).total_seconds() > UNRESOLVED_ORDER_STALE_AFTER_S:
                        await self.log_run("order_unresolved_stale", {
                            "row_id": r["id"], "age_s": (now - placed_at).total_seconds()})
                        has_stale_unresolved = True
                    continue
                filled_qty, filled_price = _order_fill_amounts(o)
                filled_quote = float(getattr(o, "filled_quote_amount", 0) or 0)
                terminal = _order_is_terminal(o)
                status_raw = str(getattr(o, "status", "") or "").lower()
                prev_filled_qty = float(r.get("filled_qty") or 0)
                prev_filled_quote = float(r.get("filled_quote") or 0)
                patch = {"exchange_order_id": o.order_index}
                if filled_qty > 0:
                    patch["filled_qty"] = filled_qty
                    patch["filled_price"] = filled_price
                    patch["filled_quote"] = filled_quote
                    # Only the NEWLY-confirmed portion since the last reconciliation pass counts
                    # toward this call's cash delta -- a row can be reconciled more than once
                    # while a partial fill is still in progress. delta_quote is the REAL dollar
                    # amount exchanged for just this increment -- never delta_qty * (overall
                    # average) price, which is wrong the moment per-fill prices differ.
                    delta_qty = max(0.0, filled_qty - prev_filled_qty)
                    delta_quote = max(0.0, filled_quote - prev_filled_quote)
                    if delta_qty > 0:
                        signed = -1.0 if r["side"] == "buy" else 1.0
                        usdc_delta += signed * delta_quote
                        if r["side"] == "sell" and r.get("closes_level") is not None and holdings_before:
                            basis = holdings_before.get(r["closes_level"])
                            if basis and basis["qty"] > 1e-12:
                                per_unit_bucket_cost = basis.get("bucket_cost_total", 0.0) / basis["qty"]
                                profit_delta = delta_quote - delta_qty * basis["cost"]
                                principal_delta = delta_qty * per_unit_bucket_cost
                                patch["realized_profit_usd"] = round(
                                    float(r.get("realized_profit_usd") or 0) + profit_delta, 8)
                                patch["bucket_principal_return_usd"] = round(
                                    float(r.get("bucket_principal_return_usd") or 0) + principal_delta, 8)
                                if not r.get("profit_bucket_destination"):
                                    patch["profit_bucket_destination"] = PROFIT_BUCKET_COLUMN.get(
                                        profit_mode, "profit_bucket_rest_usd")
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
                    "computed_filled_qty": filled_qty, "computed_filled_price": filled_price,
                })
        return all_ok, usdc_delta, has_stale_unresolved

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
        """Returns (safe_to_trade, did_refresh). did_refresh tells the caller whether this call
        actually re-read the real exchange balance (vs. returning the cached pause-state because
        the periodic interval hadn't elapsed) -- callers use it to know whether a locally-tracked
        cash delta is still needed on top (external audit fix P2-7)."""
        now = time.time()
        if now - self._last_balance_check < BALANCE_RECONCILE_EVERY:
            return not self._balance_paused, False
        try:
            holdings = await self.current_holdings()
            real_usdc, real_lit = await self.real_balances()
        except Exception as e:
            await self.log_run("balance_check_failed", {"error": str(e)[:200]})
            self._balance_paused = True
            return False, False
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
        return not diverged, True

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
        """Refreshes (or verifies) heartbeat ownership and returns whether this instance still
        holds the lock. Called BEFORE every real exchange action (external audit fix, fifth
        pass): checking only AFTER the fact let exactly one action slip through per lock-loss
        event. An unverifiable heartbeat (a network error on the PATCH itself) now fails CLOSED
        -- treated as lock lost -- instead of silently leaving _lock_held True, consistent with
        every other safety check in this file (previously it failed open here, the one
        exception)."""
        if not self._lock_held:
            return False
        try:
            rows = await self.sb("PATCH", f"{TABLE_STATE}?id=eq.1&lock_owner=eq.{self._lock_id}",
                                  {"lock_heartbeat": now_iso()})
        except Exception as e:
            self._lock_held = False
            await self.log_run("instance_lock_heartbeat_unverifiable", {"error": str(e)[:200]})
            return False
        if not rows:
            self._lock_held = False
            await self.log_run("instance_lock_lost_mid_tick", {"lock_id": self._lock_id})
            return False
        return True

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

    # ── Holdings ─────────────────────────────────────────────────────────────────────────────
    async def current_holdings(self):
        """Running, quantity-aware balance per level, paginated (external audit fix P1-5).

        Buys only count once status='filled' (a deliberate, documented choice: a still-resting
        buy isn't "ours" to manage yet). Sells count the moment they have ANY recorded
        filled_qty, terminal or not (external audit fix P1-2/P1-3): a sell's execution is real
        money gone the instant it's recorded, whether or not the rest of that order is still
        working -- treating it as invisible until terminal is what let flatten try to re-sell
        inventory a still-open prior sell had already partially or fully sold.

        Also walks a SECOND blended total alongside the ordinary cost basis: how much of each
        level's current cost came from the cover_drop bucket (`funded_from_bucket_usd`, recorded
        on the buy row at placement time), reduced proportionally on a partial sell exactly like
        the cost basis itself (external audit fix, sixth pass -- cover_drop money spent on a buy
        never came back when that position was later sold; this is what lets a sell return its
        share of bucket-funded principal)."""
        buys = await self.sb_paginate(
            f"{TABLE_ORDERS}?status=eq.filled&side=eq.buy"
            f"&select=id,level,filled_qty,filled_price,funded_from_bucket_usd&order=id.asc")
        sells = await self.sb_paginate(
            f"{TABLE_ORDERS}?side=eq.sell&closes_level=not.is.null&filled_qty=not.is.null&select=id,closes_level,filled_qty&order=id.asc")
        events_by_level = {}
        for b in (buys or []):
            events_by_level.setdefault(b["level"], []).append(
                ("buy", b["id"], float(b["filled_qty"] or 0), float(b["filled_price"] or 0),
                 float(b.get("funded_from_bucket_usd") or 0)))
        for s in (sells or []):
            lvl = s.get("closes_level")
            if lvl is None:
                continue
            events_by_level.setdefault(lvl, []).append(
                ("sell", s["id"], float(s["filled_qty"] or 0), None, None))
        holdings = {}
        for lvl, events in events_by_level.items():
            events.sort(key=lambda e: e[1])
            qty = 0.0
            cost_total = 0.0
            bucket_cost_total = 0.0
            for kind, _id, ev_qty, ev_price, ev_bucket_cost in events:
                if kind == "buy":
                    cost_total += ev_qty * ev_price
                    bucket_cost_total += ev_bucket_cost
                    qty += ev_qty
                else:
                    if qty > 1e-12:
                        avg = cost_total / qty
                        avg_bucket = bucket_cost_total / qty
                        take = min(ev_qty, qty)
                        cost_total -= take * avg
                        bucket_cost_total -= take * avg_bucket
                        qty -= take
            if qty > 1e-9:
                holdings[lvl] = {"qty": qty, "cost": cost_total / qty, "bucket_cost_total": bucket_cost_total}
        return holdings

    async def resting_orders_by_level(self):
        rows = await self.sb_paginate(
            f"{TABLE_ORDERS}?status=in.({','.join(OPEN_STATUSES)})&select=*")
        by_level = {}
        for r in (rows or []):
            by_level.setdefault(r["level"], []).append(r)
        return by_level

    # ── One-shot allowance, reserved atomically BEFORE a buy is ever sent ──────────────────────
    async def _reserve_buy_allowance(self, expected_count):
        """Conditional PATCH: only succeeds if lifetime_buy_count still equals what we last
        read. Called BEFORE place_grid_order for a buy (external audit fix P1-1) -- an ambiguous
        send (crash, timeout) still consumed its slot, since the counter is already durably
        incremented by the time the order is attempted. Returns the new count, or None if
        another instance/tick already consumed it."""
        rows = await self.sb(
            "PATCH", f"{TABLE_STATE}?id=eq.1&lifetime_buy_count=eq.{expected_count}",
            {"lifetime_buy_count": expected_count + 1},
        )
        if not rows:
            return None
        return expected_count + 1

    async def maintain_window(self, state, price, entries_allowed=True):
        spacing_pct = float(state["spacing_pct"])
        step = math.log(1 + spacing_pct / 100.0)
        levels_down = max(1, int(state["levels_down"]))
        # Guard-banded window center (external audit fix P2-11): pure boundary noise no longer
        # shifts the active window and cancels a resting buy before it ever had a chance to fill.
        cur_lvl = level_of(price, step, reference=self._window_center)
        self._window_center = cur_lvl
        max_open_buys = state.get("max_open_buys")
        max_open_buys = int(max_open_buys) if max_open_buys is not None else None
        lifetime_buy_count = int(state.get("lifetime_buy_count") or 0)

        order_size_lit = state.get("order_size_lit")
        if order_size_lit is None:
            # Compound bucket folded into the sizing basis (direct request, profit allocation
            # feature), mirroring the paper bot's compounding_basis = capital_usd + bot_profit_usd
            # -- never decremented by this use, it keeps growing as more profit lands in it.
            compound_bucket = float(state.get("profit_bucket_compound_usd") or 0)
            effective_capital = float(state["capital_usd"]) + compound_bucket
            down_sizing_levels = levels_for_drawdown(spacing_pct, float(state.get("drawdown_pct") or 10.0))
            order_size_lit = compute_order_size_lit(
                effective_capital, price, spacing_pct, down_sizing_levels)
            await self.update_state({"order_size_lit": order_size_lit})
        order_size = clamp_order_size(float(order_size_lit or 0.0))

        holdings = await self.current_holdings()
        resting = await self.resting_orders_by_level()
        snap = LiveSnapshot(resting)

        for lvl, rows in list(resting.items()):
            for r in rows:
                if not self._lock_held:
                    return
                if r["side"] == "buy" and (lvl > cur_lvl - 1 or lvl < cur_lvl - levels_down):
                    if await self.cancel_order_row(r):
                        snap.buy_levels.discard(lvl)

        # Place sells FIRST. Conflict detection compares REAL integer price ticks, never a
        # recomputed display level (external audit fix P2-8). If a conflicting buy is found, it
        # is cancelled but the sell is DEFERRED to next tick -- never placed in the same breath
        # as an unconfirmed cancel (external audit fix P1-4).
        for lvl, h in holdings.items():
            if not self._lock_held:
                return
            if lvl in snap.sell_closes:
                continue
            sell_price = round_price(h["cost"] * (1 + spacing_pct / 100.0))
            sell_price_int = price_to_int(sell_price)
            conflicting_buys = [
                r for rows in snap.rows_by_level.values() for r in rows
                if r["side"] == "buy" and price_to_int(float(r["limit_price"])) == sell_price_int
            ]
            if conflicting_buys:
                for r in conflicting_buys:
                    await self.cancel_order_row(r)
                continue  # defer the sell to next tick, after reconciliation confirms it's gone
            sell_size = clamp_order_size(h["qty"])
            if sell_size is None:
                continue
            await self.place_grid_order(level_of(sell_price, step), "sell", sell_price, sell_size, closes_level=lvl)
            snap.sell_closes.add(lvl)

        if entries_allowed and order_size is not None:
            resting_buy_cost = sum(
                float(r["limit_price"]) * float(r["size"])
                for rows in resting.values() for r in rows if r["side"] == "buy"
            )
            real_usdc = float(state.get("usdc_balance") or 0)
            holdings_cost = sum(h["qty"] * h["cost"] for h in holdings.values())
            capital_committed = holdings_cost + resting_buy_cost
            # Compound bucket folded into the SPENDING ceiling too, not just the sizing basis
            # above (external audit fix, sixth pass: a bigger order size from compounding used
            # to just consume the old, unexpanded budget sooner instead of the compound bucket
            # actually funding more depth -- the two bases must agree).
            compound_bucket = float(state.get("profit_bucket_compound_usd") or 0)
            base_capital_remaining = max(0.0, (float(state["capital_usd"]) + compound_bucket) - capital_committed)
            # Cover-drop bucket extends the ceiling ON TOP OF that, never replacing it -- only
            # reached once the (compound-inclusive) base budget is exhausted (direct request,
            # profit allocation feature). Spent dollars are deducted from the bucket as they're
            # actually used, and returned later by a sell via _flush_uncredited_profit().
            cover_drop_bucket = float(state.get("profit_bucket_cover_drop_usd") or 0)
            available_usdc = min(real_usdc - resting_buy_cost, base_capital_remaining + cover_drop_bucket)
            bucket_spent = 0.0

            for lvl in range(cur_lvl - 1, cur_lvl - 1 - levels_down, -1):
                if not self._lock_held:
                    return
                if lvl in snap.buy_levels or lvl in snap.sell_closes or lvl in holdings:
                    continue
                if max_open_buys is not None and lifetime_buy_count >= max_open_buys:
                    break
                limit_price = round_price(math.exp(lvl * step))
                cost = limit_price * order_size
                if cost > available_usdc:
                    break
                if max_open_buys is not None:
                    reserved = await self._reserve_buy_allowance(lifetime_buy_count)
                    if reserved is None:
                        break  # another instance/tick already consumed the last slot
                    lifetime_buy_count = reserved
                row_id = await self.place_grid_order(lvl, "buy", limit_price, order_size)
                if row_id is None:
                    # Confirmed rejection (or the lock was lost -- caught by the loop-top check
                    # next iteration either way): no money was spent, so no charge against
                    # either budget (external audit fix, sixth pass -- a rejected buy used to be
                    # charged exactly like an accepted one). An AMBIGUOUS send still returns a
                    # real row id here and is still charged below, deliberately conservative,
                    # same philosophy as the one-shot allowance counter above.
                    continue
                snap.buy_levels.add(lvl)
                available_usdc -= cost
                from_base = min(cost, base_capital_remaining)
                base_capital_remaining -= from_base
                from_bucket_amount = cost - from_base
                bucket_spent += from_bucket_amount
                if from_bucket_amount > 0:
                    await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row_id}",
                                  {"funded_from_bucket_usd": round(from_bucket_amount, 8)})

            if bucket_spent > 0:
                await self.update_state({
                    "profit_bucket_cover_drop_usd": round(cover_drop_bucket - bucket_spent, 8),
                })

    async def market_sell_level(self, level, qty):
        # Lock validated BEFORE anything else (external audit fix, fifth pass): this function
        # never touched the heartbeat at all before, so a dethroned worker could keep flattening
        # indefinitely on an all-sell-no-cancel pass.
        if not await self._touch_lock_heartbeat():
            return None
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

    async def flatten_all(self, profit_mode=None):
        """Emergency path, retried every tick until VERIFIED complete. Cancels everything
        resting first, reconciles, then sells each held level that has no unresolved resting
        sell already working it (external audit fix P1-2) -- never a duplicate attempt against
        the same inventory. A terminal fill below the sellable minimum is logged distinctly
        (external audit fix P2-9) rather than looking like an ordinary retry.

        Both loops below bail the moment the lock is lost (external audit fix, fifth pass -- this
        function previously had NO lock checks at all, so a dethroned worker could keep
        flattening after a handover, racing the replacement worker over the same inventory). The
        new lock-holder picks the same flatten_requested flag up on its own very next tick, so
        stopping here never leaves the position unprotected."""
        await self.reconcile_pending_orders(profit_mode=profit_mode)
        resting = await self.resting_orders_by_level()
        any_cancel_failed = False
        for rows in resting.values():
            for r in rows:
                if not self._lock_held:
                    await self.log_run("flatten_aborted_lock_lost", {})
                    return
                if not await self.cancel_order_row(r):
                    any_cancel_failed = True
        if resting:
            await self.reconcile_pending_orders(profit_mode=profit_mode)

        if not self._lock_held:
            await self.log_run("flatten_aborted_lock_lost", {})
            return

        resting = await self.resting_orders_by_level()
        unresolved_sell_closes = {
            r["closes_level"] for rows in resting.values() for r in rows
            if r["side"] == "sell" and r.get("closes_level") is not None
        }

        holdings = await self.current_holdings()
        sell_failed = False
        for lvl, h in holdings.items():
            if not self._lock_held:
                await self.log_run("flatten_aborted_lock_lost", {})
                return
            if lvl in unresolved_sell_closes:
                sell_failed = True
                continue
            sized = clamp_order_size(h["qty"])
            if sized is None:
                await self.log_run("flatten_dust_stuck", {"level": lvl, "qty": h["qty"]})
                sell_failed = True
                continue
            row_id = await self.market_sell_level(lvl, h["qty"])
            if row_id is None:
                sell_failed = True
        if holdings:
            await self.reconcile_pending_orders(profit_mode=profit_mode)

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
        profit_mode = state.get("profit_mode")
        if state.get("flatten_requested"):
            await self.flatten_all(profit_mode=profit_mode)
            return
        reconciled_ok, usdc_delta, has_stale_unresolved = await self.reconcile_pending_orders(profit_mode=profit_mode)
        if usdc_delta:
            # Persisted IMMEDIATELY, before anything else that could return early (external
            # audit fix, sixth pass: a missing price -- or any other early return -- used to
            # skip this write entirely, permanently losing a cash correction that can never be
            # recomputed later, since its order has already left the reconcilable set). Fails
            # CLOSED (pauses new entries, never exits) if the persist write itself fails, same
            # philosophy as an unverifiable balance read.
            try:
                await self.update_state({"usdc_balance": float(state.get("usdc_balance") or 0) + usdc_delta})
            except Exception as e:
                self._balance_paused = True
                await self.log_run("cash_delta_persist_failed", {"error": str(e)[:200], "delta": usdc_delta})
        if not reconciled_ok:
            return
        balance_ok, _balance_refreshed = await self.check_balance_divergence()
        price = await self.fetch_current_price()
        if price is None:
            return
        # Always re-read state fresh after reconciliation, for every field -- not just cash
        # (external audit fix, sixth pass: a stale local patch of only usdc_balance left a
        # same-tick profit-bucket credit invisible to maintain_window()'s spend check later this
        # same tick, which then wrote old_bucket - spent, silently overwriting the fresh credit).
        state = await self.get_state()
        # A stale-unresolved order pauses new entries, never exits -- same philosophy as a real
        # balance divergence (external audit fix, fifth pass: this used to only be logged).
        entries_allowed = bool(state.get("enabled")) and balance_ok and not has_stale_unresolved

        spacing_pct = float(state["spacing_pct"])
        persisted_spacing = state.get("internal_spacing_pct")
        if persisted_spacing is not None and float(persisted_spacing) != spacing_pct:
            await self.cancel_all_resting()
            await self.reconcile_pending_orders(profit_mode=profit_mode)
            still_resting = await self.resting_orders_by_level()
            if still_resting:
                await self.log_run("spacing_change_cancel_incomplete",
                                    {"old": persisted_spacing, "new": spacing_pct,
                                     "still_resting_levels": list(still_resting.keys())})
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
