import { createClient, SupabaseClient } from "@supabase/supabase-js";
//supabase with pooling
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabasePooledUrl = process.env.SUPABASE_POOLED_URL;

if (!supabaseUrl) throw new Error("Missing SUPABASE_URL");
if (!supabaseServiceRoleKey)
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

export const supabase: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceRoleKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema: "public",
    },
    global: {
      headers: {
        "x-connection-pool": "true",
      },
    },
  }
);
