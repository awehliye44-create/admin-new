// deno-lint-ignore-file no-explicit-any
/**
 * Shared loose Supabase client type for Edge functions.
 * The bare `createClient` return type resolves to the generic *defaults*, which are not
 * assignable from an actual `createClient(url, key)` instance — use this alias instead.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export type AnySupabaseClient = SupabaseClient<any, any, any, any, any>;
