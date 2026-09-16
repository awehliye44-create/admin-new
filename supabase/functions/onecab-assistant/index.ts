/**
 * ONECAB Assistant — central Edge Function entrypoint.
 *
 * Deployed in the central ONECAB production backend and shared by all ONECAB
 * platforms (website today; customer_app / driver_app / corporate_portal once
 * their authenticated policies exist).
 *
 * Secrets used (Edge Function secrets only, never exposed to any client):
 *   OPENAI_API_KEY                    — official OpenAI Responses API
 *   ONECAB_ASSISTANT_SESSION_SECRET   — HMAC secret for session tokens / IP hashes
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — platform-provided
 */

import { createHandler, corsHeaders } from "./handler.ts";
import { createAssistantDb } from "./db.ts";
import { createCustomerAuthenticator } from "./customerAssistantRuntime.ts";
import { createDriverAuthenticator } from "./driverAssistantRuntime.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async (req) => {
  if (!url || !serviceRoleKey) {
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
    return new Response(JSON.stringify({ error: "assistant_unconfigured", reply: null, handoff: true }), {
      status: 503,
      headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
    });
  }

  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const handler = createHandler({
    env: (key) => Deno.env.get(key),
    fetch: globalThis.fetch,
    db: createAssistantDb(url, serviceRoleKey),
    authenticateDriver: createDriverAuthenticator(admin),
    authenticateCustomer: createCustomerAuthenticator(admin),
  });

  return handler(req);
});
