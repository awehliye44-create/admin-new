/**
 * Lock: payment_sessions PostgREST selects must only reference real production columns.
 *
 * Authoritative snapshot: production thazislrdkjpvvghtvzo information_schema
 * 2026-08-18 (Step 2I audit). payment_sessions has NO financial_model column.
 *
 * Run:
 *   deno test --allow-read supabase/functions/_shared/paymentSessionSchemaLock.test.ts
 */
import { assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PAYMENT_SESSION_CAPTURE_GATE_SELECT,
  paymentSessionCaptureGateSelectColumns,
  loadPaymentSessionCaptureGate,
  loadWalletRecoveryPaymentSessions,
} from "./paymentSessionCaptureGateSSOT.ts";
import {
  tripWalletRecoverySelectColumns,
} from "./capturedTripWalletRecovery.ts";

/** Frozen production public.payment_sessions column names (2026-08-18). */
const AUTHORITATIVE_PRODUCTION_PAYMENT_SESSIONS_COLUMNS = new Set<string>([
  "id",
  "client_action_id",
  "user_id",
  "customer_id",
  "service_area_id",
  "payment_provider",
  "provider_order_id",
  "provider_payment_id",
  "status",
  "authorised_amount_pence",
  "estimated_total_pence",
  "buffer_pence",
  "fare_snapshot",
  "booking_snapshot",
  "trip_id",
  "platform_payment_method_id",
  "payment_method",
  "failure_reason",
  "metadata",
  "created_at",
  "updated_at",
  "authorised_at",
  "released_at",
  "captured_at",
  "release_attempt_count",
  "last_release_attempt_at",
  "release_failure_reason",
  "recovery_attempt_count",
  "last_recovery_attempt_at",
  "provider_release_reference",
  "hold_terminal_reason",
  "hold_release_state",
  "captured_amount_pence",
  "released_amount_pence",
  "refunded_amount_pence",
  "provider_processing_fee_pence",
  "fee_status",
  "refunded_at",
  "provider_capture_id",
  "provider_refund_id",
  "currency",
  "idempotency_key",
  "purpose",
  "total_authorised_amount_pence",
  "provider_state",
  "provider_state_verified_at",
  "provider_state_verified_by",
  "provider_fee_percentage_snapshot_pence",
  "provider_fixed_fee_snapshot_pence",
  "provider_fee_total_snapshot_pence",
  "provider_fee_currency_snapshot",
  "provider_fee_version_snapshot",
  "provider_fee_source",
  "provider_fee_confirmed_at",
  "provider_name_snapshot",
  "release_evidence_status",
  "release_evidence_source",
  "release_verified_at",
  "parent_session_id",
  "recovery_reason",
  "provider_checkout_url",
  "original_authorised_pence",
  "additional_authorised_pence",
  "final_charge_pence",
  "shortfall_pence",
  "no_show_fee_pence",
  "cancellation_fee_pence",
  "recovery_required",
  "payment_resolution_type",
  "payment_resolution_status",
  "financial_operation_state",
  "financial_operation_owner",
  "financial_operation_started_at",
]);

const FORBIDDEN_PAYMENT_SESSION_COLUMNS = new Set(["financial_model"]);

