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

SEVENTH-PASS REDESIGN (2026-10-18), from a sixth independent audit: three of its four findings
were separate symptoms of ONE root cause -- the sixth pass's profit buckets were a MUTABLE
counter, spent in one write and credited back in another, with no way to keep the two in sync
across a partial failure. Rather than patch each symptom again, the mutable counter is gone:

  - [was P1] Retrying the sixth pass's credit flush could double-apply a credit if the
    "mark credited" write failed, or its response was lost, after the bucket update had already
    committed -- two separate writes for one logical operation, no way to make the pair atomic
    over plain REST PATCHes. There is no separate "mark credited" step anymore to go out of sync.
  - [was P2] A confirmed, zero-fill cancellation never released the coverage it had reserved --
    nothing ever un-tagged it, so repeated cancel/replace cycles (the window-chasing behavior
    kept on purpose, see v5) could drain cover_drop while the real exchange cash sat untouched.
  - [was P1] A failed bucket-deduction write (separate from the order's own funded_from_bucket_usd
    tag) left the bucket at its original amount; when that buy later sold, the sixth pass's
    principal-return step still credited the tagged amount back, producing a false credit for
    money that was never actually taken out.

  profit_bucket_rest_usd / _compound_usd / _cover_drop_usd are now PURE DERIVED values,
  recomputed by _bucket_balances() every tick and written back purely for display -- never
  mutated by a spend or a return. rest/compound are simply the sum of realized_profit_usd
  (recorded durably on each sell row, atomic with its own 'filled' status, unchanged from sixth
  pass) routed to that destination. cover_drop is that same sum, MINUS money currently reserved
  by a still-unresolved buy (status in OPEN_STATUSES -- a CONFIRMED cancellation moves a row out
  of this set with nothing extra to write, which is exactly what makes a cancelled buy's
  reservation release itself for free) and MINUS money tied up in inventory that hasn't sold yet
  (current_holdings()'s bucket_cost_total, which already shrinks the moment that inventory
  sells -- so cover_drop's spendable room rises back up on its own, no "return principal" step
  to get out of sync). bucket_principal_return_usd and profit_credited are no longer written;
  the columns are left in place (never drop a column retroactively) but are simply unused.

  The remaining [P1] finding -- a per-row reconciliation write failure could raise uncaught out
  of reconcile_pending_orders() entirely, losing every OTHER row's already-computed cash delta
  THIS pass, permanently, since a row whose write DID succeed is now 'filled' and drops out of
  every future scan -- is fixed directly: each row's PATCH is now in its own try/except, and a
  row's contribution to usdc_delta is only counted once its own write is confirmed. The SAME
  class of loss existed in the spacing-change branch, which called reconcile_pending_orders()
  a second time and discarded its returned delta outright; both call sites (and flatten_all's
  three) now run their delta through one shared _apply_usdc_delta() helper.

  funded_from_bucket_usd is tagged against the FULL requested order size at placement time;
  current_holdings() now scales it by filled_qty/size when attributing bucket-funded cost to a
  position, so an order that only partially filled before the rest was cancelled doesn't
  attribute the WHOLE intended reservation to a position that's actually smaller.

