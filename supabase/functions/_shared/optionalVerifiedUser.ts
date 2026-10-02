/**
 * Optional verified Customer identity for public pricing Edges
 * (calculate-route, calculate-fare).
 *
 * Route/fare ACCESS stays open exactly as live: anonymous WhatsApp/Guest
 * website, create-guest-payment-intent, service-role and session-less
 * callers are never rejected. This only answers "is there a verified
 * Supabase user?" — the sole identity allowed to own a financial artifact.
 *
 *   no token / anon key / publishable key  → null
 *   service-role key                        → null (never a Customer)
 *   invalid / expired user JWT              → null (no 401)
 *   valid user JWT (auth.getUser)           → user id
 *
 * JWT payloads are never decoded locally; only auth.getUser verifies.
 */
import { bearerToken, requireAuthenticatedUser } from "./edgeAuth.ts";

export type VerifyUserToken = (req: Request) => Promise<string | null>;

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

const verifyWithSupabaseAuth: VerifyUserToken = async (req) => {
  const auth = await requireAuthenticatedUser(
    req,
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  );
  return auth.ok ? auth.userId : null;
};

export async function resolveOptionalVerifiedUserId(
  req: Request,
  verify: VerifyUserToken = verifyWithSupabaseAuth,
): Promise<string | null> {
  const token = bearerToken(req);
  if (!token || !looksLikeJwt(token)) return null;
  if (timingSafeEqual(token, Deno.env.get("SUPABASE_ANON_KEY") ?? "")) return null;
  if (timingSafeEqual(token, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")) return null;
  try {
    return await verify(req);
  } catch {
    return null;
  }
}
