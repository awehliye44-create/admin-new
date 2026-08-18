/**
 * HTTP + authorization lock for admin-recover-mk007-mk009-wallet.
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/admin-recover-mk007-mk009-wallet/adminRecoverMk007Mk009WalletHttpLock.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import type { GateResult } from "../_shared/adminPaymentGate.ts";
import {
  classifyRecoverAuthorization,
  handleAdminRecoverMk007Mk009Wallet,
} from "./handler.ts";
import {
  APPROVED_MK007_MK009_TRIP_IDS,
  MK007_ID,
  MK008_ID,
  MK009_ID,
  type RecoveryResult,
} from "./mk007Mk009WalletRecovery.ts";

const UNKNOWN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.supabase.co/functions/v1/admin-recover-mk007-mk009-wallet", {
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

function eligibleRow(tripId: string): RecoveryResult {
  const is007 = tripId === MK007_ID;
  return {
    status: "DRY_RUN_ELIGIBLE",
    tripId,
    tripCode: is007 ? "MK-260817-007" : "MK-260817-009",
    dryRun: true,
    saved_driver_entitlement_pence: is007 ? 425 : 706,
    payment_session_id: `ps-${tripId}`,
    payment_session_status: "trip_created",
    payment_session_lifecycle_mismatch: true,
    payment_session_finalization_required_before_credit: true,
    provider_state: "COMPLETED",
    provider_state_verified_at: "2026-08-17T18:50:46.198Z",
    captured_amount_pence: is007 ? 480 : 798,
    captured_at: "2026-08-17T18:50:46.198Z",
    provider_order_id: `ord-${tripId}`,
    provider_capture_id: `cap-${tripId}`,
    existing_wallet_count: 0,
    existing_wallet_amount_pence: 0,
    proposed_amount_pence: is007 ? 425 : 706,
    proposed_ledger_type: "TRIP_EARNING_NET",
    posting_created_at: null,
    posting_created_at_projection: "future_execution_timestamp",
    economic_earned_at: "2026-08-17T18:50:46.198Z",
    eligible_at: "2026-08-18T21:50:46.198Z",
    eligibility_origin: "captured_at_plus_27h",
    provider_operation_required: false,
    settlement_recalculation_required: false,
    driver_id: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
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
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID] }),
    { authorize: async () => deny(401, "Unauthorized") },
  );
  assertEquals(res.status, 401);
});

Deno.test("HTTP: customer blocked", async () => {
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID] }, { authorization: "Bearer customer" }),
    { authorize: async () => deny(403, "Forbidden — Super Admin or service-role required") },
  );
  assertEquals(res.status, 403);
});

Deno.test("HTTP: driver blocked", async () => {
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID] }, { authorization: "Bearer driver" }),
    { authorize: async () => deny(403, "Forbidden — Super Admin or service-role required") },
  );
  assertEquals(res.status, 403);
});

Deno.test("HTTP: non-Super Admin blocked", async () => {
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID] }, { authorization: "Bearer admin" }),
    { authorize: async () => deny(403, "Forbidden — Super Admin or service-role required") },
  );
  assertEquals(res.status, 403);
});

Deno.test("HTTP: Super Admin allowed", async () => {
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID] }, { authorization: "Bearer super" }),
    {
      authorize: async () => allowGate("super-admin-uuid"),
      recover: async (_sb, tripId) => eligibleRow(tripId),
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  assertEquals(body.audit.actor_admin_uuid, "super-admin-uuid");
});

Deno.test("HTTP: service role allowed", async () => {
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID] }, { authorization: "Bearer service" }),
    {
      authorize: async () => allowGate("service-role"),
      recover: async (_sb, tripId) => eligibleRow(tripId),
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.audit.actor_admin_uuid, "service-role");
});

Deno.test("HTTP: default dry run when dry_run omitted", async () => {
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID] }),
    {
      authorize: async () => allowGate(),
      recover: async (_sb, tripId) => eligibleRow(tripId),
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.dry_run, true);
});

Deno.test("HTTP: dry_run false is LIVE_EXECUTION_DISABLED even with a confirmation phrase", async () => {
  let recoverCalls = 0;
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({
      trip_ids: [MK007_ID, MK009_ID],
      dry_run: false,
      confirm_execute: "CREDIT_SAVED_TRIP_EARNING_NET",
    }),
    {
      authorize: async () => allowGate(),
      recover: async (_sb, tripId) => {
        recoverCalls += 1;
        return eligibleRow(tripId);
      },
    },
  );
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.code, "LIVE_EXECUTION_DISABLED");
  assertEquals(recoverCalls, 0);
});

Deno.test("HTTP: confirmation phrase alone is LIVE_EXECUTION_DISABLED", async () => {
  let recoverCalls = 0;
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({
      trip_ids: [MK007_ID, MK009_ID],
      dry_run: true,
      confirm_execute: "CREDIT_SAVED_TRIP_EARNING_NET",
    }),
    {
      authorize: async () => allowGate(),
      recover: async (_sb, tripId) => {
        recoverCalls += 1;
        return eligibleRow(tripId);
      },
    },
  );
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.code, "LIVE_EXECUTION_DISABLED");
  assertEquals(recoverCalls, 0);
});

Deno.test("HTTP: unknown UUID blocked", async () => {
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [UNKNOWN] }),
    { authorize: async () => allowGate() },
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.code, "ALLOW_LIST_VIOLATION");
});

Deno.test("HTTP: MK-008 PENDING_EVIDENCE UUID blocks entire request", async () => {
  let recoverCalls = 0;
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK008_ID], dry_run: true }),
    {
      authorize: async () => allowGate(),
      recover: async (_sb, tripId) => {
        recoverCalls += 1;
        return eligibleRow(tripId);
      },
    },
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.code, "ALLOW_LIST_VIOLATION");
  assertEquals(body.unknown_trip_ids, [MK008_ID]);
  assertEquals(recoverCalls, 0);
});

Deno.test("HTTP: extra third UUID blocks entire request", async () => {
  let recoverCalls = 0;
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID, UNKNOWN], dry_run: true }),
    {
      authorize: async () => allowGate(),
      recover: async (_sb, tripId) => {
        recoverCalls += 1;
        return eligibleRow(tripId);
      },
    },
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.code, "ALLOW_LIST_VIOLATION");
  assertEquals(recoverCalls, 0);
});

Deno.test("HTTP: exactly two approved dry-run rows total 1131p", async () => {
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID], dry_run: true }),
    {
      authorize: async () => allowGate(),
      recover: async (_sb, tripId) => eligibleRow(tripId),
    },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  assertEquals(body.dry_run, true);
  assertEquals(body.results.length, 2);
  assertEquals(body.results[0].status, "DRY_RUN_ELIGIBLE");
  assertEquals(body.results[1].status, "DRY_RUN_ELIGIBLE");
  assertEquals(body.results[0].proposed_amount_pence, 425);
  assertEquals(body.results[1].proposed_amount_pence, 706);
  assertEquals(body.proposed_total_pence, 1131);
  assertEquals(body.provider_operation_required, false);
  assertEquals(body.settlement_recalculation_required, false);
});

Deno.test("HTTP: actor_admin_uuid or role in body is rejected and recover is not called", async () => {
  let recoverCalls = 0;
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID], dry_run: true, role: "super_admin", actor_admin_uuid: "x" }),
    {
      authorize: async () => allowGate(),
      recover: async (_sb, tripId) => {
        recoverCalls += 1;
        return eligibleRow(tripId);
      },
    },
  );
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.code, "AUTH_CLAIM_IN_BODY");
  assertEquals(recoverCalls, 0);
});

Deno.test("HTTP: cohort date filters rejected", async () => {
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID], date_from: "2026-08-01" }),
    { authorize: async () => allowGate() },
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.code, "COHORT_MODE_FORBIDDEN");
});

Deno.test("HTTP: all-driver mode rejected", async () => {
  const res = await handleAdminRecoverMk007Mk009Wallet(
    jsonRequest({ trip_ids: [MK007_ID, MK009_ID], all_drivers: true }),
    { authorize: async () => allowGate() },
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.code, "COHORT_MODE_FORBIDDEN");
});

Deno.test("allow-list is exactly the two approved UUIDs", () => {
  assertEquals([...APPROVED_MK007_MK009_TRIP_IDS], [MK007_ID, MK009_ID]);
});

Deno.test("handler source: live execution disabled; crypto auth; no confirmation phrase", async () => {
  const src = await Deno.readTextFile(new URL("./handler.ts", import.meta.url));
  assertEquals(src.includes("revolutOrders"), false);
  assertEquals(src.includes("retrieveRevolutOrder"), false);
  assertEquals(src.includes("calculateTripSettlementFromTripRow"), false);
  assertEquals(src.includes("frPerTripAuditSSOT"), false);
  assertEquals(src.includes("from(\"driver_wallet_ledger\").insert"), false);
  assertEquals(src.includes("CREDIT_SAVED_TRIP_EARNING_NET"), false);
  assert(src.includes("LIVE_EXECUTION_DISABLED"));
  assert(src.includes("super_admin"));
  assertEquals(src.includes("isServiceRoleJwt"), false);
  assert(src.includes("authenticateRecoverBearer"));
  assert(src.includes("auth.getUser"));
});