EIGHTH-PASS CHANGES (2026-10-18), two direct-request behavior changes plus four findings from a
seventh independent audit:

  - Window-chasing removed entirely (direct request): a resting buy used to get cancelled the
    moment price drifted close enough that its OWN level fell outside the window's current top
    edge -- even though price had never actually reached its real limit price. Repeated
    cancel/replace cycles like this could burn through a one-shot allowance (when one is set)
    with zero real fills ever happening -- nothing bought, nothing to sell, and no slots left to
    try again. A resting buy is now cancelled ONLY by an explicit spacing change or a flatten,
    never by the window simply moving. The window still governs where NEW buys get placed each
    tick; it no longer un-places existing ones.
  - Cold-start initial fill (direct request): the resting-limit ladder only ever fills if price
    drifts down into it, which might never happen -- a fresh (or freshly reset) bot could sit at
    zero inventory indefinitely. The very first time this bot has never filled a buy and
    currently holds nothing, `levels_up` lots worth of size are bought immediately with a REAL
    MARKET order, subject to the exact same budget/allowance/bucket-funding checks as an
    ordinary buy -- `levels_down` plays NO role in a cold start; it still governs only the
    ongoing resting-ladder depth, exactly as before, so the two are fully independent. The
    instant any buy has ever filled, every subsequent buy -- including refilling a level that
    later sells back to empty -- goes through the normal resting-limit ladder again, unaffected,
    governed by levels_down as always. The budget check for a cold-start buy uses the real LIVE
    price (what will actually be paid), not each level's theoretical grid price, which would
    have understated the real cost for the deeper levels. See NINTH-PASS FIX below for how the
    cold-start lots and the ladder are placed on an anchored grid.
  - [P1] A reconcile row-write failure could mean the write actually committed and only the
    HTTP response was lost -- not that nothing happened. Treating that as "definitely not
    persisted" (previous pass's assumption) left the bot's cash/holdings view silently wrong
    with no pause. A row-write exception now also fails closed: it pauses new entries and resets
    the balance-refresh timer so the very next tick forces a fresh, authoritative check instead
    of waiting out the normal interval on a cache that might already be stale.
  - [P1] check_balance_divergence() advanced its own refresh timer BEFORE persisting the fresh
    balance it had just read -- if that save failed, the next tick's throttle check believed a
    refresh had just succeeded and skipped doing a real one, trusting old cash with the pause
    flag still false. The save is now inside the same guarded block as the read, and the timer
    only advances once that save has actually succeeded.
  - [P2] funded_from_bucket_usd was written in a SEPARATE PATCH after the order's own row was
    already created -- if that second write failed, the order was real and open but its
    reservation was invisible to _bucket_balances(), letting the derived "available" figure
    overstate what was actually free. It's now included in the SAME insert that creates the
    order's ledger row in the first place, for both the ordinary ladder and the cold-start path.
  - [P2] The base capital_usd budget was being charged for the FULL cost of every holding and
    resting buy, including the share that was actually funded by cover_drop -- the same dollar
    was then subtracted a SECOND time from cover_drop's own derived figure, double-charging it
    against both budgets. capital_committed for the base budget now excludes each holding's and
    resting buy's bucket-funded share (tracked via the same funded_from_bucket_usd/
    bucket_cost_total this file already maintains), so a position entirely funded by profit no
    longer eats into the user's own configured capital_usd at all.

NINTH-PASS FIX (2026-10-18), from a real live incident on the very first time the bot was ever
turned on: `levels_up=5` placed FIVE SEPARATE market buys at cold start, one per nominal level.
A market order ignores the "level" price entirely -- it just buys at whatever price the book
offers right now -- so all five filled within a few cents of each other instead of 0.125%
apart. Their sell targets (cost * (1+spacing%)) are derived from that real cost, so all five
collapsed onto the SAME real price tick. The bot then tried to rest five separate sell orders
on that one tick: the exchange's own POST_ONLY handling cancelled several of them outright, one
filled for a few cents of dust, and the rest only separated once real price had drifted far
enough -- visible live as a burst of cancel/replace noise and a ladder gap of ~0.8% instead of
0.125% between the cold-start holdings and the first resting buy below them.
A first fix (one combined market order) removed the collision but still left a hole: grid lines
were fixed to a global scale (anchored at $1.00) unrelated to the start price, and the first
buy sat one extra line down -- live, price 2.8790 had its first buy at 2.8701 (-0.31%) and its
sell at 2.8844 (+0.19%). Final fix (direct request: "5 up, 15 down, each 0.125%"): the grid is
anchored at the price the bot starts at (state.grid_anchor_price, written on cold start), so
every line is anchor * (1+spacing)^n. Cold start market-buys levels_up lots, one order each,
held at lines 0..levels_up-1; each lot held at line L sells at line L+1 (never below cost),
giving sells at exactly +1..+levels_up spacings. The buy ladder starts at the highest free line
at or below price, giving buys at exactly -1..-levels_down spacings. A run with no anchor keeps
the old behavior.

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

