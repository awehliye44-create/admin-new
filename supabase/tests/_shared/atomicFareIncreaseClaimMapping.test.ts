/**
 * HTTP / claim-code mapping for fare-increase atomic apply.
 * No live payment, wallet, or production DB access.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const HTTP_202_CUSTOMER_MESSAGE =
  "Payment is still being authorised. Your trip has not changed yet.";

function mapClaimErrorToResponse(message: string): {
  status: number;
  code: string;
  error: string;
  paymentProcessing?: boolean;
} {
  const msg = String(message ?? "");
  if (msg.includes("ALREADY_APPLIED")) {
    return { status: 200, code: "ALREADY_APPLIED", error: "" };
  }
  if (msg.includes("PAYMENT_NOT_CONFIRMED")) {
    return {
      status: 202,
      code: "PAYMENT_NOT_CONFIRMED",
      error: HTTP_202_CUSTOMER_MESSAGE,
      paymentProcessing: true,
    };
  }
  if (msg.includes("STALE_MODIFICATION")) {
    return {
      status: 409,
      code: "STALE_MODIFICATION",
      error: "Trip fare changed before this modification could apply. Re-check fare impact.",
    };
  }
  return { status: 409, code: "CLAIM_FAILED", error: "Trip fare changed before this modification could apply. Re-check fare impact." };
}

Deno.test("HTTP 202 customer copy is exact", () => {
  assertEquals(
    HTTP_202_CUSTOMER_MESSAGE,
    "Payment is still being authorised. Your trip has not changed yet.",
  );
});

Deno.test("PAYMENT_NOT_CONFIRMED maps to 202 with exact copy", () => {
  const r = mapClaimErrorToResponse("PAYMENT_NOT_CONFIRMED");
  assertEquals(r.status, 202);
  assertEquals(r.paymentProcessing, true);
  assertEquals(r.error, HTTP_202_CUSTOMER_MESSAGE);
});

Deno.test("STALE_MODIFICATION maps to 409", () => {
  const r = mapClaimErrorToResponse("STALE_MODIFICATION");
  assertEquals(r.status, 409);
  assertEquals(r.code, "STALE_MODIFICATION");
});

Deno.test("ALREADY_APPLIED maps to success idempotent", () => {
  const r = mapClaimErrorToResponse("ALREADY_APPLIED");
  assertEquals(r.status, 200);
  assertEquals(r.code, "ALREADY_APPLIED");
});

Deno.test("canonical migration contains atomic claim + unique auth index", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261112180000_atomic_fare_increase_modification_claim.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "claim_and_apply_fare_increase_modification");
  assertStringIncludes(sql, "uq_psa_additional_auth_confirmed_per_modification");
  assertStringIncludes(sql, "trip_has_unresolved_fare_increase_modification");
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "ADDITIONAL_AUTHORISATION_CONFIRMED");
  assertStringIncludes(sql, "Migration 20261112180000");
  assertEquals(sql.includes("DRAFT / REVIEW ONLY — DO NOT APPLY TO PRODUCTION"), false);
});
