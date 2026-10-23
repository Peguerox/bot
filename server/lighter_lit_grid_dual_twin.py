"""
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

from lit_grid_live import run_lit_grid_live

WORKER3_TABLE_STATE = "lighter_lit_grid_live_worker3_state"
WORKER3_TABLE_ORDERS = "lighter_lit_grid_live_worker3_orders"
WORKER3_TABLE_RUNS = "lighter_lit_grid_live_worker3_runs"


async def main():
    # Worker 4 (0.5%) was merged into Worker 3 on 2026-10-23 (its LIT, cash and ledger moved over,
    # Worker 4's sub-account left empty) -- only Worker 3 runs now. To bring a second instance back,
    # add another run_lit_grid_live(...) to this gather.
    await asyncio.gather(
        run_lit_grid_live(
            table_state=WORKER3_TABLE_STATE, table_orders=WORKER3_TABLE_ORDERS,
            table_runs=WORKER3_TABLE_RUNS, env_prefix="WORKER3_", tag="-worker3",
        ),
    )


if __name__ == "__main__":
    asyncio.run(main())
