import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Paper-only -- no real position to protect, so this just flips the switch the embedded
// lit_grid_paper.py task reads every tick (see lighter_lit_grid_paper_schema.sql).
export async function POST() {
  const sb = getSupabaseAdmin();
  const { data: current, error: readError } = await sb
    .from("lighter_lit_grid_state")
    .select("enabled")
    .eq("id", 1)
    .single();
  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  const next = !current?.enabled;
  const { data: updated, error: writeError } = await sb
    .from("lighter_lit_grid_state")
    .update({ enabled: next })
    .eq("id", 1)
    .select("enabled")
    .single();
  if (writeError) {
    return NextResponse.json({ error: writeError.message }, { status: 500 });
  }
  if (updated?.enabled !== next) {
    return NextResponse.json({ error: "Toggle did not take effect." }, { status: 500 });
  }
  return NextResponse.json({ enabled: next });
}
