/**
 * Recapture saved-card success lock — £4 leftover checkout_url must not force a payment link.
 * Run: deno test --allow-read supabase/functions/_shared/adminRecaptureSavedCardLock.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveAdminRecaptureOutcome,
  recaptureAttemptBadgeLabel,
  resolveRecaptureAttemptUi,
  TRIP_SHORTFALL_RECAPTURE_UI_STATE,
} from "./tripHistoryShortfallRecaptureSSOT.ts";

const ROOT = new URL(".", import.meta.url).pathname.replace(/_shared\/$/, "");
const FOUR_POUNDS = 400;

Deno.test("£4 saved-card success with leftover checkout_url is not customer action", () => {
  const outcome = deriveAdminRecaptureOutcome({
    saved_card_charged: true,
    requires_customer_action: false,
    checkout_url: "https://checkout.revolut.com/pay/recover-4",
    status: "RECOVERY_CHECKOUT_CREATED",
    already_completed: false,
    reused: false,
    message: "Saved card charged off-session — awaiting provider webhook confirmation.",
  });

  assertEquals(outcome.saved_card_charged, true);
  assertEquals(outcome.requires_customer_action, false);
  assertEquals(outcome.show_payment_link, false);
  assertEquals(outcome.status, TRIP_SHORTFALL_RECAPTURE_UI_STATE.SAVED_CARD_CHARGED);
  assertEquals(
    recaptureAttemptBadgeLabel(outcome.status),
    "Saved card charged",
  );
  assertEquals(FOUR_POUNDS, 400);
});

Deno.test("A. genuine customer-action recovery still shows the payment link", () => {
  const outcome = deriveAdminRecaptureOutcome({
    saved_card_charged: false,
    requires_customer_action: true,
    checkout_url: "https://checkout.revolut.com/pay/link",
    status: "CUSTOMER_ACTION_REQUIRED",
  });
  assertEquals(outcome.saved_card_charged, false);
  assertEquals(outcome.requires_customer_action, true);
  assertEquals(outcome.show_payment_link, true);
  assertEquals(outcome.status, TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED);
  assertEquals(recaptureAttemptBadgeLabel(outcome.status), "Customer action required");
});

Deno.test("B. saved-card hard failure is not reported as charged", () => {
  const outcome = deriveAdminRecaptureOutcome({
    saved_card_charged: false,
    requires_customer_action: false,
    checkout_url: null,
    status: "failed",
  });
  assertEquals(outcome.saved_card_charged, false);
  assertEquals(outcome.status, TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING);
  assertEquals(outcome.show_payment_link, false);
});

Deno.test("C. processing is not overridden by a stale open recovery session", () => {
  const ui = resolveRecaptureAttemptUi({
    attemptState: TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING,
    hasOpenRecoverySession: true,
    gateUiState: TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_AVAILABLE,
  });
  assertEquals(ui.ui_state, TRIP_SHORTFALL_RECAPTURE_UI_STATE.RECAPTURE_PROCESSING);
  assertEquals(ui.show_payment_link, false);
});

Deno.test("C. saved-card success is not overridden by leftover open recovery", () => {
  const ui = resolveRecaptureAttemptUi({
    attemptState: TRIP_SHORTFALL_RECAPTURE_UI_STATE.SAVED_CARD_CHARGED,
    hasOpenRecoverySession: true,
    gateUiState: TRIP_SHORTFALL_RECAPTURE_UI_STATE.CUSTOMER_ACTION_REQUIRED,
  });
  assertEquals(ui.ui_state, TRIP_SHORTFALL_RECAPTURE_UI_STATE.SAVED_CARD_CHARGED);
  assertEquals(ui.show_payment_link, false);
  assertEquals(recaptureAttemptBadgeLabel(ui.ui_state), "Saved card charged");
});

Deno.test("D. reused open recovery does not invent a saved-card charge", () => {
  const outcome = deriveAdminRecaptureOutcome({
    saved_card_charged: false,
    requires_customer_action: true,
    checkout_url: "https://checkout.revolut.com/pay/reuse",
    reused: true,
  });
  assertEquals(outcome.saved_card_charged, false);
  assertEquals(outcome.reused, true);
  assertEquals(outcome.requires_customer_action, true);
});

Deno.test("admin-recapture-trip-shortfall forwards saved_card_charged and uses SSOT", async () => {
  const src = await Deno.readTextFile(`${ROOT}admin-recapture-trip-shortfall/index.ts`);
  assert(src.includes("deriveAdminRecaptureOutcome"));
  assert(src.includes("saved_card_charged: outcome.saved_card_charged"));
  assert(src.includes("saved_card_charged: recoveryJson.saved_card_charged"));
  assert(!/requiresCustomerAction = !!\(\s*recoveryJson\.checkout_url/.test(src));
});

Deno.test("Trip History UI consumes backend truth, not checkout_url presence", async () => {
  const ui = await Deno.readTextFile(
    new URL("../../../src/components/trips/TripHistoryShortfallRecaptureAction.tsx", import.meta.url),
  );
  assert(ui.includes("resolveRecaptureAttemptUi"));
  assert(ui.includes("SAVED_CARD_CHARGED"));
  assert(ui.includes("Saved card charged"));
  assert(ui.includes("data.saved_card_charged === true && data.requires_customer_action !== true"));
  assert(!ui.includes("data.requires_customer_action || data.checkout_url"));
  assert(!/hasLiveOpenRecovery && attemptState !== TRIP_SHORTFALL_RECAPTURE_UI_STATE.FULLY_PAID/.test(ui));
});

Deno.test("create-payment-recovery reuse short-circuit prevents a second charge", async () => {
  const src = await Deno.readTextFile(`${ROOT}create-payment-recovery/index.ts`);
  assert(src.includes("reused: true"));
  assert(src.includes('in("status", ["RECOVERY_CHECKOUT_CREATED", "CUSTOMER_ACTION_REQUIRED"])'));
  assert(src.includes("saved_card_charged: savedCardAttempt.succeeded"));
});
