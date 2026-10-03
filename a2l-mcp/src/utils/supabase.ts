import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Created lazily so the core A2L tools work without Supabase configured;
// only the study tools (which actually use it) fail when it's missing.
let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Study tools require Supabase: set SUPABASE_URL and (SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY)');
  }
  client ??= createClient(supabaseUrl, supabaseKey);
  return client;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get: (_target, prop) => Reflect.get(getClient(), prop),
});
