/**
 * HTTP + authorization lock for admin-recover-captured-trip-wallet.
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/admin-recover-captured-trip-wallet/adminRecoverCapturedTripWalletHttpLock.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import type { GateResult } from "../_shared/adminPaymentGate.ts";
import {
  APPROVED_CAPTURED_TRIP_WALLET_RECOVERY_TRIP_IDS,
} from "../_shared/capturedTripWalletRecovery.ts";
import {
  classifyRecoverAuthorization,
  EXECUTE_CONFIRMATION,
  handleAdminRecoverCapturedTripWallet,
} from "./handler.ts";

const TRIP_002 = "3a575bad-ce3d-491e-998a-cd83fa5256ea";
const TRIP_003 = "7ada43fa-1f3d-43e8-979b-6152ba9d5f2c";
const TRIP_001 = "229223e3-c100-495d-afd8-2c39a3acf6b2";

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.supabase.co/functions/v1/admin-recover-captured-trip-wallet", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function allowGate(userId = "service-role"): GateResult {
  return { ok: true, supabase: {} as GateResult["supabase"], userId };
}

function deny(status: number, error: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: new Response(JSON.stringify({ success: false, error }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

function eligibleRow(tripId: string, code: string) {
  return {
    tripId,
    tripCode: code,
    dryRun: true,
    status: "DRY_RUN_ELIGIBLE" as const,
    expected_credit_pence: 425,
    session_status: "captured",
    payment_session_id: `ps-${code}`,
    provider_capture_id: `cap-${code}`,
    provider_order_id: `order-${code}`,
    driver_id: "driver-1",
    existing_wallet_count: 0,
    existing_wallet_amount_pence: 0,
    proposed_ledger_type: "TRIP_EARNING_NET" as const,
    proposed_amount_pence: 425,
    currency: "GBP",
    proposed_related_trip_id: tripId,
    proposed_description: "Trip earning (net of 15% commission)",
    captured_at: "2026-08-18T10:52:08.848Z",
    eligible_at: "2026-08-19T13:52:08.848Z",
    eligibility_classification: "Pending" as const,
    provider_operation_required: false as const,
    settlement_recalculation_required: false as const,
  };
}

Deno.test("auth matrix: anonymous / customer / driver / admin blocked; Super Admin and service-role allowed", () => {
  assertEquals(classifyRecoverAuthorization({
    hasBearer: false, tokenMatchesServiceRole: false, userFound: false, staffRole: null,
  }), "UNAUTHENTICATED");
  assertEquals(classifyRecoverAuthorization({
    hasBearer: true, tokenMatchesServiceRole: false, userFound: false, staffRole: null,
  }), "UNAUTHENTICATED");
  assertEquals(classifyRecoverAuthorization({
    hasBearer: true, tokenMatchesServiceRole: false, userFound: true, staffRole: null,
  }), "FORBIDDEN");
  assertEquals(classifyRecoverAuthorization({
    hasBearer: true, tokenMatchesServiceRole: false, userFound: true, staffRole: "admin",
  }), "FORBIDDEN");
  assertEquals(classifyRecoverAuthorization({
    hasBearer: true, tokenMatchesServiceRole: false, userFound: true, staffRole: "finance_ops",
  }), "FORBIDDEN");
  assertEquals(classifyRecoverAuthorization({
    hasBearer: true, tokenMatchesServiceRole: false, userFound: true, staffRole: "super_admin",
  }), "ALLOWED");
  assertEquals(classifyRecoverAuthorization({
    hasBearer: true, tokenMatchesServiceRole: true, userFound: false, staffRole: null,
  }), "ALLOWED");
});

Deno.test("HTTP: anonymous blocked", async () => {
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003] }),
    { authorize: async () => deny(401, "Unauthorized") },
  );
  assertEquals(res.status, 401);
});

Deno.test("HTTP: customer blocked", async () => {
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003] }, { authorization: "Bearer customer" }),
    { authorize: async () => deny(403, "Forbidden — Super Admin or service-role required") },
  );
  assertEquals(res.status, 403);
});

Deno.test("HTTP: driver blocked", async () => {
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003] }, { authorization: "Bearer driver" }),
    { authorize: async () => deny(403, "Forbidden — Super Admin or service-role required") },
  );
  assertEquals(res.status, 403);
});

Deno.test("HTTP: non-Super Admin blocked", async () => {
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003] }, { authorization: "Bearer admin" }),
    { authorize: async () => deny(403, "Forbidden — Super Admin or service-role required") },
  );
  assertEquals(res.status, 403);
});

Deno.test("HTTP: Super Admin allowed", async () => {
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003] }, { authorization: "Bearer super" }),
    {
      authorize: async () => allowGate("super-admin-uuid"),
      recover: async (_sb, args) => eligibleRow(args.tripId, args.tripId === TRIP_002 ? "MK-260818-002" : "MK-260818-003"),
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  assertEquals(body.audit.actor_admin_uuid, "super-admin-uuid");
});

Deno.test("HTTP: service role allowed", async () => {
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003] }, { authorization: "Bearer service" }),
    {
      authorize: async () => allowGate("service-role"),
      recover: async (_sb, args) => eligibleRow(args.tripId, args.tripId === TRIP_002 ? "MK-260818-002" : "MK-260818-003"),
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.audit.actor_admin_uuid, "service-role");
});

Deno.test("HTTP: default dry run when dry_run omitted", async () => {
  const seen: boolean[] = [];
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003] }),
    {
      authorize: async () => allowGate(),
      recover: async (_sb, args) => {
        seen.push(args.dryRun !== false);
        return eligibleRow(args.tripId, "x");
      },
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.dry_run, true);
  assertEquals(seen, [true, true]);
});

Deno.test("HTTP: confirmation phrase mandatory for execution", async () => {
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003], dry_run: false }),
    { authorize: async () => allowGate() },
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.code, "EXECUTE_CONFIRMATION_REQUIRED");
  assertEquals(EXECUTE_CONFIRMATION, "CREDIT_SAVED_TRIP_EARNING_NET");
});

Deno.test("HTTP: unknown UUID blocked", async () => {
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"] }),
    { authorize: async () => allowGate() },
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.code, "ALLOW_LIST_VIOLATION");
});

Deno.test("HTTP: extra third UUID blocks entire request", async () => {
  let recoverCalls = 0;
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003, TRIP_001], dry_run: true }),
    {
      authorize: async () => allowGate(),
      recover: async () => {
        recoverCalls += 1;
        return eligibleRow(TRIP_002, "MK-260818-002");
      },
    },
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.code, "ALLOW_LIST_VIOLATION");
  assertEquals(body.unknown_trip_ids, [TRIP_001]);
  assertEquals(recoverCalls, 0);
});

Deno.test("HTTP: exactly two approved dry-run rows total 850p", async () => {
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003], dry_run: true }),
    {
      authorize: async () => allowGate(),
      recover: async (_sb, args) =>
        eligibleRow(args.tripId, args.tripId === TRIP_002 ? "MK-260818-002" : "MK-260818-003"),
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  assertEquals(body.dry_run, true);
  assertEquals(body.results.length, 2);
  assertEquals(body.results[0].status, "DRY_RUN_ELIGIBLE");
  assertEquals(body.results[1].status, "DRY_RUN_ELIGIBLE");
  assertEquals(body.proposed_total_pence, 850);
  assertEquals(body.provider_operation_required, false);
  assertEquals(body.settlement_recalculation_required, false);
  assertEquals(body.results[0].provider_operation_required, false);
  assertEquals(body.results[0].settlement_recalculation_required, false);
});

Deno.test("HTTP: actor_admin_uuid or role in body is rejected and recover is not called", async () => {
  let recoverCalls = 0;
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003], dry_run: true, role: "super_admin", actor_admin_uuid: "x" }),
    {
      authorize: async () => allowGate(),
      recover: async () => {
        recoverCalls += 1;
        return eligibleRow(TRIP_002, "MK-260818-002");
      },
    },
  );
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.code, "AUTH_CLAIM_IN_BODY");
  assertEquals(recoverCalls, 0);
});

Deno.test("HTTP: cohort date filters rejected", async () => {
  const res = await handleAdminRecoverCapturedTripWallet(
    jsonRequest({ trip_ids: [TRIP_002, TRIP_003], date_from: "2026-08-01" }),
    { authorize: async () => allowGate() },
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.code, "COHORT_MODE_FORBIDDEN");
});

Deno.test("allow-list is exactly the two approved UUIDs", () => {
  assertEquals([...APPROVED_CAPTURED_TRIP_WALLET_RECOVERY_TRIP_IDS], [TRIP_002, TRIP_003]);
});

Deno.test("handler source: no provider/FR writer/payout/CW/settlement calculator", async () => {
  const src = await Deno.readTextFile(new URL("./handler.ts", import.meta.url));
  assertEquals(src.includes("revolutOrders"), false);
  assertEquals(src.includes("retrieveRevolutOrder"), false);
  assertEquals(src.includes("tripSettlement"), false);
  assertEquals(src.includes("calculateTripSettlementFromTripRow"), false);
  assertEquals(src.includes("frPerTripAuditSSOT"), false);
  assertEquals(src.includes("admin-finance-reconciliation"), false);
  assertEquals(src.includes("payout_items"), false);
  assertEquals(src.includes("driver_commission_wallet"), false);
  assertEquals(src.includes("from(\"driver_wallet_ledger\").insert"), false);
  assert(src.includes("dry_run !== false"));
  assert(src.includes("CREDIT_SAVED_TRIP_EARNING_NET"));
  assert(src.includes("super_admin"));
  assertEquals(src.includes("isServiceRoleJwt"), false);
  assert(src.includes("authenticateRecoverBearer"));
  assert(src.includes("auth.getUser"));
});
