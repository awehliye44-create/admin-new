import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function authFailure(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ success: false, error: code, message }), {
    status,
    headers: JSON_HEADERS,
  });
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization")?.trim() ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let mismatch = leftHash.length ^ rightHash.length;
  const length = Math.max(leftHash.length, rightHash.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (leftHash[i] ?? 0) ^ (rightHash[i] ?? 0);
  }
  return mismatch === 0;
}

/** Require the exact service-role JWT even if a gateway setting regresses. */
export async function requireServiceRole(
  req: Request,
  serviceRoleKey: string | undefined,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  if (!serviceRoleKey) {
    return {
      ok: false,
      response: authFailure("SERVER_AUTH_MISCONFIGURED", "Internal authentication is unavailable", 500),
    };
  }

  const token = bearerToken(req);
  if (!token || !(await constantTimeEqual(token, serviceRoleKey))) {
    return {
      ok: false,
      response: authFailure("UNAUTHORIZED", "Service-role authorization required", 401),
    };
  }

  return { ok: true };
}

/** Verify a real Supabase user session. Never decode JWT payloads locally. */
export async function requireAuthenticatedUser(
  req: Request,
  supabaseUrl: string,
  anonKey: string,
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const token = bearerToken(req);
  if (!token) {
    return {
      ok: false,
      response: authFailure("UNAUTHORIZED", "Missing authorization header", 401),
    };
  }

  try {
    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user?.id) {
      return {
        ok: false,
        response: authFailure("UNAUTHORIZED", "Invalid or expired token", 401),
      };
    }
    return { ok: true, userId: data.user.id };
  } catch (error) {
    console.warn("[edge-auth] user verification failed", error);
    return {
      ok: false,
      response: authFailure("UNAUTHORIZED", "Invalid or expired token", 401),
    };
  }
}
