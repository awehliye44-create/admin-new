/**
 * expire-offers → auto-dispatch must use the real service-role credential.
 * Run: deno test --allow-read supabase/functions/_shared/invokeAutoDispatchServiceRoleLock.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildExpireOffersAutoDispatchLog,
  classifyAutoDispatchResponse,
  EXPIRE_OFFERS_AUTO_DISPATCH_SOURCE,
  invokeAutoDispatchWithServiceRole,
  redactSecrets,
  serviceRoleInvokeHeaders,
} from "./invokeAutoDispatchServiceRole.ts";

const SERVICE_ROLE = "test-service-role-key-not-for-production";
const ANON_FALLBACK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon-fallback-must-never-be-sent";

Deno.test("service-role headers use SUPABASE_SERVICE_ROLE_KEY, never anon/fallback JWT", () => {
  const headers = serviceRoleInvokeHeaders(SERVICE_ROLE);
  assertEquals(headers.Authorization, `Bearer ${SERVICE_ROLE}`);
  assertEquals(headers.apikey, SERVICE_ROLE);
  assertEquals(headers.Authorization.includes(ANON_FALLBACK), false);
});

Deno.test("invoke posts to auto-dispatch with explicit service-role Bearer", async () => {
  let seenUrl = "";
  let seenAuth = "";
  let seenApiKey = "";
  let seenForceRebroadcast: unknown = null;
  let seenTriggerReason: unknown = null;

  const result = await invokeAutoDispatchWithServiceRole({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: SERVICE_ROLE,
    body: {
      trip_id: "41350aaf-40c3-44af-8557-e7b522ffcb71",
      force_rebroadcast: true,
      trigger_reason: "offer_expired",
      reason_for_next_wave: "offer_expired",
    },
    tripContext: {
      tripId: "41350aaf-40c3-44af-8557-e7b522ffcb71",
      publicTripId: "MK-260815-005",
      currentSequence: 1,
      ttlDeadline: "2026-08-15T10:00:00.000Z",
    },
    fetchImpl: ((url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      const headers = new Headers(init?.headers);
      seenAuth = headers.get("Authorization") ?? "";
      seenApiKey = headers.get("apikey") ?? "";
      const parsed = JSON.parse(String(init?.body ?? "{}"));
      seenForceRebroadcast = parsed.force_rebroadcast;
      seenTriggerReason = parsed.trigger_reason;
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, offers_created: 2, trip_id: "t1" }), {
          status: 200,
        }),
      );
    }) as typeof fetch,
  });

  assertEquals(seenUrl, "https://example.supabase.co/functions/v1/auto-dispatch");
  assertEquals(seenAuth, `Bearer ${SERVICE_ROLE}`);
  assertEquals(seenApiKey, SERVICE_ROLE);
  assertEquals(seenForceRebroadcast, true);
  assertEquals(seenTriggerReason, "offer_expired");
  assertEquals(result.ok, true);
  assertEquals(result.outcome, "successful_dispatch");
  assertEquals(result.httpStatus, 200);
});

Deno.test("classifies authentication, TTL, no-candidates, success, and idempotent outcomes", () => {
  assertEquals(
    classifyAutoDispatchResponse({
      httpStatus: 401,
      body: { success: false, error: "UNAUTHORIZED", message: "Service-role authorization required" },
    }),
    "authentication_rejection",
  );
  assertEquals(
    classifyAutoDispatchResponse({
      httpStatus: 400,
      body: { success: false, error: "SEARCH_WINDOW_ENDED", message: "Customer search window ended before next wave" },
    }),
    "ttl_expired",
  );
  assertEquals(
    classifyAutoDispatchResponse({
      httpStatus: 422,
      body: { success: false, error: "VEHICLE_TYPE_MISSING" },
    }),
    "non_dispatchable",
  );
  assertEquals(
    classifyAutoDispatchResponse({
      httpStatus: 200,
      body: { success: true, message: "No drivers available, waiting for next round", offers_created: 0 },
    }),
    "no_candidates",
  );
  assertEquals(
    classifyAutoDispatchResponse({
      httpStatus: 200,
      body: { success: true, offers_created: 3 },
    }),
    "successful_dispatch",
  );
  assertEquals(
    classifyAutoDispatchResponse({
      httpStatus: 200,
      body: { success: true, message: "Trip already offered" },
    }),
    "idempotent_noop",
  );
});

Deno.test("non-2xx log includes trip ids, status, source, sequence, wave, TTL — never the token", () => {
  const log = buildExpireOffersAutoDispatchLog({
    tripContext: {
      tripId: "41350aaf-40c3-44af-8557-e7b522ffcb71",
      publicTripId: "MK-260815-005",
      currentSequence: 1,
      ttlDeadline: "2026-08-15T10:00:00.000Z",
    },
    httpStatus: 401,
    body: {
      success: false,
      error: "UNAUTHORIZED",
      message: "Service-role authorization required",
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
    outcome: "authentication_rejection",
    source: EXPIRE_OFFERS_AUTO_DISPATCH_SOURCE,
  });

  assertEquals(log.invocation_source, "expire-offers");
  assertEquals(log.trip_id, "41350aaf-40c3-44af-8557-e7b522ffcb71");
  assertEquals(log.public_trip_id, "MK-260815-005");
  assertEquals(log.http_status, 401);
  assertEquals(log.error_code, "UNAUTHORIZED");
  assertEquals(log.current_dispatch_sequence, 1);
  assertEquals(log.current_dispatch_round, 1);
  assertEquals(log.current_dispatch_wave, 1);
  assertEquals(log.ttl_deadline, "2026-08-15T10:00:00.000Z");
  const serialized = JSON.stringify(log);
  assertEquals(serialized.includes(SERVICE_ROLE), false);
  assertEquals(serialized.includes("Bearer [REDACTED]"), false);
  const body = log.response_body as Record<string, unknown>;
  assertEquals(body.Authorization, "[REDACTED]");
});

Deno.test("redactSecrets strips JWTs and Authorization values", () => {
  const redacted = redactSecrets({
    Authorization: `Bearer ${ANON_FALLBACK}`,
    note: `token=${ANON_FALLBACK}`,
  }) as Record<string, unknown>;
  assertEquals(redacted.Authorization, "[REDACTED]");
  assertEquals(String(redacted.note).includes(ANON_FALLBACK), false);
});

Deno.test("auto-dispatch still requires exact service-role and is not public", async () => {
  const autoDispatch = await Deno.readTextFile(
    new URL("../auto-dispatch/index.ts", import.meta.url),
  );
  const edgeAuth = await Deno.readTextFile(
    new URL("./edgeAuth.ts", import.meta.url),
  );
  assertEquals(autoDispatch.includes("requireServiceRole(req, supabaseKey)"), true);
  assertEquals(edgeAuth.includes("Service-role authorization required"), true);
  assertEquals(autoDispatch.includes("verify_jwt = false"), false);
});

Deno.test("expire-offers caller uses the service-role helper and does not inherit cron JWT", async () => {
  const expire = await Deno.readTextFile(
    new URL("../expire-offers/index.ts", import.meta.url),
  );
  assertEquals(expire.includes("invokeAutoDispatchWithServiceRole"), true);
  assertEquals(expire.includes("functions.invoke(\n          \"auto-dispatch\""), false);
  assertEquals(expire.includes('functions.invoke("auto-dispatch"'), false);
  assertEquals(expire.includes("current_broadcast_round + 1"), false);
  assertEquals(expire.includes("dispatch_wave + 1"), false);
});

Deno.test("expire_offers_sweep uses vault cron_edge_auth_token, not hardcoded anon JWT", async () => {
  const sweep = await Deno.readTextFile(
    new URL("../../migrations/20260924120000_expire_offers_sweep_service_role_auth.sql", import.meta.url),
  );
  assert(sweep.includes("public.cron_edge_auth_token()"));
  assertEquals(sweep.includes("SUPABASE_ANON_KEY"), false);
  assertEquals(sweep.includes("app.settings.supabase_anon_key"), false);
  assertEquals(sweep.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), false);
  assertEquals(sweep.includes("max_dispatch_rounds"), false);
});