function extractPaymentSessionSelectStrings(source: string): string[] {
  const matches: string[] = [];
  const re = /\.from\(\s*["']payment_sessions["']\s*\)\s*\.select\(\s*["']([^"']+)["']/g;
  for (const hit of source.matchAll(re)) {
    matches.push(hit[1]);
  }
  return matches;
}

async function readSharedSource(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, import.meta.url));
}

Deno.test("capture gate select columns exist in production payment_sessions", () => {
  for (const column of paymentSessionCaptureGateSelectColumns()) {
    assertEquals(
      AUTHORITATIVE_PRODUCTION_PAYMENT_SESSIONS_COLUMNS.has(column),
      true,
      `unknown payment_sessions column in capture gate select: ${column}`,
    );
    assertEquals(
      FORBIDDEN_PAYMENT_SESSION_COLUMNS.has(column),
      false,
      `forbidden payment_sessions column in capture gate select: ${column}`,
    );
  }
});

Deno.test("financial_model is absent from PAYMENT_SESSION_CAPTURE_GATE_SELECT", () => {
  assertFalse(PAYMENT_SESSION_CAPTURE_GATE_SELECT.includes("financial_model"));
});

Deno.test("wallet posting path reads trip financial_model from trips, not payment_sessions", async () => {
  const applySrc = await readSharedSource("./applyCanonicalSettlementAfterCapture.ts");
  assertEquals(applySrc.includes("args.trip.financial_model"), true);
  assertEquals(extractPaymentSessionSelectStrings(applySrc).length, 0);
  const gateSrc = await readSharedSource("./paymentSessionCaptureGateSSOT.ts");
  assertEquals(extractPaymentSessionSelectStrings(gateSrc).some((s) => s.includes("financial_model")), false);
});

Deno.test("capturedTripWalletRecovery uses shared recovery session loader without payment_sessions financial_model", async () => {
  const recoverySrc = await readSharedSource("./capturedTripWalletRecovery.ts");
  assertEquals(extractPaymentSessionSelectStrings(recoverySrc).length, 0);
  assertEquals(recoverySrc.includes("loadWalletRecoveryPaymentSessions"), true);
  assertEquals(recoverySrc.includes("financial_model"), true);
});

Deno.test("lifecycle finalizer identity lookup selects id only from payment_sessions", async () => {
  const src = await readSharedSource("./paymentSessionLifecycleFinalizer.ts");
  const selects = extractPaymentSessionSelectStrings(src);
  assertEquals(selects.every((s) => s === "id"), true);
});

Deno.test("PostgREST 42703 on recovery session list returns error — never silent empty success", async () => {
  const client = {
    from(table: string) {
      const chain = {
        select(_cols: string) { return chain; },
        eq() { return chain; },
        neq: async () => {
          if (table !== "payment_sessions") return { data: [], error: null };
          return {
            data: null,
            error: {
              code: "42703",
              message: "column payment_sessions.financial_model does not exist",
            },
          };
        },
      };
      return chain;
    },
  };
  const result = await loadWalletRecoveryPaymentSessions(client as never, "trip-id");
  assertEquals(result.sessions.length, 0);
  assertEquals(result.error?.code, "42703");
});

Deno.test("recovery trip/ledger selects omit provider_fee_amount and payment_sessions.financial_model", () => {
  assertEquals(PAYMENT_SESSION_CAPTURE_GATE_SELECT.includes("financial_model"), false);
  assertEquals(PAYMENT_SESSION_CAPTURE_GATE_SELECT.includes("provider_fee_amount"), false);
  const tripCols = tripWalletRecoverySelectColumns();
  assertEquals(tripCols.includes("financial_model"), true);
  assertEquals(tripCols.includes("provider_fee_amount"), false);
  assertEquals(tripCols.includes("driver_net_pence"), true);
});

Deno.test("capture gate queries purpose=RIDE_BOOKING only — no limit(1).maybeSingle", async () => {
  const gateSrc = await readSharedSource("./paymentSessionCaptureGateSSOT.ts");
  assertEquals(gateSrc.includes('.eq("purpose", PAYMENT_SESSION_PURPOSE_RIDE_BOOKING)'), true);
  assertEquals(gateSrc.includes(".limit(1)"), false);
  assertEquals(gateSrc.includes(".maybeSingle()"), false);
  assertEquals(gateSrc.includes("CAPTURE_AMBIGUOUS"), true);
  assertEquals(gateSrc.includes("classifyRideBookingPaymentSessions"), true);
});

Deno.test("PostgREST 42703 on gate load returns error — never silent session=null success", async () => {
  const client = {
    from(table: string) {
      const chain = {
        select(_cols: string) { return chain; },
        eq() { return chain; },
        async then(resolve: (v: unknown) => void) {
          if (table !== "payment_sessions") {
            resolve({ data: [], error: null });
            return;
          }
          resolve({
            data: null,
            error: {
              code: "42703",
              message: "column payment_sessions.financial_model does not exist",
            },
          });
        },
      };
      return chain;
    },
  };
  const result = await loadPaymentSessionCaptureGate(client as never, "trip-id");
  assertEquals(result.session, null);
  assertEquals(result.error?.code, "42703");
  assertEquals(result.gate_status, "PAYMENT_SESSION_GATE_QUERY");
});

Deno.test("zero RIDE_BOOKING rows → PAYMENT_SESSION_MISSING", async () => {
  const client = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                eq: async () => ({ data: [], error: null }),
              };
            },
          };
        },
      };
    },
  };
  const result = await loadPaymentSessionCaptureGate(client as never, "trip-id");
  assertEquals(result.gate_status, "PAYMENT_SESSION_MISSING");
  assertEquals(result.session, null);
});

Deno.test("two RIDE_BOOKING rows → CAPTURE_AMBIGUOUS", async () => {
  const client = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                eq: async () => ({
                  data: [{ id: "a", purpose: "RIDE_BOOKING" }, { id: "b", purpose: "RIDE_BOOKING" }],
                  error: null,
                }),
              };
            },
          };
        },
      };
    },
  };
  const result = await loadPaymentSessionCaptureGate(client as never, "trip-id");
  assertEquals(result.gate_status, "CAPTURE_AMBIGUOUS");
  assertEquals(result.session, null);
});
