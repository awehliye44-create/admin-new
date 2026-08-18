/**
 * Forged-token + cryptographic auth lock for admin-recover-captured-trip-wallet.
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/admin-recover-captured-trip-wallet/adminRecoverCapturedTripWalletAuthLock.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import type { GateResult } from "../_shared/adminPaymentGate.ts";
import { jsonResponse } from "../_shared/adminPaymentGate.ts";
import { handleAdminRecoverCapturedTripWallet } from "./handler.ts";
import {
  authenticateRecoverBearer,
  extractBearerToken,
  PRODUCTION_PROJECT_REF,
  secretsEqual,
  signHs256Jwt,
  verifyHs256Jwt,
} from "./recoverAuth.ts";

const TRIP_002 = "3a575bad-ce3d-491e-998a-cd83fa5256ea";
const TRIP_003 = "7ada43fa-1f3d-43e8-979b-6152ba9d5f2c";
const PROJECT_SECRET = "project-jwt-secret-for-recovery-auth-tests";
const ATTACKER_SECRET = "attacker-controlled-hmac-secret";
const SERVICE_KEY = "service-role-env-secret-value";
const NOW_MS = Date.parse("2026-08-18T15:00:00.000Z");
const FUTURE_EXP = Math.floor(NOW_MS / 1000) + 3600;
const PAST_EXP = Math.floor(NOW_MS / 1000) - 60;

const CRYPTO = {
  serviceRoleKey: SERVICE_KEY,
  anonKey: "anon-env-key",
  jwtSecret: PROJECT_SECRET,
  projectRef: PRODUCTION_PROJECT_REF,
  nowMs: NOW_MS,
};

function servicePayload(overrides: Record<string, unknown> = {}) {
  return {
    iss: "supabase",
    ref: PRODUCTION_PROJECT_REF,
    role: "service_role",
    iat: Math.floor(NOW_MS / 1000) - 10,
    exp: FUTURE_EXP,
    ...overrides,
  };
}

function jsonRequest(body: unknown, bearer?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer !== undefined) {
    headers.Authorization = bearer.startsWith("Bearer ") || bearer === "Bearer"
      ? bearer
      : `Bearer ${bearer}`;
  }
  return new Request("https://example.supabase.co/functions/v1/admin-recover-captured-trip-wallet", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function authorizeFromCrypto(
  req: Request,
  users?: {
    getUser?: (token: string) => Promise<{ id: string } | null>;
    loadSuperAdmin?: (userId: string) => Promise<boolean>;
    platformVerifyServiceRoleJwt?: (token: string) => Promise<boolean>;
  },
): Promise<GateResult | { ok: false; response: Response }> {
  const auth = await authenticateRecoverBearer(extractBearerToken(req), CRYPTO, {
    getUser: users?.getUser ?? (async () => null),
    loadSuperAdmin: users?.loadSuperAdmin ?? (async () => false),
    platformVerifyServiceRoleJwt: users?.platformVerifyServiceRoleJwt,
  });
  if (!auth.ok) {
    return { ok: false, response: jsonResponse({ success: false, error: auth.error, code: auth.code }, auth.status) };
  }
  return { ok: true, supabase: {} as GateResult["supabase"], userId: auth.userId };
}

async function invokeForged(bearer: string, extraBody: Record<string, unknown> = {}) {
  let recoverCalls = 0;
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003], dry_run: true, ...extraBody }, bearer),
    {
      authorize: (req) => authorizeFromCrypto(req),
      recover: async () => {
        recoverCalls += 1;
        throw new Error("recover must not be called");
      },
    },
  );
  return { res, recoverCalls };
}

Deno.test("unsigned JWT with role=service_role is rejected; recover never called", async () => {
  const token = `${b64url({ alg: "none", typ: "JWT" })}.${b64url(servicePayload())}.`;
  const { res, recoverCalls } = await invokeForged(token);
  assertEquals(res.status === 401 || res.status === 403, true);
  assertEquals(recoverCalls, 0);
});

Deno.test("JWT signed with an attacker-controlled secret is rejected; recover never called", async () => {
  const token = await signHs256Jwt(servicePayload(), ATTACKER_SECRET);
  const { res, recoverCalls } = await invokeForged(token);
  assertEquals(res.status === 401 || res.status === 403, true);
  assertEquals(recoverCalls, 0);
});

Deno.test("valid-looking service_role + correct ref but invalid signature is rejected", async () => {
  const good = await signHs256Jwt(servicePayload(), PROJECT_SECRET);
  const parts = good.split(".");
  const token = `${parts[0]}.${parts[1]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  assertEquals(await verifyHs256Jwt(token, PROJECT_SECRET), null);
  const { res, recoverCalls } = await invokeForged(token);
  assertEquals(res.status === 401 || res.status === 403, true);
  assertEquals(recoverCalls, 0);
});

Deno.test("expired token is rejected; recover never called", async () => {
  const token = await signHs256Jwt(servicePayload({ exp: PAST_EXP }), PROJECT_SECRET);
  const { res, recoverCalls } = await invokeForged(token);
  assertEquals(res.status === 401 || res.status === 403, true);
  assertEquals(recoverCalls, 0);
});

Deno.test("wrong issuer is rejected; recover never called", async () => {
  const token = await signHs256Jwt(servicePayload({ iss: "https://attacker.example" }), PROJECT_SECRET);
  const { res, recoverCalls } = await invokeForged(token);
  assertEquals(res.status === 401 || res.status === 403, true);
  assertEquals(recoverCalls, 0);
});

Deno.test("wrong audience is rejected; recover never called", async () => {
  const token = await signHs256Jwt(servicePayload({ aud: "https://attacker.example" }), PROJECT_SECRET);
  const { res, recoverCalls } = await invokeForged(token);
  assertEquals(res.status === 401 || res.status === 403, true);
  assertEquals(recoverCalls, 0);
});

Deno.test("wrong project ref is rejected; recover never called", async () => {
  const token = await signHs256Jwt(servicePayload({ ref: "otherprojectref12xxxx" }), PROJECT_SECRET);
  const { res, recoverCalls } = await invokeForged(token);
  assertEquals(res.status === 401 || res.status === 403, true);
  assertEquals(recoverCalls, 0);
});

Deno.test("ordinary user JWT with payload role mutated to super_admin is rejected", async () => {
  const validUser = await signHs256Jwt({
    iss: `https://${PRODUCTION_PROJECT_REF}.supabase.co/auth/v1`,
    ref: PRODUCTION_PROJECT_REF,
    role: "authenticated",
    sub: "11111111-1111-4111-8111-111111111111",
    aud: "authenticated",
    exp: FUTURE_EXP,
  }, PROJECT_SECRET);
  const parts = validUser.split(".");
  const tampered = `${parts[0]}.${b64url({
    iss: `https://${PRODUCTION_PROJECT_REF}.supabase.co/auth/v1`,
    ref: PRODUCTION_PROJECT_REF,
    role: "super_admin",
    sub: "11111111-1111-4111-8111-111111111111",
    aud: "authenticated",
    exp: FUTURE_EXP,
  })}.${parts[2]}`;
  assertEquals(await verifyHs256Jwt(tampered, PROJECT_SECRET), null);

  let recoverCalls = 0;
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003], dry_run: true }, tampered),
    {
      authorize: (req) => authorizeFromCrypto(req, {
        getUser: async () => null,
        loadSuperAdmin: async () => true,
      }),
      recover: async () => {
        recoverCalls += 1;
        throw new Error("recover must not be called");
      },
    },
  );
  assertEquals(res.status === 401 || res.status === 403, true);
  assertEquals(recoverCalls, 0);
});

Deno.test("request body actor_admin_uuid/role cannot mint Super Admin; recover never called", async () => {
  let recoverCalls = 0;
  const userToken = await signHs256Jwt({
    iss: `https://${PRODUCTION_PROJECT_REF}.supabase.co/auth/v1`,
    role: "authenticated",
    sub: "22222222-2222-4222-8222-222222222222",
    exp: FUTURE_EXP,
  }, PROJECT_SECRET);
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({
      trip_ids: [TRIP_002, TRIP_003],
      dry_run: true,
      role: "super_admin",
      actor_admin_uuid: "22222222-2222-4222-8222-222222222222",
    }, userToken),
    {
      authorize: (req) => authorizeFromCrypto(req, {
        getUser: async () => ({ id: "22222222-2222-4222-8222-222222222222" }),
        loadSuperAdmin: async () => false,
      }),
      recover: async () => {
        recoverCalls += 1;
        throw new Error("recover must not be called");
      },
    },
  );
  assertEquals(res.status === 401 || res.status === 403, true);
  assertEquals(recoverCalls, 0);
});

Deno.test("malformed bearer token is rejected; recover never called", async () => {
  for (const bearer of ["Bearer", "Bearer ", "Token abc", "Bearer not-a-jwt", "Bearer a.b"]) {
    const { res, recoverCalls } = await invokeForged(bearer);
    assertEquals(res.status === 401 || res.status === 403, true, bearer);
    assertEquals(recoverCalls, 0, bearer);
  }
});

Deno.test("method A: exact service-role env secret is accepted", async () => {
  let recoverCalls = 0;
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003], dry_run: true }, SERVICE_KEY),
    {
      authorize: (req) => authorizeFromCrypto(req),
      recover: async (_sb, args) => {
        recoverCalls += 1;
        return {
          tripId: args.tripId,
          tripCode: args.tripId === TRIP_002 ? "MK-260818-002" : "MK-260818-003",
          dryRun: true,
          status: "DRY_RUN_ELIGIBLE" as const,
          expected_credit_pence: 425,
          session_status: "captured",
          payment_session_id: "ps",
          provider_capture_id: "cap",
          provider_order_id: "ord",
          driver_id: "d",
          existing_wallet_count: 0,
          existing_wallet_amount_pence: 0,
          proposed_ledger_type: "TRIP_EARNING_NET" as const,
          proposed_amount_pence: 425,
          currency: "GBP",
          proposed_related_trip_id: args.tripId,
          proposed_description: "x",
          captured_at: null,
          eligible_at: null,
          eligibility_classification: "Pending" as const,
          provider_operation_required: false as const,
          settlement_recalculation_required: false as const,
        };
      },
    },
  );
  assertEquals(res.status, 200);
  assertEquals(recoverCalls, 2);
});

Deno.test("method B: HS256-verified service_role JWT is accepted", async () => {
  const token = await signHs256Jwt(servicePayload(), PROJECT_SECRET);
  const auth = await authenticateRecoverBearer(token, CRYPTO, {
    getUser: async () => null,
    loadSuperAdmin: async () => false,
  });
  assertEquals(auth.ok, true);
  if (auth.ok) assertEquals(auth.userId, "service-role");
});

Deno.test("Super Admin requires Auth getUser UUID + DB super_admin, not JWT role claim", async () => {
  const userToken = await signHs256Jwt({
    iss: `https://${PRODUCTION_PROJECT_REF}.supabase.co/auth/v1`,
    role: "authenticated",
    sub: "33333333-3333-4333-8333-333333333333",
    exp: FUTURE_EXP,
  }, PROJECT_SECRET);
  const denied = await authenticateRecoverBearer(userToken, CRYPTO, {
    getUser: async () => ({ id: "33333333-3333-4333-8333-333333333333" }),
    loadSuperAdmin: async () => false,
  });
  assertEquals(denied.ok, false);

  const allowed = await authenticateRecoverBearer(userToken, CRYPTO, {
    getUser: async () => ({ id: "33333333-3333-4333-8333-333333333333" }),
    loadSuperAdmin: async (id) => id === "33333333-3333-4333-8333-333333333333",
  });
  assertEquals(allowed.ok, true);
  if (allowed.ok) assertEquals(allowed.userId, "33333333-3333-4333-8333-333333333333");
});

Deno.test("platform probe success still cannot skip claim checks; unsigned JWT is not service-role", async () => {
  const unsigned = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(servicePayload())}.`;
  const auth = await authenticateRecoverBearer(unsigned, { ...CRYPTO, jwtSecret: "" }, {
    getUser: async () => null,
    loadSuperAdmin: async () => false,
    platformVerifyServiceRoleJwt: async () => true,
  });
  assertEquals(auth.ok, false);
});

Deno.test("secretsEqual is true only for identical secrets", async () => {
  assertEquals(await secretsEqual(SERVICE_KEY, SERVICE_KEY), true);
  assertEquals(await secretsEqual(SERVICE_KEY, SERVICE_KEY + "x"), false);
  assertEquals(await secretsEqual("", SERVICE_KEY), false);
});

Deno.test("auth source never authorizes from unverified role/ref claims", async () => {
  const src = await Deno.readTextFile(new URL("./recoverAuth.ts", import.meta.url));
  assert(src.includes("crypto.subtle.verify"));
  assert(src.includes("secretsEqual"));
  assertEquals(src.includes("isServiceRoleJwt"), false);
  assert(src.includes('alg !== "HS256"'));
});
