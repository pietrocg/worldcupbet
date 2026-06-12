import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

function makeErrorProxy(msg: string) {
  const handler: ProxyHandler<any> = {
    get() {
      return () => {
        throw new Error(msg);
      };
    }
  };
  return new Proxy({}, handler) as SupabaseClient;
}

// Create the server-side Supabase client only when env vars are present.
// During build (or in some environments) these may be absent; avoid
// throwing at module import time so Next.js can compile pages.
export const supabaseAdmin: SupabaseClient = ((): SupabaseClient => {
  if (!supabaseUrl || !supabaseServiceRole) {
    const msg = 'supabaseUrl or supabaseServiceRole missing. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.';
    // Export a proxy that throws when used at runtime.
    return makeErrorProxy(msg);
  }

  return createClient(supabaseUrl, supabaseServiceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
})();
