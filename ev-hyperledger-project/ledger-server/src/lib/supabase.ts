import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// SUPABASE CONFIG WITH CONNECTION POOLING
// ============================================================================

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// For direct Postgres access with pooling (optional, for raw SQL)
const supabasePooledUrl = process.env.SUPABASE_POOLED_URL; // postgres://...pooler.supabase.com:6543/postgres

if (!supabaseUrl) throw new Error("Missing SUPABASE_URL");
if (!supabaseServiceRoleKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

// Main Supabase client (uses REST API - already efficient)
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { 
    persistSession: false, 
    autoRefreshToken: false 
  },
  db: {
    schema: 'public',
  },
  global: {
    headers: {
      'x-connection-pool': 'true', // Hint to use pooling
    },
  },
});

// ============================================================================
// // OPTIONAL: Direct Postgres Pool (for raw SQL queries)
// // ============================================================================
// // Only needed if you want to run raw SQL for complex queries

// import { Pool } from 'pg';

// let pgPool: Pool | null = null;

// export function getPgPool(): Pool {
//   if (!pgPool && supabasePooledUrl) {
//     pgPool = new Pool({
//       connectionString: supabasePooledUrl,
//       max: 20,              // Max connections in pool
//       idleTimeoutMillis: 30000,
//       connectionTimeoutMillis: 2000,
//     });
    
//     pgPool.on('error', (err) => {
//       console.error('Postgres pool error:', err);
//     });
//   }
  
//   if (!pgPool) {
//     throw new Error("SUPABASE_POOLED_URL not configured");
//   }
  
//   return pgPool;
// }

// // Example usage:
// // const pool = getPgPool();
// // const result = await pool.query('SELECT * FROM charging_sessions WHERE session_id = $1', [sessionId]);