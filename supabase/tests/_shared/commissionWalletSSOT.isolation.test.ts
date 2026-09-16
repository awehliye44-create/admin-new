/**
 * Deno runner for financial-model SSOT isolation (Vitest 4 needs Vite 6 locally).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  COMMISSION_WALLET_ENTRY_TYPE,
  FINANCIAL_MODEL_VIOLATION,
  INVALID_CONFIGURATION,
  SERVICE_AREA_FINANCIAL_MODEL,
  classifyServiceAreaFinancialPairing,
  deriveBalancesFromCommissionLedgerEntries,
  deriveCommissionWalletBalances,
  isAdminCommissionWalletCreditCustomerFarePromotion,
  isPreservedAdminCommissionWalletCredit,
  planCommissionWalletDeduction,
  planCommissionWalletReserve,
  planCommissionWalletTripPromotion,
  tripUsesCommissionWalletDeduction,
} from "./commissionWalletSSOT.ts";

const mkAfrica = {
  financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
  commission_wallet_enabled: true,
  customer_payment_policy: "DRIVER_COLLECTS_UPFRONT" as const,
};

Deno.test("invalid SA pairing rejected", () => {
  const kampala = classifyServiceAreaFinancialPairing({
    financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
    commission_wallet_enabled: true,
    customer_payment_policy: "PLATFORM_PREPAID",
  });
  assertEquals(kampala.ok, false);
  if (!kampala.ok) assertEquals(kampala.code, INVALID_CONFIGURATION);
});

Deno.test("customer promotion 500/50/15% deducts 25p", () => {
  assertEquals(
    planCommissionWalletTripPromotion({
      prePromotionCommissionableMinor: 500,
      lockedCustomerPromotionMinor: 50,
      commissionRateBps: 1500,
    }),
    {
      customer_pays_minor: 450,
      gross_commission_minor: 75,
      locked_customer_promotion_minor: 50,
      commission_wallet_effect_minor: 25,
      outcome: "deduction",
    },
  );
});

Deno.test("promotion exceeding commission creates subsidy", () => {
  const plan = planCommissionWalletDeduction({
    gateApplies: true,
    commissionableFareMinor: 500,
    commissionRateBps: 1500,
    lockedCustomerPromotionMinor: 90,
    promotionalBalanceMinor: 0,
    purchasedBalanceMinor: 0,
    tripId: "promo-subsidy",
  });
  assertEquals(plan.ok, true);
  if (plan.ok && !plan.skipped) {
    assertEquals(plan.outcome, "subsidy");
    if (plan.outcome === "subsidy") {
      assertEquals(plan.subsidy_minor, 15);
      assertEquals(plan.entry_type, COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_SUBSIDY_CREDIT);
    }
  }
});

Deno.test("Admin CW credit is never customer fare promotion", () => {
  assertEquals(
    isAdminCommissionWalletCreditCustomerFarePromotion({
      entry_type: "ADMIN_CREDIT",
      trip_id: null,
    }),
    false,
  );
  assertEquals(
    isPreservedAdminCommissionWalletCredit({ entry_type: "ADMIN_CREDIT", trip_id: null }),
    true,
  );
});

Deno.test("live SA cannot reclassify a stamped platform trip", () => {
  assertEquals(
    tripUsesCommissionWalletDeduction({
      tripFinancialModel: SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
      tripCommissionWalletEnabled: false,
      serviceAreaConfig: mkAfrica,
    }),
    false,
  );
});

Deno.test("reserve cannot overspend usable balance", () => {
  const first = planCommissionWalletReserve({
    gateApplies: true,
    estimatedFinalFareMinor: 2000,
    commissionRateBps: 1500,
    usableCommissionBalanceMinor: 300,
    driverId: "d1",
    tripId: "t-a",
  });
  assertEquals(first.ok, true);
  const remaining = first.ok ? 300 - first.amount_minor : 0;
  const second = planCommissionWalletReserve({
    gateApplies: true,
    estimatedFinalFareMinor: 2000,
    commissionRateBps: 1500,
    usableCommissionBalanceMinor: remaining,
    driverId: "d1",
    tripId: "t-b",
  });
  assertEquals(second.ok, false);
  if (!second.ok) assertEquals(second.code, "INSUFFICIENT_BALANCE");
});

Deno.test("reserve reduces usable, not display balance", () => {
  const bal = deriveCommissionWalletBalances({
    purchasedBalanceMinor: 500,
    promotionalBalanceMinor: 100,
    reservedBalanceMinor: 50,
  });
  assertEquals(bal.usable_commission_balance_minor, 550);
  assertEquals(bal.commission_wallet_balance_minor, 600);
  assertEquals(bal.reserved_balance_minor, 50);
  const fromLedger = deriveBalancesFromCommissionLedgerEntries([
    { entry_type: "ADMIN_CREDIT", amount_minor: 200, direction: "credit" },
  ]);
  assertEquals(fromLedger.promotional_balance_minor, 200);
  assertEquals(FINANCIAL_MODEL_VIOLATION, "FINANCIAL_MODEL_VIOLATION");
});
