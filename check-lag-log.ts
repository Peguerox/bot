import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { getSupabaseAdmin } from "./lib/supabase-admin.js";

const sb = getSupabaseAdmin();
(async () => {
  const { data, error } = await sb
    .from("xlm_purelag_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) { console.error(error); return; }
  for (const r of data ?? []) {
    const t = r.created_at?.slice(0, 19).replace("T", " ");
    console.log(`${t}  ${JSON.stringify(r.log)}`);
  }
})();
