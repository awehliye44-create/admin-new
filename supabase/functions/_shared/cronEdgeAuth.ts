/**
 * Auth for pg_cron / internal edge sweeps — never accept anon or unverified JWT payloads.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
};

function unauthorized(message = "Unauthorized"): Response {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status: 401,
    headers: JSON_HEADERS,
  });
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return token || null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function matchesConfiguredSecret(token: string): boolean {
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  if (cronSecret.length >= 20 && timingSafeEqual(token, cronSecret)) return true;

  const internalSecret = Deno.env.get("ONECAB_INTERNAL_FINALIZE_SECRET") ?? "";
  if (internalSecret.length >= 20 && timingSafeEqual(token, internalSecret)) return true;

  return false;
}

/** Supabase Auth validates the JWT/API key when calling admin endpoints. */
async function tokenHasServiceRoleAccess(token: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return false;

  const client = createClient(url, token, { auth: { persistSession: false } });
  const { error } = await client.auth.admin.listUsers({ page: 1, perPage: 1 });
  return !error;
}

export type CronAuthResult =
  | { ok: true; source: "cron_secret" | "service_role_key" | "service_role_jwt" }
  | { ok: false; response: Response };

/**
 * Allow:
 * - CRON_SECRET / ONECAB_INTERNAL_FINALIZE_SECRET (Bearer, x-onecab-cron-secret, or body.cron_secret)
 * - SUPABASE_SERVICE_ROLE_KEY exact match (edge env)
 * - Any bearer that passes auth.admin.listUsers (verified service_role JWT)
 *
 * Reject anon and forged JWTs.
 */
export async function assertCronOrServiceRoleAuth(
  req: Request,
  body?: Record<string, unknown>,
): Promise<CronAuthResult> {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  const bearer = extractBearerToken(req);
  const headerSecret = req.headers.get("x-onecab-cron-secret")?.trim() ?? "";
  const bodySecret = typeof body?.cron_secret === "string" ? body.cron_secret.trim() : "";

  const secretCandidates = [bearer, headerSecret, bodySecret].filter(Boolean) as string[];

  for (const candidate of secretCandidates) {
    if (anonKey && timingSafeEqual(candidate, anonKey)) {
      return { ok: false, response: unauthorized() };
    }
    if (matchesConfiguredSecret(candidate)) {
      return { ok: true, source: "cron_secret" };
    }
    if (serviceRoleKey && timingSafeEqual(candidate, serviceRoleKey)) {
      return { ok: true, source: "service_role_key" };
    }
  }

  if (bearer) {
    if (anonKey && timingSafeEqual(bearer, anonKey)) {
      return { ok: false, response: unauthorized() };
    }
    if (await tokenHasServiceRoleAccess(bearer)) {
      return { ok: true, source: "service_role_jwt" };
    }
  }

  return { ok: false, response: unauthorized() };
}

export const cronAuthCorsHeaders = JSON_HEADERS;
