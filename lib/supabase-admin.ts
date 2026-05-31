import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

let _admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        realtime: { transport: ws as never },
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );
  }
  return _admin;
}
