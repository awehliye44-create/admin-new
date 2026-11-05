/**
 * MK-261105-002 — trip modification payment hardening lock.
 * Hold liveness for every delta; CUSTOMER_ACTION_REQUIRED ≠ decline;
 * durable OK-ack; release race refuse on increment.
 *
 *   deno test --allow-read supabase/tests/_shared/mk261105002ModificationPaymentHardeningLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyPaymentSessionHoldLiveness,
  dedupeKeyForModificationUnchanged,
  isDigitalPlatformPaymentMethod,
  lostAuthCustomerCopyForTripStatus,
  MODIFICATION_CHALLENGE_UNSUPPORTED_CUSTOMER_MESSAGE,
  MODIFICATION_UNCHANGED_CUSTOMER_MESSAGE,
  revisedPayablePenceForModification,
} from "../../functions/_shared/modificationHoldLivenessSSOT.ts";
import { decideFromPreauthInvokeResult } from "../../functions/_shared/tripModificationPaymentGateSSOT.ts";
import { PAYMENT_FAILURE_NOTICE_COPY } from "../../functions/_shared/customerPaymentFailureNoticeSSOT.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const mig = await Deno.readTextFile(
  `${ROOT}migrations/20261230140000_mk261105002_modification_payment_hardening.sql`,
);
const gateSrc = await Deno.readTextFile(
  `${ROOT}functions/_shared/tripModificationPaymentGateSSOT.ts`,
);
const execSrc = await Deno.readTextFile(
  `${ROOT}functions/_shared/executeFareIncreaseModificationPayment.ts`,
);
const reqSrc = await Deno.readTextFile(
  `${ROOT}functions/request-trip-modification/index.ts`,
);
const incrSrc = await Deno.readTextFile(
  `${ROOT}functions/_shared/executeSameOrderIncrementSSOT.ts`,
);
const lostSrc = await Deno.readTextFile(
  `${ROOT}functions/_shared/lostPaymentAuthorisationTripSSOT.ts`,
);

Deno.test("revised payable covers decrease / zero / increase", () => {
  assertEquals(
    revisedPayablePenceForModification({ newFarePence: 2000, originalFarePence: 2694 }),
    2000,
  );
  assertEquals(
    revisedPayablePenceForModification({ newFarePence: 2694, originalFarePence: 2694 }),
    2694,
  );
  assertEquals(
    revisedPayablePenceForModification({ newFarePence: 3000, originalFarePence: 2694 }),
    3000,
  );
  assertEquals(
    revisedPayablePenceForModification({ newFarePence: 0, originalFarePence: 2694 }),
    2694,
  );
});

Deno.test("hold liveness rejects releasing / released / expired / insufficient", () => {
  const base = {
    id: "ps-1",
    trip_id: "trip-1",
    provider_state: "AUTHORISED",
    status: "authorised_hold",
    hold_release_state: null,
    authorised_amount_pence: 2694,
    total_authorised_amount_pence: 2694,
  };
  assertEquals(
    classifyPaymentSessionHoldLiveness({
      session: base,
      expectedTripId: "trip-1",
      requiredPayablePence: 2694,
    }).ok,
    true,
  );
  assertEquals(
    classifyPaymentSessionHoldLiveness({
      session: { ...base, hold_release_state: "releasing" },
      expectedTripId: "trip-1",
      requiredPayablePence: 2000,
    }).ok,
    false,
  );
  assertEquals(
    classifyPaymentSessionHoldLiveness({
      session: { ...base, hold_release_state: "released" },
      expectedTripId: "trip-1",
      requiredPayablePence: 2000,
    }).ok,
    false,
  );
  assertEquals(
    classifyPaymentSessionHoldLiveness({
      session: { ...base, provider_state: "EXPIRED" },
      expectedTripId: "trip-1",
      requiredPayablePence: 2000,
    }).ok,
    false,
  );
  assertEquals(
    classifyPaymentSessionHoldLiveness({
      session: { ...base, authorised_amount_pence: 1000, total_authorised_amount_pence: 1000 },
      expectedTripId: "trip-1",
      requiredPayablePence: 2000,
    }).ok,
    false,
  );
  assertEquals(
    classifyPaymentSessionHoldLiveness({
      session: { ...base, metadata: { never_capture: "true" } },
      expectedTripId: "trip-1",
      requiredPayablePence: 2000,
    }).ok,
    false,
  );
});

Deno.test("CUSTOMER_ACTION_REQUIRED maps to PAYMENT_PENDING (not decline)", () => {
  const d = decideFromPreauthInvokeResult({
    success: false,
    requiredPayablePence: 3000,
    authorisedAmountPence: 2694,
    paymentCoverageStatus: "authorization_action_required",
    errorCode: "CUSTOMER_ACTION_REQUIRED",
  });
  assertEquals(d.phase, "PAYMENT_PENDING");
  assertEquals(d.mayApply, false);
  if (d.phase === "PAYMENT_PENDING") {
    assertEquals(d.reason, "customer_action_required");
  }
});

Deno.test("migration enforces hold for every apply + claim locks session", () => {
  assertStringIncludes(mig, "assert_trip_modification_hold_coverage");
  assertStringIncludes(mig, "hold_release_state");
  assertStringIncludes(mig, "releasing");
  assertStringIncludes(mig, "modification_unchanged");
  assertStringIncludes(mig, "trip_cancelled_payment");
  // No early return that skips ≤0 delta hold checks.
  assertEquals(/IF v_increase <= 0 THEN\s+RETURN NEW;/m.test(mig), false);
  assertStringIncludes(mig, "claim_and_apply_fare_increase_modification");
  assertStringIncludes(mig, "Server session authorised total is authoritative");
});

Deno.test("edge refuse dead hold before increment + pre-check zero-delta", () => {
  assertStringIncludes(incrSrc, "HOLD_RELEASE_IN_PROGRESS");
  assertStringIncludes(incrSrc, "HOLD_NOT_LIVE");
  assertStringIncludes(incrSrc, "hold_release_state");
  assertStringIncludes(reqSrc, "assert_trip_modification_hold_coverage");
  assertStringIncludes(reqSrc, "MODIFICATION_UNCHANGED_CUSTOMER_MESSAGE");
  assertStringIncludes(execSrc, "MODIFICATION_CHALLENGE_UNSUPPORTED");
  assertStringIncludes(execSrc, "upsertModificationUnchangedNotice");
  assertStringIncludes(execSrc, "assert_trip_modification_hold_coverage");
});

Deno.test("notice copy + lost-auth status wording", () => {
  assertEquals(
    PAYMENT_FAILURE_NOTICE_COPY.modification_unchanged.message,
    MODIFICATION_UNCHANGED_CUSTOMER_MESSAGE,
  );
  assertStringIncludes(
    MODIFICATION_CHALLENGE_UNSUPPORTED_CUSTOMER_MESSAGE,
    "isn’t available on a live trip",
  );
  assertEquals(
    dedupeKeyForModificationUnchanged("req-1"),
    "modification_unchanged:tcr:req-1",
  );
  const booking = lostAuthCustomerCopyForTripStatus("scheduled");
  assertEquals(booking.kind, "booking_cancelled_payment");
  assertEquals(booking.inProgressCancelPolicyNeedsDecision, false);
  assertStringIncludes(lostSrc, "flagged_recovery");
  assertStringIncludes(lostSrc, "mid_trip_payment_auth_lost");
  assertStringIncludes(lostSrc, "recovery_required");
  assertStringIncludes(lostSrc, "CANCELLED_NO_FEE");
  assertStringIncludes(execSrc, "MODIFICATION_CHALLENGE_UNSUPPORTED_REJECTION");
  assertStringIncludes(execSrc, "requestStatus");
  assertStringIncludes(execSrc, '"expired"');
  assertEquals(isDigitalPlatformPaymentMethod("APPLE_PAY"), true);
  assertEquals(isDigitalPlatformPaymentMethod("cash"), false);
});

Deno.test("challenge expire + mid-trip recovery migration + request block", async () => {
  const followUp = await Deno.readTextFile(
    `${ROOT}migrations/20261230150000_mk261105002_mod_challenge_midtrip_recovery.sql`,
  );
  assertStringIncludes(followUp, "modification_challenge_unsupported");
  assertStringIncludes(followUp, "abandoned_or_expired");
  assertStringIncludes(followUp, "mid_trip_payment_auth_lost_recovery");
  assertStringIncludes(followUp, "recovery_required");
  assertStringIncludes(reqSrc, "MID_TRIP_PAYMENT_AUTH_LOST");
  assertStringIncludes(reqSrc, "tripBlocksModificationsForUnresolvedPayment");
});

Deno.test("gate source keeps CUSTOMER_ACTION_REQUIRED pending branch", () => {
  assertStringIncludes(gateSrc, 'reason: "customer_action_required"');
  assertStringIncludes(gateSrc, "authorization_action_required");
});
