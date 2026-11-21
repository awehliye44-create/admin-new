/**
 * #71A — Campaign / platform incentive vs trip entitlement credit monitoring.
 * BONUS must not inflate trip actual; authorised campaign credit is separate.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAMPAIGN_BONUS_LEDGER_SOURCE,
  classifyDriverCreditHealth,
  classifyPlatformIncentiveCreditsForTrip,
  DRIVER_CREDIT_HEALTH,
  DRIVER_CREDIT_PROCESSING_GRACE_MS,
  FR_TRIP_ENTITLEMENT_CREDIT_TYPES,
  sumActiveDriverWalletCreditForTrip,
  TRIP_ENTITLEMENT_LEDGER_TYPES,
} from "../../functions/_shared/driverCreditMonitoringSSOT.ts";
import { PAYOUT_ELIGIBLE_LEDGER_TYPES } from "../../functions/_shared/driverPayoutEligibilitySSOT.ts";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const OLD_CAPTURE = new Date(NOW - DRIVER_CREDIT_PROCESSING_GRACE_MS - 60_000).toISOString();
const DRIVER = "56136f5f-1a3a-4a14-bb23-439b3951415a";
const CAMPAIGN = "573f8a50-8285-45f9-9cae-c7f92cfa474a";
const BONUS_LEDGER_ID = "9ef6535e-b5a7-4de9-ab1a-91c1b0b720a1";

Deno.test("#71A trip entitlement set is FR SSOT and excludes BONUS", () => {
  assertEquals(TRIP_ENTITLEMENT_LEDGER_TYPES.has("BONUS"), false);
  assertEquals(FR_TRIP_ENTITLEMENT_CREDIT_TYPES.has("BONUS"), false);
  assertEquals(PAYOUT_ELIGIBLE_LEDGER_TYPES.has("BONUS"), true);
  assertEquals(TRIP_ENTITLEMENT_LEDGER_TYPES.has("TRIP_EARNING_NET"), true);
});

Deno.test("#71A MK0007 shape: £20 campaign bonus → OK, unexplained 0", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 2760,
    tip_pence: 0,
    ledger: [
      {
        id: BONUS_LEDGER_ID,
        type: "BONUS",
        amount_pence: 2000,
        driver_id: DRIVER,
        description: "Trip bonus: Milton Keynes 3-Trip Bonus",
        metadata: {
          source: CAMPAIGN_BONUS_LEDGER_SOURCE,
          campaign_id: CAMPAIGN,
          entitled_bonus_amount_pence: 2000,
        },
      },
      { type: "TRIP_EARNING_NET", amount_pence: 2760, driver_id: DRIVER },
    ],
    campaign_progress: [{
      campaign_id: CAMPAIGN,
      driver_id: DRIVER,
      ledger_entry_id: BONUS_LEDGER_ID,
      entitled_bonus_amount_pence: 2000,
      credited_at: "2026-11-19T21:09:02.489686+00",
    }],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 3067,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.OK);
  assertEquals(result.expected_driver_credit_pence, 2760);
  assertEquals(result.actual_driver_credit_pence, 2760);
  assertEquals(result.authorised_campaign_credit_pence, 2000);
  assertEquals(result.total_legitimate_credit_pence, 4760);
  assertEquals(result.unexplained_credit_variance_pence, 0);
  assertEquals(result.credit_difference_pence, 0);
});

Deno.test("#71A no campaign bonus → OK", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 1000,
    ledger: [{ type: "TRIP_EARNING_NET", amount_pence: 1000, driver_id: DRIVER }],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 1100,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.OK);
  assertEquals(result.authorised_campaign_credit_pence, 0);
});

Deno.test("#71A multiple authorised campaigns on same trip", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 1000,
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 1000, driver_id: DRIVER },
      {
        id: "b1",
        type: "BONUS",
        amount_pence: 500,
        driver_id: DRIVER,
        metadata: { source: CAMPAIGN_BONUS_LEDGER_SOURCE, campaign_id: "c1" },
      },
      {
        id: "b2",
        type: "BONUS",
        amount_pence: 700,
        driver_id: DRIVER,
        metadata: { source: CAMPAIGN_BONUS_LEDGER_SOURCE, campaign_id: "c2" },
      },
    ],
    campaign_progress: [
      { campaign_id: "c1", driver_id: DRIVER, ledger_entry_id: "b1", entitled_bonus_amount_pence: 500, credited_at: OLD_CAPTURE },
      { campaign_id: "c2", driver_id: DRIVER, ledger_entry_id: "b2", entitled_bonus_amount_pence: 700, credited_at: OLD_CAPTURE },
    ],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 1100,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.OK);
  assertEquals(result.authorised_campaign_credit_pence, 1200);
  assertEquals(result.unexplained_credit_variance_pence, 0);
});

Deno.test("#71A bonus + tips + net", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 800,
    tip_pence: 200,
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 800, driver_id: DRIVER },
      { type: "DRIVER_TIP_CREDIT", amount_pence: 200, driver_id: DRIVER },
      {
        id: "b1",
        type: "BONUS",
        amount_pence: 2000,
        driver_id: DRIVER,
        metadata: { source: CAMPAIGN_BONUS_LEDGER_SOURCE, campaign_id: CAMPAIGN },
      },
    ],
    campaign_progress: [{
      campaign_id: CAMPAIGN,
      driver_id: DRIVER,
      ledger_entry_id: "b1",
      entitled_bonus_amount_pence: 2000,
      credited_at: OLD_CAPTURE,
    }],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 1200,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.OK);
  assertEquals(result.expected_driver_credit_pence, 1000);
  assertEquals(result.actual_driver_credit_pence, 1000);
  assertEquals(result.authorised_campaign_credit_pence, 2000);
});

Deno.test("#71A Welcome / non-campaign BONUS is other incentive, not overcredit", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 500,
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 500, driver_id: DRIVER },
      {
        id: "welcome",
        type: "BONUS",
        amount_pence: 1001,
        driver_id: DRIVER,
        description: "Welcome Credit / Launch Promotion",
        metadata: {},
      },
    ],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.OK);
  assertEquals(result.actual_driver_credit_pence, 500);
  assertEquals(result.authorised_other_incentive_pence, 1001);
  assertEquals(result.unexplained_credit_variance_pence, 0);
});

Deno.test("#71A duplicate campaign credit → OVER_CREDITED exception", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 500,
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 500, driver_id: DRIVER },
      {
        id: "b1",
        type: "BONUS",
        amount_pence: 2000,
        driver_id: DRIVER,
        metadata: { source: CAMPAIGN_BONUS_LEDGER_SOURCE, campaign_id: CAMPAIGN },
      },
      {
        id: "b2",
        type: "BONUS",
        amount_pence: 2000,
        driver_id: DRIVER,
        metadata: { source: CAMPAIGN_BONUS_LEDGER_SOURCE, campaign_id: CAMPAIGN },
      },
    ],
    campaign_progress: [{
      campaign_id: CAMPAIGN,
      driver_id: DRIVER,
      ledger_entry_id: "b1",
      entitled_bonus_amount_pence: 2000,
      credited_at: OLD_CAPTURE,
    }],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.OVER_CREDITED);
  assertEquals(result.incentive_issues.some((i) => i.code === "DUPLICATE_CAMPAIGN_CREDIT"), true);
});

Deno.test("#71A incorrect campaign amount → excess unexplained", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 500,
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 500, driver_id: DRIVER },
      {
        id: "b1",
        type: "BONUS",
        amount_pence: 2500,
        driver_id: DRIVER,
        metadata: { source: CAMPAIGN_BONUS_LEDGER_SOURCE, campaign_id: CAMPAIGN },
      },
    ],
    campaign_progress: [{
      campaign_id: CAMPAIGN,
      driver_id: DRIVER,
      ledger_entry_id: "b1",
      entitled_bonus_amount_pence: 2000,
      credited_at: OLD_CAPTURE,
    }],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.OVER_CREDITED);
  assertEquals(result.authorised_campaign_credit_pence, 2000);
  assertEquals(result.unexplained_credit_variance_pence, 500);
});

Deno.test("#71A genuine trip overcredit still fires with valid bonus", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "PLATFORM_COLLECTED",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 500,
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 800, driver_id: DRIVER },
      {
        id: "b1",
        type: "BONUS",
        amount_pence: 2000,
        driver_id: DRIVER,
        metadata: { source: CAMPAIGN_BONUS_LEDGER_SOURCE, campaign_id: CAMPAIGN },
      },
    ],
    campaign_progress: [{
      campaign_id: CAMPAIGN,
      driver_id: DRIVER,
      ledger_entry_id: "b1",
      entitled_bonus_amount_pence: 2000,
      credited_at: OLD_CAPTURE,
    }],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 600,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.OVER_CREDITED);
  assertEquals(result.actual_driver_credit_pence, 800);
  assertEquals(result.authorised_campaign_credit_pence, 2000);
  assertEquals(result.credit_difference_pence, 300);
});

Deno.test("#71A DRIVER_COLLECTED remains NOT_APPLICABLE", () => {
  const result = classifyDriverCreditHealth({
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
    trip_status: "completed",
    trip_driver_id: DRIVER,
    driver_net_pence: 500,
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 500, driver_id: DRIVER },
      {
        id: "b1",
        type: "BONUS",
        amount_pence: 2000,
        driver_id: DRIVER,
        metadata: { source: CAMPAIGN_BONUS_LEDGER_SOURCE, campaign_id: CAMPAIGN },
      },
    ],
    wallet_evidence_available: true,
    provider_state: "CAPTURED",
    captured_pence: 0,
    captured_at: OLD_CAPTURE,
    now_ms: NOW,
  });
  assertEquals(result.health, DRIVER_CREDIT_HEALTH.NOT_APPLICABLE);
  assertEquals(result.actual_driver_credit_pence, 0);
});

Deno.test("#71A sumActiveDriverWalletCreditForTrip ignores BONUS", () => {
  const sum = sumActiveDriverWalletCreditForTrip({
    trip_driver_id: DRIVER,
    ledger: [
      { type: "TRIP_EARNING_NET", amount_pence: 2760, driver_id: DRIVER },
      { type: "BONUS", amount_pence: 2000, driver_id: DRIVER },
      { type: "DRIVER_COMPENSATION_CREDIT", amount_pence: 100, driver_id: DRIVER },
    ],
  });
  assertEquals(sum.correct_driver_credit_pence, 2760);
  assertEquals(sum.has_duplicate, false);
});

Deno.test("#71A campaign reversal net zero is not overcredit", () => {
  const incentives = classifyPlatformIncentiveCreditsForTrip({
    trip_driver_id: DRIVER,
    ledger: [
      {
        id: "b1",
        type: "BONUS",
        amount_pence: 2000,
        driver_id: DRIVER,
        metadata: { source: CAMPAIGN_BONUS_LEDGER_SOURCE, campaign_id: CAMPAIGN },
      },
      {
        id: "b1r",
        type: "BONUS",
        amount_pence: -2000,
        driver_id: DRIVER,
        metadata: { source: CAMPAIGN_BONUS_LEDGER_SOURCE, campaign_id: CAMPAIGN },
      },
    ],
    campaign_progress: [{
      campaign_id: CAMPAIGN,
      driver_id: DRIVER,
      ledger_entry_id: "b1",
      entitled_bonus_amount_pence: 2000,
      credited_at: OLD_CAPTURE,
    }],
  });
  assertEquals(incentives.authorised_campaign_credit_pence, 0);
  assertEquals(incentives.incentive_exception_pence, 0);
});