TICK_EVERY = 2.0
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
        self._holdings_cache = None
        self._holdings_cache_on = False

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
    async def place_grid_order(self, level, side, limit_price, size, closes_level=None,
                                funded_from_bucket_usd=0.0):
        # Lock validated BEFORE anything else (external audit fix, fifth pass): checking AFTER
        # the send let exactly one action slip through per lock-loss event.
        if not await self._touch_lock_heartbeat():
            return None
        co_idx = int(time.time() * 1000) % 500_000_000
        row = {
            "level": level, "side": side, "client_order_index": co_idx,
            "status": "pending", "limit_price": limit_price, "size": size,
            "placed_at": now_iso(), "closes_level": closes_level,
            # Written in the SAME insert as the row itself, never a separate follow-up PATCH
            # (external audit fix, eighth pass): a failed follow-up write used to leave a real,
            # open order with an invisible reservation, overstating what _bucket_balances()
            # thought was still free.
            "funded_from_bucket_usd": round(funded_from_bucket_usd, 8),
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

    async def _bucket_balances(self):
        """PURE DERIVED balances (external audit fix, seventh pass -- replaces the sixth pass's
        mutable spend/credit counter entirely, which had THREE separate non-atomicity bugs found
        by the same audit round: a retry could double-apply a credit if the "mark credited"
        write failed or its response was lost after the bucket update had already committed; a
        confirmed cancellation never released an unfilled buy's reservation, since nothing ever
        un-tagged it; and a failed bucket-deduction write (separate from the order's own
        funded_from_bucket_usd tag) meant a later sell's "return principal" step credited money
        that was never actually taken out. All three were symptoms of one root cause: a mutable
        counter, spent in one write and credited back in another, with no way to keep the two in
        sync across a partial failure.

        There is no mutable counter anymore. rest/compound are simply the sum of
        realized_profit_usd (recorded durably on each sell row, atomic with its own 'filled'
        status -- unchanged from sixth pass) routed to that destination. cover_drop is that same
        sum, MINUS whatever is currently tied up: money reserved by a still-unresolved buy
        (status in OPEN_STATUSES -- a CONFIRMED cancellation moves a row out of this set
        automatically, with nothing extra to write, which is exactly what makes a cancelled
        buy's reservation release itself for free) and money tied up in inventory that hasn't
        sold yet (current_holdings()'s bucket_cost_total, which already shrinks automatically
        the moment that inventory sells -- so cover_drop's spendable room rises back up on its
        own, with no separate 'return principal' step to get out of sync)."""
        sells = await self.sb_paginate(
            f"{TABLE_ORDERS}?side=eq.sell&realized_profit_usd=not.is.null"
            f"&select=realized_profit_usd,profit_bucket_destination")
        gross = {"profit_bucket_rest_usd": 0.0, "profit_bucket_cover_drop_usd": 0.0,
                 "profit_bucket_compound_usd": 0.0}
        for s in (sells or []):
            dest = s.get("profit_bucket_destination") or "profit_bucket_rest_usd"
            gross[dest] = gross.get(dest, 0.0) + float(s.get("realized_profit_usd") or 0)
        open_buys = await self.sb_paginate(
            f"{TABLE_ORDERS}?side=eq.buy&status=in.({','.join(OPEN_STATUSES)})"
            f"&select=funded_from_bucket_usd")
        reserved = sum(float(r.get("funded_from_bucket_usd") or 0) for r in (open_buys or []))
        holdings = await self.current_holdings()
        held_bucket_cost = sum(h.get("bucket_cost_total", 0.0) for h in holdings.values())
        gross["profit_bucket_cover_drop_usd"] = round(
            max(0.0, gross["profit_bucket_cover_drop_usd"] - reserved - held_bucket_cost), 8)
        gross["profit_bucket_rest_usd"] = round(gross["profit_bucket_rest_usd"], 8)
        gross["profit_bucket_compound_usd"] = round(gross["profit_bucket_compound_usd"], 8)
        return gross

    async def _has_ever_bought(self):
        """Whether any buy has EVER been confirmed filled, ever, for this bot -- the cold-start
        detector (direct request, eighth pass). A fresh enable, or a reset that wiped the order
        ledger, reads as never-bought again, which is exactly the point: each genuinely fresh
        start gets the eager initial fill; every tick after that first fill goes through the
        normal resting-limit ladder."""
        rows = await self.sb("GET", f"{TABLE_ORDERS}?side=eq.buy&status=eq.filled&select=id&limit=1")
        return bool(rows)

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
        write; _bucket_balances() (seventh pass) is what actually turns these into a bucket
        figure, by always re-deriving it rather than mutating a running counter. The cost basis
        is read via current_holdings() ONCE per pass, before this pass's own PATCHes change it.

        Each row's own PATCH write is now isolated in its own try/except (external audit fix,
        seventh pass): a failure on ONE row used to raise uncaught out of this whole function,
        losing every other row's already-computed usdc_delta THIS pass -- and since a row whose
        write succeeded is now 'filled' (dropped from every future OPEN_STATUSES scan), that
        delta could never be recovered later either. A row's contribution to usdc_delta is only
        counted once its OWN write is confirmed; an uncounted row is simply recomputed correctly
        on the next pass, since its filled_qty was never actually persisted."""
        pending = await self.sb_paginate(
            f"{TABLE_ORDERS}?status=in.({','.join(OPEN_STATUSES)})&select=*&order=id.asc")
        if not pending:
            return True, 0.0, False
        self._holdings_cache = None
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
                row_usdc_delta = 0.0
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
                        row_usdc_delta = signed * delta_quote
                        if r["side"] == "sell" and r.get("closes_level") is not None and holdings_before:
                            basis = holdings_before.get(r["closes_level"])
                            if basis and basis["qty"] > 1e-12:
                                profit_delta = delta_quote - delta_qty * basis["cost"]
                                patch["realized_profit_usd"] = round(
                                    float(r.get("realized_profit_usd") or 0) + profit_delta, 8)
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
                # Skip the write (and its log line) when nothing about this order changed since
                # the last pass -- rewriting every resting row every tick made a tick take ~11s
                # with ~20 open orders, delaying fill detection. An unchanged row can't carry a
                # cash delta (that needs filled_qty to have moved), so nothing is lost.
                changed = (
                    patch["status"] != r.get("status")
                    or str(r.get("exchange_order_id")) != str(patch["exchange_order_id"])
                    or ("filled_qty" in patch
                        and abs(float(r.get("filled_qty") or 0) - patch["filled_qty"]) > 1e-12)
                    or ("filled_quote" in patch
                        and abs(float(r.get("filled_quote") or 0) - patch["filled_quote"]) > 1e-9)
                )
                if not changed:
                    continue
                try:
                    await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{r['id']}", patch)
                except Exception as e:
                    # The write may have actually committed and only the HTTP response was
                    # lost -- NOT proof that nothing persisted (external audit fix, eighth
                    # pass). Fails closed: pauses new entries and forces the very next tick to
                    # run a fresh, authoritative balance check instead of trusting a cache that
                    # might already be wrong, rather than just logging and moving on.
                    await self.log_run("reconcile_row_write_failed", {"row_id": r["id"], "error": str(e)[:200]})
                    all_ok = False
                    self._balance_paused = True
                    self._last_balance_check = 0.0
                    continue
                usdc_delta += row_usdc_delta
                await self.log_run("reconciled_order", {
                    "row_id": r["id"], "raw_status": status_raw, "terminal": terminal,
                    "computed_filled_qty": filled_qty, "computed_filled_price": filled_price,
                })
        self._holdings_cache = None
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
            # margin_balance is only meaningful when that asset's margin_mode is "enabled"
            # (USDC here). For a non-margin asset (LIT: margin_mode "disabled") margin_balance
            # is always 0 and `balance` is the full amount held, locked_balance being the part
            # of it already resting in sell orders -- confirmed live 2026-10-18 (balance=12.96,
            # locked_balance=12.96 while holding exactly 12.96 LIT).
            if getattr(asset, "margin_mode", None) == "enabled":
                total = float(getattr(asset, "margin_balance", None) or 0)
            else:
                total = float(asset.balance or 0)
            if symbol == "LIT":
                lit = total
            elif symbol == "USDC":
                usdc = total
        return usdc, lit

    async def check_balance_divergence(self):
        """Returns (safe_to_trade, did_refresh). did_refresh tells the caller whether this call
        actually re-read the real exchange balance (vs. returning the cached pause-state because
        the periodic interval hadn't elapsed) -- callers use it to know whether a locally-tracked
        cash delta is still needed on top (external audit fix P2-7).

        The fresh balance's SAVE is inside the same guarded block as its READ, and the refresh
        timer only advances once that save has actually succeeded (external audit fix, eighth
        pass): advancing the timer first meant a failed save left the next tick believing a
        refresh had just succeeded, so it skipped doing a real one and kept trusting stale cash
        with the pause flag still false."""
        now = time.time()
        if now - self._last_balance_check < BALANCE_RECONCILE_EVERY:
            return not self._balance_paused, False
        try:
            holdings = await self.current_holdings()
            real_usdc, real_lit = await self.real_balances()
            await self.update_state({"usdc_balance": real_usdc, "lit_balance": real_lit})
        except Exception as e:
            await self.log_run("balance_check_failed", {"error": str(e)[:200]})
            self._balance_paused = True
            return False, False
        self._last_balance_check = now
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
        # Within one tick the holdings are computed once and reused (they were rebuilt from
        # the full ledger 3-4 times per tick). Only a reconcile pass can change them -- it's
        # the only writer of fills -- and it drops the cache before and after its writes.
        if getattr(self, "_holdings_cache_on", False) and self._holdings_cache is not None:
            return dict(self._holdings_cache)
        holdings = await self._compute_holdings()
        if getattr(self, "_holdings_cache_on", False):
            self._holdings_cache = holdings
            return dict(holdings)
        return holdings

    async def _compute_holdings(self):
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
        never came back when that position was later sold; this is what lets cover_drop's
        spendable room rise back up once it does, per _bucket_balances()). funded_from_bucket_usd
        is tagged against the FULL requested order size, so a buy that only partially filled
        before the rest was cancelled has its tag scaled down by filled_qty/size here (external
        audit fix, seventh pass) -- otherwise a partial fill would attribute the WHOLE intended
        reservation to a position that's actually smaller than what was reserved for."""
        buys = await self.sb_paginate(
            f"{TABLE_ORDERS}?status=eq.filled&side=eq.buy"
            f"&select=id,level,filled_qty,filled_price,size,funded_from_bucket_usd&order=id.asc")
        sells = await self.sb_paginate(
            f"{TABLE_ORDERS}?side=eq.sell&closes_level=not.is.null&filled_qty=not.is.null&select=id,closes_level,filled_qty&order=id.asc")
        events_by_level = {}
        for b in (buys or []):
            requested_size = float(b.get("size") or 0)
            fill_ratio = (float(b["filled_qty"] or 0) / requested_size) if requested_size > 1e-12 else 1.0
            events_by_level.setdefault(b["level"], []).append(
                ("buy", b["id"], float(b["filled_qty"] or 0), float(b["filled_price"] or 0),
                 float(b.get("funded_from_bucket_usd") or 0) * min(1.0, fill_ratio)))
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

        # Cold-start detector (direct request, eighth pass) -- computed once per call, before
        # anything below can change holdings/has-ever-bought, so the whole buy-placement section
        # treats this tick consistently as either a cold start or not, never a mix.
        is_cold_start = (not holdings and not snap.buy_levels
                         and not await self._has_ever_bought())

        # Grid anchored at the starting price (direct request): every line is
        # anchor * (1 + spacing)^n, so on a fresh start the first sell sits exactly one spacing
        # above price and the first buy exactly one spacing below. A run with no anchor keeps
        # the old behavior (global grid, sells at cost + spacing).
        if is_cold_start and entries_allowed:
            await self.update_state({"grid_anchor_price": price})
            state["grid_anchor_price"] = price
            self._window_center = None
        anchored = state.get("grid_anchor_price") is not None
        anchor = float(state["grid_anchor_price"]) if anchored else 1.0
        # Guard-banded window center (external audit fix P2-11): pure boundary noise no longer
        # shifts the active window and cancels a resting buy before it ever had a chance to fill.
        cur_lvl = level_of(price / anchor, step, reference=self._window_center)
        self._window_center = cur_lvl

        # Fixed grid (direct request: "5 up + 15 down = 20 orders, unless we change it"): on an
        # anchored grid the lines run from -levels_down to +levels_up around the start price and
        # never slide. A resting buy below the bottom line (left over from an older rule, or from
        # lowering levels_down) is cancelled so the order count stays levels_up + levels_down.
        grid_bottom = -levels_down
        if anchored:
            for rows in resting.values():
                for r in rows:
                    if r["side"] == "buy" and int(r["level"]) < grid_bottom:
                        if not self._lock_held:
                            return
                        await self.cancel_order_row(r)

        # Window-chasing removed entirely (direct request, eighth pass): a resting buy used to
        # get cancelled the moment its own level fell outside the window's current top edge,
        # even though price had never actually reached its real limit price -- repeated
        # cancel/replace cycles like that could burn through a one-shot allowance with zero real
        # fills ever happening. A resting buy is now cancelled ONLY by an explicit spacing change
        # or a flatten (elsewhere in this file); this window now only decides where NEW buys get
        # placed, never un-places existing ones.

        # Place sells FIRST. Conflict detection compares REAL integer price ticks, never a
        # recomputed display level (external audit fix P2-8). If a conflicting buy is found, it
        # is cancelled but the sell is DEFERRED to next tick -- never placed in the same breath
        # as an unconfirmed cancel (external audit fix P1-4).
        for lvl, h in holdings.items():
            if not self._lock_held:
                return
            if lvl in snap.sell_closes:
                continue
            if anchored:
                # One sell per grid line: lot held at line L sells at line L+1, never below cost.
                sell_price = max(round_price(anchor * math.exp((lvl + 1) * step)),
                                 round_price(h["cost"]))
            else:
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
            await self.place_grid_order(level_of(sell_price / anchor, step), "sell", sell_price, sell_size, closes_level=lvl)
            snap.sell_closes.add(lvl)

        if entries_allowed and order_size is not None:
            resting_buy_cost = sum(
                float(r["limit_price"]) * float(r["size"])
                for rows in resting.values() for r in rows if r["side"] == "buy"
            )
            # The base budget now excludes each holding's/resting buy's own bucket-funded share
            # (external audit fix, eighth pass): charging the FULL cost of a position that was
            # actually funded by cover_drop against capital_usd double-counted that same dollar,
            # since _bucket_balances() already subtracts it from cover_drop's own derived figure.
            resting_buy_bucket_cost = sum(
                float(r.get("funded_from_bucket_usd") or 0)
                for rows in resting.values() for r in rows if r["side"] == "buy"
            )
            real_usdc = float(state.get("usdc_balance") or 0)
            holdings_cost = sum(h["qty"] * h["cost"] for h in holdings.values())
            holdings_bucket_cost = sum(h.get("bucket_cost_total", 0.0) for h in holdings.values())
            capital_committed_base_only = (
                (holdings_cost - holdings_bucket_cost) + (resting_buy_cost - resting_buy_bucket_cost)
            )
            # Compound bucket folded into the SPENDING ceiling too, not just the sizing basis
            # above (external audit fix, sixth pass: a bigger order size from compounding used
            # to just consume the old, unexpanded budget sooner instead of the compound bucket
            # actually funding more depth -- the two bases must agree).
            compound_bucket = float(state.get("profit_bucket_compound_usd") or 0)
            base_capital_remaining = max(
                0.0, (float(state["capital_usd"]) + compound_bucket) - capital_committed_base_only)
            # Cover-drop bucket extends the ceiling ON TOP OF that, never replacing it -- only
            # reached once the (compound-inclusive) base budget is exhausted (direct request,
            # profit allocation feature). state["profit_bucket_cover_drop_usd"] is this tick's
            # freshly-DERIVED figure (tick() computes it via _bucket_balances() before calling
            # here) -- there is no separate decrement to write at the end of this loop anymore
            # (external audit fix, seventh pass): available_usdc below is the single running
            # total that already correctly shrinks by each buy's full cost regardless of which
            # sub-budget it's attributed to, and the per-buy funded_from_bucket_usd tag (written
            # atomically with the order itself, external audit fix eighth pass) is the only
            # durable fact _bucket_balances() needs to derive the post-spend figure correctly on
            # the very next tick. The real-cash ceiling below always uses the FULL resting cost
            # regardless of attribution -- real cash doesn't care which sub-budget funded it.
            cover_drop_bucket = float(state.get("profit_bucket_cover_drop_usd") or 0)
            available_usdc = min(real_usdc - resting_buy_cost, base_capital_remaining + cover_drop_bucket)

            if is_cold_start:
                # Cold start (direct request): market-buy the LIT for the levels_up lots now, one
                # market order per lot, held at grid lines 0..levels_up-1 so their sells land at
                # anchor +1..+levels_up spacings -- one sell per line, never stacked on one
                # price (2026-10-18 incident). The buy ladder follows next tick.
                for lvl in range(0, max(1, int(state.get("levels_up") or 1))):
                    if not self._lock_held:
                        return
                    if max_open_buys is not None and lifetime_buy_count >= max_open_buys:
                        break
                    cost = price * order_size
                    if cost > available_usdc:
                        break
                    if max_open_buys is not None:
                        reserved = await self._reserve_buy_allowance(lifetime_buy_count)
                        if reserved is None:
                            break
                        lifetime_buy_count = reserved
                    from_base = min(cost, base_capital_remaining)
                    row_id = await self.market_buy_level(
                        lvl, order_size, funded_from_bucket_usd=cost - from_base)
                    if row_id is None:
                        continue
                    available_usdc -= cost
                    base_capital_remaining -= from_base
            else:
                if anchored:
                    # One empty line next to price, buys on every line below it down to the fixed
                    # bottom: the empty line is the lowest held lot's line (its sell sits one line
                    # up), or with nothing held, the line at price.
                    top = min(min(holdings) - 1, cur_lvl) if holdings else cur_lvl - 1
                    bottom = grid_bottom
                else:
                    top = cur_lvl - 1
                    bottom = top - levels_down + 1
                for lvl in range(top, bottom - 1, -1):
                    if not self._lock_held:
                        return
                    if lvl in snap.buy_levels or lvl in snap.sell_closes or lvl in holdings:
                        continue
                    if anchored and (lvl - 1) in holdings:
                        continue  # that holding's sell rests on this line
                    if max_open_buys is not None and lifetime_buy_count >= max_open_buys:
                        break
                    limit_price = round_price(anchor * math.exp(lvl * step))
                    cost = limit_price * order_size
                    if cost > available_usdc:
                        break
                    if max_open_buys is not None:
                        reserved = await self._reserve_buy_allowance(lifetime_buy_count)
                        if reserved is None:
                            break  # another instance/tick already consumed the last slot
                        lifetime_buy_count = reserved
                    from_base = min(cost, base_capital_remaining)
                    from_bucket_amount = cost - from_base
                    row_id = await self.place_grid_order(
                        lvl, "buy", limit_price, order_size, funded_from_bucket_usd=from_bucket_amount)
                    if row_id is None:
                        # Confirmed rejection (or the lock was lost -- caught by the loop-top
                        # check next iteration either way): no money was spent, so no charge
                        # against either budget (external audit fix, sixth pass -- a rejected
                        # buy used to be charged exactly like an accepted one). An AMBIGUOUS
                        # send still returns a real row id here and is still charged below,
                        # deliberately conservative, same philosophy as the allowance counter.
                        continue
                    snap.buy_levels.add(lvl)
                    available_usdc -= cost
                    base_capital_remaining -= from_base

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

    async def market_buy_level(self, level, qty, funded_from_bucket_usd=0.0):
        """Real market buy for the cold-start initial fill (direct request, eighth pass): the
        resting-limit ladder only ever fills if price drifts down into it, which might never
        happen. The very first time this bot has nothing bought, each configured level is filled
        with a real market buy like this one instead of a resting limit, right away. Mirrors
        market_sell_level's own IOC-style execution band, just on the buy side."""
        if not await self._touch_lock_heartbeat():
            return None
        sized = clamp_order_size(qty)
        if sized is None:
            return None
        price = self.live.best_mid()
        if price is None:
            return None
        band_price = round_price(price * 1.005)
        co_idx = int(time.time() * 1000) % 500_000_000
        row = {"level": level, "side": "buy", "client_order_index": co_idx,
               "status": "pending", "limit_price": band_price, "size": sized, "placed_at": now_iso(),
               "funded_from_bucket_usd": round(funded_from_bucket_usd, 8)}
        inserted = await self.sb("POST", TABLE_ORDERS, row)
        row_id = inserted[0]["id"]
        try:
            _o, _r, err = await asyncio.wait_for(
                self.client.create_market_order(
                    market_index=MARKET_ID, client_order_index=co_idx,
                    base_amount=size_to_int(sized), avg_execution_price=price_to_int(band_price),
                    is_ask=False, reduce_only=False,
                ),
                timeout=ORDER_TIMEOUT,
            )
            if err:
                await self.sb("PATCH", f"{TABLE_ORDERS}?id=eq.{row_id}",
                               {"status": "rejected", "error": str(err)[:200]})
                return None
        except Exception as e:
            await self.log_run("initial_fill_buy_unknown", {"row_id": row_id, "error": str(e)[:200]})
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
        stopping here never leaves the position unprotected. Every reconcile call's cash delta
        is applied via _apply_usdc_delta() (external audit fix, seventh pass) -- discarding it
        here is harmless to safety (entries are blocked throughout flatten regardless) but was
        still a real, permanent loss of display accuracy for exactly the reason fixed in tick()."""
        _ok, delta, _stale = await self.reconcile_pending_orders(profit_mode=profit_mode)
        await self._apply_usdc_delta(delta)
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
            _ok, delta, _stale = await self.reconcile_pending_orders(profit_mode=profit_mode)
            await self._apply_usdc_delta(delta)

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
            _ok, delta, _stale = await self.reconcile_pending_orders(profit_mode=profit_mode)
            await self._apply_usdc_delta(delta)

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

    async def _apply_usdc_delta(self, usdc_delta):
        """Persists a reconciliation pass's cash delta immediately, reading the current balance
        fresh rather than trusting a possibly-stale closure value (external audit fix, seventh
        pass: the spacing-change branch used to call reconcile_pending_orders() a second time and
        silently discard its returned delta entirely -- a fill confirmed during that cancel-
        triggered pass was durably marked 'filled' in the ledger, but its cash impact was never
        applied anywhere, permanently, for exactly the same reason the main-flow delta needed
        fixing last round. Every reconcile_pending_orders() call site now runs its delta through
        this same helper.) Fails CLOSED (pauses new entries, never exits) if the persist write
        itself fails, same philosophy as an unverifiable balance read."""
        if not usdc_delta:
            return
        try:
            fresh = await self.get_state()
            await self.update_state({"usdc_balance": float(fresh.get("usdc_balance") or 0) + usdc_delta})
        except Exception as e:
            self._balance_paused = True
            await self.log_run("cash_delta_persist_failed", {"error": str(e)[:200], "delta": usdc_delta})

    async def tick(self):
        self._holdings_cache = None
        self._holdings_cache_on = True
        try:
            await self._tick()
        finally:
            self._holdings_cache_on = False
            self._holdings_cache = None

    async def _tick(self):
        state = await self.get_state()
        profit_mode = state.get("profit_mode")
        if state.get("flatten_requested"):
            await self.flatten_all(profit_mode=profit_mode)
            return
        reconciled_ok, usdc_delta, has_stale_unresolved = await self.reconcile_pending_orders(profit_mode=profit_mode)
        await self._apply_usdc_delta(usdc_delta)
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
        # Profit buckets are PURE DERIVED values now (external audit fix, seventh pass -- see
        # _bucket_balances()'s own docstring for why the old mutable counter was replaced
        # entirely). Computed fresh every tick and persisted purely for dashboard display;
        # maintain_window() below reads these same freshly-derived figures off `state`, never a
        # value that could have drifted out of sync with the ledger.
        buckets = await self._bucket_balances()
        if buckets.get("profit_bucket_compound_usd") != state.get("profit_bucket_compound_usd"):
            # New compound profit should actually trigger a resize at the next tick, not sit
            # inert until an unrelated settings change.
            buckets["order_size_lit"] = None
        await self.update_state(buckets)
        state.update(buckets)
        # A stale-unresolved order pauses new entries, never exits -- same philosophy as a real
        # balance divergence (external audit fix, fifth pass: this used to only be logged).
        entries_allowed = bool(state.get("enabled")) and balance_ok and not has_stale_unresolved

        spacing_pct = float(state["spacing_pct"])
        persisted_spacing = state.get("internal_spacing_pct")
        if persisted_spacing is not None and float(persisted_spacing) != spacing_pct:
            await self.cancel_all_resting()
            _spacing_ok, spacing_usdc_delta, _spacing_stale = await self.reconcile_pending_orders(profit_mode=profit_mode)
            await self._apply_usdc_delta(spacing_usdc_delta)
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
