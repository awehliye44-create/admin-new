/**
 * Cryptographic authorization for admin-recover-mk007-mk009-wallet.
 *
 * Service-role is allowed only via:
 *   A. constant-time compare of the bearer token to SUPABASE_SERVICE_ROLE_KEY, or
 *   B. HS256 signature verification with the project JWT secret / platform Auth admin probe,
 *      then issuer + ref + role + expiry checks on the verified payload.
 *
 * Super Admin is allowed only via Supabase Auth getUser (signature verified by Auth)
 * plus a live staff_profiles / user_roles lookup of super_admin.
 *
 * Decoded role/ref without signature verification is forbidden.
 */

export const PRODUCTION_PROJECT_REF = "thazislrdkjpvvghtvzo";
export const SERVICE_ROLE_USER_ID = "service-role";

export const FORBIDDEN_AUTH_BODY_KEYS = ["role", "actor_admin_uuid"] as const;

export type RecoverAuthSuccess = {
  ok: true;
  userId: string;
};

export type RecoverAuthFailure = {
  ok: false;
  status: 401 | 403;
  error: string;
  code: string;
};

export type RecoverAuthResult = RecoverAuthSuccess | RecoverAuthFailure;

export type RecoverAuthCrypto = {
  serviceRoleKey: string;
  anonKey?: string;
  jwtSecret: string;
  projectRef: string;
  nowMs?: number;
  expectedIssuers?: string[];
  /** If the verified JWT has an aud claim, it must be one of these. Absent aud is allowed (legacy service_role keys). */
  allowedAudiences?: string[];
};

export type RecoverAuthUserLookup = {
  getUser: (token: string) => Promise<{ id: string } | null>;
  loadSuperAdmin: (userId: string) => Promise<boolean>;
  /** Platform cryptographic probe (GoTrue admin API) — only used when jwtSecret is empty. */
  platformVerifyServiceRoleJwt?: (token: string) => Promise<boolean>;
};

export function extractBearerToken(req: Request): string | null {
  const raw = req.headers.get("Authorization");
  if (raw == null) return null;
  if (!/^Bearer\s+/i.test(raw)) return null;
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 ? token : null;
}

/** Constant-time string compare via SHA-256 digests (equal-length 32-byte XOR). */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`recover-auth\0${a}`)));
  const hb = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`recover-auth\0${b}`)));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

function base64UrlToBytes(input: string): Uint8Array | null {
  try {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (input.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseJsonPart(part: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(part);
  if (!bytes) return null;
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function signHs256Jwt(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): Promise<string> {
  const enc = new TextEncoder();
  const headerPart = bytesToBase64Url(enc.encode(JSON.stringify(header)));
  const payloadPart = bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(`${headerPart}.${payloadPart}`)),
  );
  return `${headerPart}.${payloadPart}.${bytesToBase64Url(sig)}`;
}

/** HS256 verify only. Rejects alg=none and any non-HS256 header. */
export async function verifyHs256Jwt(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const header = parseJsonPart(parts[0]);
  if (!header) return null;
  const alg = String(header.alg ?? "").toUpperCase();
  if (alg !== "HS256") return null;

  const sig = base64UrlToBytes(parts[2]);
  if (!sig || sig.length === 0) return null;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sig as BufferSource,
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  return parseJsonPart(parts[1]);
}

export function assertVerifiedServiceRoleClaims(
  payload: Record<string, unknown>,
  crypto: RecoverAuthCrypto,
): RecoverAuthFailure | null {
  const nowSec = Math.floor((crypto.nowMs ?? Date.now()) / 1000);
  const projectRef = crypto.projectRef;
  const issuers = crypto.expectedIssuers ?? [
    "supabase",
    `https://${projectRef}.supabase.co/auth/v1`,
  ];

  if (String(payload.role ?? "") !== "service_role") {
    return { ok: false, status: 403, error: "Forbidden", code: "INVALID_ROLE" };
  }
  if (String(payload.ref ?? "") !== projectRef) {
    return { ok: false, status: 401, error: "Unauthorized", code: "INVALID_PROJECT_REF" };
  }
  if (!issuers.includes(String(payload.iss ?? ""))) {
    return { ok: false, status: 401, error: "Unauthorized", code: "INVALID_ISSUER" };
  }
  if (payload.exp != null && !(Number(payload.exp) > nowSec)) {
    return { ok: false, status: 401, error: "Unauthorized", code: "TOKEN_EXPIRED" };
  }
  if (payload.nbf != null && Number(payload.nbf) > nowSec) {
    return { ok: false, status: 401, error: "Unauthorized", code: "TOKEN_NOT_YET_VALID" };
  }
  if (payload.aud != null && payload.aud !== "") {
    const audiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud)];
    const allowed = crypto.allowedAudiences ?? [];
    if (audiences.length === 0 || audiences.some((a) => !allowed.includes(a))) {
      return { ok: false, status: 401, error: "Unauthorized", code: "INVALID_AUDIENCE" };
    }
  }
  return null;
}

export async function authenticateRecoverBearer(
  token: string | null,
  crypto: RecoverAuthCrypto,
  users?: RecoverAuthUserLookup,
): Promise<RecoverAuthResult> {
  if (!token) {
    return { ok: false, status: 401, error: "Unauthorized", code: "MISSING_BEARER" };
  }

  const anonKey = crypto.anonKey ?? "";
  if (anonKey && await secretsEqual(token, anonKey)) {
    return { ok: false, status: 401, error: "Unauthorized", code: "ANON_REJECTED" };
  }

  if (crypto.serviceRoleKey && await secretsEqual(token, crypto.serviceRoleKey)) {
    return { ok: true, userId: SERVICE_ROLE_USER_ID };
  }

  const locallyVerified = crypto.jwtSecret
    ? await verifyHs256Jwt(token, crypto.jwtSecret)
    : null;
  if (locallyVerified && String(locallyVerified.role ?? "") === "service_role") {
    const claimErr = assertVerifiedServiceRoleClaims(locallyVerified, crypto);
    if (claimErr) return claimErr;
    return { ok: true, userId: SERVICE_ROLE_USER_ID };
  }

  if (!locallyVerified && !crypto.jwtSecret && users?.platformVerifyServiceRoleJwt) {
    const platformOk = await users.platformVerifyServiceRoleJwt(token);
    if (platformOk) {
      const parts = token.split(".");
      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        return { ok: false, status: 401, error: "Unauthorized", code: "UNVERIFIED_CLAIMS" };
      }
      const payload = parseJsonPart(parts[1]);
      if (!payload) {
        return { ok: false, status: 401, error: "Unauthorized", code: "UNVERIFIED_CLAIMS" };
      }
      const claimErr = assertVerifiedServiceRoleClaims(payload, crypto);
      if (claimErr) return claimErr;
      return { ok: true, userId: SERVICE_ROLE_USER_ID };
    }
  }

  if (!users) {
    return { ok: false, status: 401, error: "Unauthorized", code: "UNAUTHENTICATED" };
  }

  const user = await users.getUser(token);
  if (!user?.id) {
    return { ok: false, status: 401, error: "Unauthorized", code: "UNAUTHENTICATED" };
  }
  const isSuperAdmin = await users.loadSuperAdmin(user.id);
  if (!isSuperAdmin) {
    return { ok: false, status: 403, error: "Forbidden — Super Admin or service-role required", code: "NOT_SUPER_ADMIN" };
  }
  return { ok: true, userId: user.id };
}
