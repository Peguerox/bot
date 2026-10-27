"""
UPDATE 2026-10-27: runs Worker 3 AND the Mirror bot (fresh capital, owner's request): Worker 4's
own sub-account and credentials (this service's plain LIGHTER_* env vars) on NEW tables
lighter_lit_grid_live_mirror_* (Worker 4's old ledger stays untouched as history). Same code;
its state row sets the mirror shape (peak -10%), 0.25% spacing and the crash reserve. Starts OFF.

UPDATE 2026-10-23: runs Worker 3 ONLY (Worker 4 merged into it, see main()).

Render 3 entrypoint (2026-10-21, direct request): runs TWO live LIT/USDC grid instances in one
process, same pattern as lighter_hedge_dual_leg.py's two StochBot legs -- Worker 4's existing
instance (this service's own LIGHTER_* env vars, unchanged tables/behavior) and a NEW Worker 3
instance (WORKER3_LIGHTER_* env vars -- already present on this Render service from its hedge
days, see lighter_hedge_dual_leg.py's own docstring -- plus its own tables, see
supabase/migrations/lighter_lit_grid_live_worker3.sql), run side by side to compare real results
at two different spacings. Started with the SAME money roughly matched between the two accounts
(user's own call, "6k or similar") so a % return comparison is fair.

All the real trading logic lives in server/lit_grid_live.py, completely unchanged for Worker 4
(run_lit_grid_live() with zero args is byte-for-byte its old behavior -- see that function's own
docstring). Worker 3 passes table_state/table_orders/table_runs="lighter_lit_grid_live_worker3_*",
env_prefix="WORKER3_", tag="-worker3" -- its own tables, its own credentials, its own log lines
and lock, never touching Worker 4's.

lighter_lit_grid_live_worker4.py (Worker 4 alone) is left in the repo untouched as the revert
path -- same "Dead code" convention as every other retired/alternate config -- if this twin ever
needs to go back to a single instance, re-point the Start Command back to it.

Both bots start disabled (each state row's `enabled` defaults to false) -- nothing here places a
real order until the user explicitly flips each one on from its own dashboard panel. Worker 3's
sub-account needs to actually hold real USDC before it's turned on.
"""
import asyncio
import traceback

from lit_grid_live import run_lit_grid_live

WORKER3_TABLE_STATE = "lighter_lit_grid_live_worker3_state"
WORKER3_TABLE_ORDERS = "lighter_lit_grid_live_worker3_orders"
WORKER3_TABLE_RUNS = "lighter_lit_grid_live_worker3_runs"
MIRROR_TABLE_STATE = "lighter_lit_grid_live_mirror_state"
MIRROR_TABLE_ORDERS = "lighter_lit_grid_live_mirror_orders"
MIRROR_TABLE_RUNS = "lighter_lit_grid_live_mirror_runs"


async def main():
    # Worker 3 (curve) + the Mirror bot on Worker 4's emptied sub-account (2026-10-27). Both share
    # one request budget (ExchangeLimiter is process-wide).
    await asyncio.gather(
        run_lit_grid_live(
            table_state=WORKER3_TABLE_STATE, table_orders=WORKER3_TABLE_ORDERS,
            table_runs=WORKER3_TABLE_RUNS, env_prefix="WORKER3_", tag="-worker3",
        ),
        _isolated(lambda: run_lit_grid_live(
            table_state=MIRROR_TABLE_STATE, table_orders=MIRROR_TABLE_ORDERS,
            table_runs=MIRROR_TABLE_RUNS, env_prefix="", tag="-mirror",
        ), "mirror"),
    )


async def _isolated(make, name):
    """A crash in the Mirror bot (missing table, env var, anything) must never stop Worker 3:
    asyncio.gather would end the whole process on the first exception. Log, wait, start again."""
    while True:
        try:
            await make()
            return
        except asyncio.CancelledError:
            raise
        except Exception:
            traceback.print_exc()
            print(f"[{name}] crashed; restarting in 60s", flush=True)
            await asyncio.sleep(60)


if __name__ == "__main__":
    asyncio.run(main())
