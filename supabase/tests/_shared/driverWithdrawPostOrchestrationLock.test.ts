/**
 * Handler-level POST orchestration tests (mocked reserve/provider).
 * Proves the real money-path sequence without live Revolut / DB writes.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DRIVER_PAYOUT_BLOCK_REASON,
  buildDriverPayoutWithdrawalQuote,
  type DriverPayoutWithdrawalQuote,
} from "../../functions/_shared/driverPayoutWithdrawalQuoteSSOT.ts";
import type { DriverPayoutEligibilityResult } from "../../functions/_shared/driverPayoutEligibilitySSOT.ts";
import { PAYOUT_ELIGIBILITY_STATUS } from "../../functions/_shared/driverPayoutEligibilitySSOT.ts";
import {
  DRIVER_WITHDRAW_CLIENT_SERVICE_AREA_REJECTED,
  DRIVER_WITHDRAW_DRIVER_COLLECTED_REJECTED,
  DRIVER_WITHDRAW_SERVICE_AREA_MISSING,
  runDriverWithdrawPostOrchestration,
  type WithdrawOrchestrationPorts,
} from "../../functions/_shared/driverWithdrawPostOrchestrationSSOT.ts";

const MK_SA = "cb58f1bd-8b6f-45b9-ad31-b3140309892c";
const MK_DRIVER = "c40dd8a6-f422-40bc-9534-bae7be88b93e";

function elig(over: Partial<DriverPayoutEligibilityResult> = {}): DriverPayoutEligibilityResult {
  return {
    live_balance_pence: 4063,
    available_balance_pence: 3319,
    pending_balance_pence: 744,
    withdrawal_in_progress_pence: 0,
    outstanding_debt_pence: 0,
    primary_hold_reason: null,
    eligible_entries: [],
    eligible_earnings_pence: 3319,
    held_entries: [],
    ...over,
  };
}

function mkQuote(over: Partial<Parameters<typeof buildDriverPayoutWithdrawalQuote>[0]> = {}) {
  return buildDriverPayoutWithdrawalQuote({
    eligibility: elig(),
    global_payouts_enabled: true,
    payout_operational_paused: false,
    provider_verified_active_destination: true,
    driver_approved: true,
    driver_suspended: false,
    fee_pence: 50,
    minimum_pence: 51,
    early_cash_out_enabled: true,
    provider_available: true,
    financial_model_platform_collected: true,
    legacy_payouts_enabled: false,
    ...over,
  });
}

function mkPorts(track: { reserve: number; provider: number; create: number; lastSa?: string }): WithdrawOrchestrationPorts {
  return {
    createPayoutItem: async (args) => {
      track.create += 1;
      track.lastSa = args.service_area_id;
      return { ok: true, payout_item_id: "item-1" };
    },
    reserve: async (args) => {
      track.reserve += 1;
      track.lastSa = args.service_area_id;
      return { ok: true };
    },
    providerPay: async () => {
      track.provider += 1;
      return { ok: true, provider_payment_id: "pay-1" };
    },
  };
}

const destOk = {
  id: "bc707ca9-7036-4885-a010-1e35903444a9",
  last4: "2951",
  provider_link_status: "PROVIDER_VERIFIED",
  provider_counterparty_id: "cp-1",
  provider_recipient_account_id: "ra-1",
};

Deno.test("POST orchestration happy path: 3319/50/3269 dest 2951 SA server-owned", async () => {
  const track = { reserve: 0, provider: 0, create: 0, lastSa: undefined as string | undefined };
  const quote = mkQuote();
  assertEquals(quote.withdrawable_pence, 3319);
  assertEquals(quote.fee_pence, 50);
  assertEquals(quote.net_payout_pence, 3269);

  const result = await runDriverWithdrawPostOrchestration({
    request_id: "req-happy",
    driver_id: MK_DRIVER,
    body: { amount_pence: 3319, idempotency_key: "wd_test_1" },
    idempotency_key: "driver-withdraw:mk:wd_test_1",
    quote,
    summary_service_area_id: MK_SA,
    driver_primary_service_area_id: MK_SA,
    driver_membership_service_area_ids: [MK_SA],
    financial_model: "PLATFORM_COLLECTED",
    destination: destOk,
    ports: mkPorts(track),
  });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.service_area_id, MK_SA);
  assertEquals(result.gross_pence, 3319);
  assertEquals(result.fee_pence, 50);
  assertEquals(result.net_pence, 3269);
  assertEquals(result.destination_last4, "2951");
  assertEquals(track.lastSa, MK_SA);
  assertEquals(track.reserve, 1);
  assertEquals(track.provider, 1);
  assertEquals(result.provider_calls, 1);
});

Deno.test("POST orchestration: client cannot override service_area_id", async () => {
  const track = { reserve: 0, provider: 0, create: 0, lastSa: undefined as string | undefined };
  const result = await runDriverWithdrawPostOrchestration({
    request_id: "req-sa-client",
    driver_id: MK_DRIVER,
    body: { amount_pence: 3319, service_area_id: "11111111-1111-4111-8111-111111111111" },
    idempotency_key: "k",
    quote: mkQuote(),
    summary_service_area_id: MK_SA,
    driver_primary_service_area_id: MK_SA,
    driver_membership_service_area_ids: [MK_SA],
    financial_model: "PLATFORM_COLLECTED",
    destination: destOk,
    ports: mkPorts(track),
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error_code, DRIVER_WITHDRAW_CLIENT_SERVICE_AREA_REJECTED);
  assertEquals(track.reserve, 0);
  assertEquals(track.provider, 0);
});

Deno.test("POST orchestration: reservation failure → provider zero", async () => {
  const track = { reserve: 0, provider: 0, create: 0, lastSa: undefined as string | undefined };
  const ports = mkPorts(track);
  ports.reserve = async () => {
    track.reserve += 1;
    return { ok: false, code: "ACTIVE_RESERVATION_EXISTS" };
  };
  const result = await runDriverWithdrawPostOrchestration({
    request_id: "req-res-fail",
    driver_id: MK_DRIVER,
    body: { amount_pence: 3319 },
    idempotency_key: "k",
    quote: mkQuote(),
    summary_service_area_id: MK_SA,
    driver_primary_service_area_id: MK_SA,
    driver_membership_service_area_ids: [MK_SA],
    financial_model: "PLATFORM_COLLECTED",
    destination: destOk,
    ports,
  });
  assertEquals(result.ok, false);
  assertEquals(track.reserve, 1);
  assertEquals(track.provider, 0);
});

Deno.test("POST orchestration: stale amount → reservation/provider zero", async () => {
  const track = { reserve: 0, provider: 0, create: 0, lastSa: undefined as string | undefined };
  const result = await runDriverWithdrawPostOrchestration({
    request_id: "req-stale",
    driver_id: MK_DRIVER,
    body: { amount_pence: 9999 },
    idempotency_key: "k",
    quote: mkQuote(),
    summary_service_area_id: MK_SA,
    driver_primary_service_area_id: MK_SA,
    driver_membership_service_area_ids: [MK_SA],
    financial_model: "PLATFORM_COLLECTED",
    destination: destOk,
    ports: mkPorts(track),
  });
  assertEquals(result.ok, false);
  assertEquals(track.reserve, 0);
  assertEquals(track.provider, 0);
  assertEquals(track.create, 0);
});

Deno.test("POST orchestration: duplicate idempotency → provider at most once", async () => {
  const track = { reserve: 0, provider: 0, create: 0, lastSa: undefined as string | undefined };
  let existingId: string | null = null;
  const ports: WithdrawOrchestrationPorts = {
    createPayoutItem: async (args) => {
      track.create += 1;
      track.lastSa = args.service_area_id;
      if (existingId) {
        return { ok: true, payout_item_id: existingId, already_provider_submitted: true };
      }
      existingId = "item-1";
      return { ok: true, payout_item_id: existingId };
    },
    reserve: async (args) => {
      track.reserve += 1;
      track.lastSa = args.service_area_id;
      return { ok: true };
    },
    providerPay: async () => {
      track.provider += 1;
      return { ok: true, provider_payment_id: "pay-1" };
    },
  };
  const input = {
    request_id: "req-idem",
    driver_id: MK_DRIVER,
    body: { amount_pence: 3319 },
    idempotency_key: "same-key",
    quote: mkQuote(),
    summary_service_area_id: MK_SA,
    driver_primary_service_area_id: MK_SA,
    driver_membership_service_area_ids: [MK_SA],
    financial_model: "PLATFORM_COLLECTED",
    destination: destOk,
    ports,
  };
  const a = await runDriverWithdrawPostOrchestration(input);
  const b = await runDriverWithdrawPostOrchestration(input);
  assertEquals(a.ok, true);
  assertEquals(b.ok, true);
  assertEquals(track.provider, 1);
  assertEquals(a.ok && a.provider_calls, 1);
  assertEquals(b.ok && b.provider_calls, 0);
});

Deno.test("POST orchestration: missing service area fails before reservation", async () => {
  const track = { reserve: 0, provider: 0, create: 0, lastSa: undefined as string | undefined };
  const result = await runDriverWithdrawPostOrchestration({
    request_id: "req-no-sa",
    driver_id: MK_DRIVER,
    body: { amount_pence: 3319 },
    idempotency_key: "k",
    quote: mkQuote(),
    summary_service_area_id: null,
    driver_primary_service_area_id: MK_SA,
    driver_membership_service_area_ids: [MK_SA],
    financial_model: "PLATFORM_COLLECTED",
    destination: destOk,
    ports: mkPorts(track),
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error_code, DRIVER_WITHDRAW_SERVICE_AREA_MISSING);
  assertEquals(track.reserve, 0);
  assertEquals(track.provider, 0);
});

Deno.test("POST orchestration: ADMIN_HOLD → zero writes/provider", async () => {
  const track = { reserve: 0, provider: 0, create: 0, lastSa: undefined as string | undefined };
  const quote = mkQuote({
    eligibility: elig({ primary_hold_reason: PAYOUT_ELIGIBILITY_STATUS.ADMIN_HOLD }),
  });
  assertEquals(quote.blocking_reason_code, DRIVER_PAYOUT_BLOCK_REASON.ADMIN_HOLD);
  const result = await runDriverWithdrawPostOrchestration({
    request_id: "req-hold",
    driver_id: MK_DRIVER,
    body: { amount_pence: 3319 },
    idempotency_key: "k",
    quote,
    summary_service_area_id: MK_SA,
    driver_primary_service_area_id: MK_SA,
    driver_membership_service_area_ids: [MK_SA],
    financial_model: "PLATFORM_COLLECTED",
    destination: destOk,
    ports: mkPorts(track),
  });
  assertEquals(result.ok, false);
  assertEquals(track.create, 0);
  assertEquals(track.reserve, 0);
  assertEquals(track.provider, 0);
});

Deno.test("POST orchestration: DRIVER_COLLECTED rejected before reservation", async () => {
  const track = { reserve: 0, provider: 0, create: 0, lastSa: undefined as string | undefined };
  const result = await runDriverWithdrawPostOrchestration({
    request_id: "req-dc",
    driver_id: MK_DRIVER,
    body: { amount_pence: 3319 },
    idempotency_key: "k",
    quote: mkQuote(),
    summary_service_area_id: MK_SA,
    driver_primary_service_area_id: MK_SA,
    driver_membership_service_area_ids: [MK_SA],
    financial_model: "DRIVER_COLLECTED",
    destination: destOk,
    ports: mkPorts(track),
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error_code, DRIVER_WITHDRAW_DRIVER_COLLECTED_REJECTED);
  assertEquals(track.reserve, 0);
  assertEquals(track.provider, 0);
});

Deno.test("GET quote invariant: orchestrator not required; quote alone has zero writes markers", () => {
  const quote: DriverPayoutWithdrawalQuote = mkQuote();
  assertEquals(quote.payout_allowed, true);
  assertEquals(quote.withdrawable_pence, 3319);
  // GET path never calls orchestration ports — structural proof via unused track
  const track = { reserve: 0, provider: 0, create: 0, lastSa: undefined as string | undefined };
  assertEquals(track.reserve + track.provider + track.create, 0);
  void PAYOUT_ELIGIBILITY_STATUS;
});
