/**
 * A8B28F Stage B2 — pure outcome SSOT (no provider I/O).
 * Run: deno test --allow-read supabase/functions/_shared/payoutDestinationVerificationOutcomeSSOT.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  DRIVER_FACING_VERIFY_FAILED_NEUTRAL,
  DRIVER_FACING_VERIFY_FAILED_USER_INPUT,
  PAYOUT_DESTINATION_OUTCOME,
  PROVIDER_LINK_FAILURE_CLASS,
  classifyCounterpartyCreateFailure,
  driverFacingMessageForOutcome,
  httpStatusForOutcome,
  inferCounterpartyFailureSignals,
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

Deno.test("B2R: Revolut 403 / IP whitelist → PROVIDER_CONFIGURATION_REQUIRED not user typo", () => {
  const signals = inferCounterpartyFailureSignals(
    "IP address is not whitelisted. Verify IP whitelist configuration in Revolut Business Portal.",
  );
  assertEquals(signals.mentions_ip_whitelist, true);
  assertEquals(
    classifyCounterpartyCreateFailure({ http_status: 403, ...signals }),
    PROVIDER_LINK_FAILURE_CLASS.PROVIDER_CONFIGURATION_REQUIRED,
  );
  assertEquals(
    classifyCounterpartyCreateFailure({ http_status: 403 }),
    PROVIDER_LINK_FAILURE_CLASS.PROVIDER_CONFIGURATION_REQUIRED,
  );
  const msg = driverFacingMessageForOutcome(
    PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED,
    PROVIDER_LINK_FAILURE_CLASS.PROVIDER_CONFIGURATION_REQUIRED,
  );
  assertEquals(msg, DRIVER_FACING_VERIFY_FAILED_NEUTRAL);
  assertEquals(msg.includes("Check the details"), false);
});

Deno.test("B2R: only USER_INPUT_CORRECTION_REQUIRED uses details-blame copy", () => {
  assertEquals(
    driverFacingMessageForOutcome(
      PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED,
      PROVIDER_LINK_FAILURE_CLASS.USER_INPUT_CORRECTION_REQUIRED,
    ),
    DRIVER_FACING_VERIFY_FAILED_USER_INPUT,
  );
  assertEquals(
    driverFacingMessageForOutcome(
      PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED,
      null,
    ),
    DRIVER_FACING_VERIFY_FAILED_NEUTRAL,
  );
});
