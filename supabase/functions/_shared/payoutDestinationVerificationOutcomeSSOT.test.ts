/**
 * A8B28F Stage B2 — pure outcome SSOT (no provider I/O).
 * Run: deno test --allow-read supabase/functions/_shared/payoutDestinationVerificationOutcomeSSOT.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  PAYOUT_DESTINATION_OUTCOME,
  PROVIDER_LINK_FAILURE_CLASS,
  classifyCounterpartyCreateFailure,
  httpStatusForOutcome,
  isClientSuccessOutcome,
  resolveSyncUkRevolutOutcome,
} from "./payoutDestinationVerificationOutcomeSSOT.ts";

Deno.test("HTTP statuses match Stage B2 contract", () => {
  assertEquals(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_AND_VERIFIED), 200);
  assertEquals(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.DESTINATION_ALREADY_VERIFIED), 200);
  assertEquals(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_PENDING), 202);
  assertEquals(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED), 422);
  assertEquals(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.RETRY_REQUIRED), 422);
  assertEquals(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVE_FAILED), 400);
});

Deno.test("FAILED link is never client success and never maps to ordinary pending outcome", () => {
  const o = resolveSyncUkRevolutOutcome({
    saveOk: true,
    linkStatus: "FAILED",
    verificationStatus: "PENDING_VERIFICATION",
    hasCounterpartyRef: false,
    hasRecipientRef: false,
  });
  assertEquals(o, PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED);
  assertEquals(isClientSuccessOutcome(o), false);
});

Deno.test("verified requires both provider refs", () => {
  assertEquals(
    resolveSyncUkRevolutOutcome({
      saveOk: true,
      linkStatus: "PROVIDER_VERIFIED",
      verificationStatus: "PROVIDER_VERIFIED",
      hasCounterpartyRef: true,
      hasRecipientRef: true,
    }),
    PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_AND_VERIFIED,
  );
  assertEquals(
    resolveSyncUkRevolutOutcome({
      saveOk: true,
      linkStatus: "PROVIDER_VERIFIED",
      verificationStatus: "PROVIDER_VERIFIED",
      hasCounterpartyRef: true,
      hasRecipientRef: false,
    }),
    PAYOUT_DESTINATION_OUTCOME.RETRY_REQUIRED,
  );
});

Deno.test("async pending only when not failed", () => {
  assertEquals(
    resolveSyncUkRevolutOutcome({
      saveOk: true,
      linkStatus: "NOT_LINKED",
      verificationStatus: "PENDING_VERIFICATION",
      hasCounterpartyRef: false,
      hasRecipientRef: false,
    }),
    PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_PENDING,
  );
});

Deno.test("failure classification covers duplicate / input / transient", () => {
  assertEquals(
    classifyCounterpartyCreateFailure({ http_status: 409, mentions_duplicate: true }),
    PROVIDER_LINK_FAILURE_CLASS.DUPLICATE_COUNTERPARTY_RECONCILIATION_REQUIRED,
  );
  assertEquals(
    classifyCounterpartyCreateFailure({ http_status: 400, mentions_invalid_input: true }),
    PROVIDER_LINK_FAILURE_CLASS.USER_INPUT_CORRECTION_REQUIRED,
  );
  assertEquals(
    classifyCounterpartyCreateFailure({ http_status: 503, mentions_transient: true }),
    PROVIDER_LINK_FAILURE_CLASS.RETRYABLE_TRANSIENT,
  );
  assertEquals(
    classifyCounterpartyCreateFailure({ access_token_missing: true }),
    PROVIDER_LINK_FAILURE_CLASS.PROVIDER_CONFIGURATION_REQUIRED,
  );
});
