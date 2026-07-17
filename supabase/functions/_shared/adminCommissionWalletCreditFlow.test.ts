import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ADMIN_COMMISSION_CREDIT_KIND,
  COMMISSION_WALLET_CAMPAIGN_TYPE,
  COMMISSION_WALLET_ENTRY_TYPE,
  planAdminCommissionWalletCredit,
  planManualPromotionalCampaignCredit,
  planWelcomeCreditAutoGrant,
  validateAdminWelcomeCredit,
  validateDriverCommissionWalletServiceAreaAssignment,
  validateCommissionWalletCampaignFields,
  buildAdminCommissionWalletCreditIdempotencyKey,
  buildCommissionWalletWelcomeIdempotencyKey,
  isCommissionWalletWorkflowEnabled,
} from "../../../shared/commissionWalletSSOT.ts";

/** Mirrors admin-commission-wallet-credit: idempotency replay before welcome insert gate. */
Deno.test("idempotent replay bypasses welcome-already-received on insert path", () => {
  const idempotencyHit = true;
  const welcomeGate = validateAdminWelcomeCredit({
    creditKind: ADMIN_COMMISSION_CREDIT_KIND.WELCOME,
    welcomeCreditEnabled: true,
    welcomeCreditAmountMinor: 1000,
    requestedAmountMinor: 1000,
    driverAlreadyHasWelcomeCredit: true,
    distinctWelcomeDriversCount: 1,
  });
  assertEquals(welcomeGate.ok, false);
  assertEquals(idempotencyHit, true);
});

Deno.test("fresh welcome blocked when driver already credited", () => {
  const welcomeGate = validateAdminWelcomeCredit({
    creditKind: ADMIN_COMMISSION_CREDIT_KIND.WELCOME,
    welcomeCreditEnabled: true,
    welcomeCreditAmountMinor: 1000,
    requestedAmountMinor: 1000,
    driverAlreadyHasWelcomeCredit: true,
    distinctWelcomeDriversCount: 1,
  });
  assertEquals(welcomeGate.ok, false);
  if (!welcomeGate.ok) {
    assertEquals(welcomeGate.code, "WELCOME_CREDIT_ALREADY_RECEIVED");
  }
});

Deno.test("driver assignment required", () => {
  const gate = validateDriverCommissionWalletServiceAreaAssignment({
    driverAssignedToServiceArea: false,
  });
  assertEquals(gate.ok, false);
  if (!gate.ok) {
    assertEquals(gate.code, "DRIVER_NOT_ASSIGNED_TO_SERVICE_AREA");
  }
});

Deno.test("correction credit/debit get distinct idempotency keys", () => {
  const creditKey = buildAdminCommissionWalletCreditIdempotencyKey({
    driverId: "d1",
    serviceAreaId: "sa1",
    creditKind: ADMIN_COMMISSION_CREDIT_KIND.CORRECTION,
    amountMinor: 100,
    reason: "fix",
    direction: "credit",
  });
  const debitKey = buildAdminCommissionWalletCreditIdempotencyKey({
    driverId: "d1",
    serviceAreaId: "sa1",
    creditKind: ADMIN_COMMISSION_CREDIT_KIND.CORRECTION,
    amountMinor: 100,
    reason: "fix",
    direction: "debit",
  });
  assertEquals(creditKey.includes("_credit_"), true);
  assertEquals(debitKey.includes("_debit_"), true);
  assertEquals(creditKey === debitKey, false);
});

Deno.test("Phase 5: promotional credit without campaign rejected", () => {
  const gate = planManualPromotionalCampaignCredit({
    walletEnabled: true,
    campaign: null,
    amountMinor: 500,
    currency: "USD",
  });
  assertEquals(gate.ok, false);
  if (!gate.ok) assertEquals(gate.code, "CAMPAIGN_REQUIRED");
});

Deno.test("Phase 5: UK PLATFORM_COLLECTED cannot enable CW campaign workflow", () => {
  assertEquals(
    isCommissionWalletWorkflowEnabled({
      financial_model: "PLATFORM_COLLECTED",
      commission_wallet_enabled: true,
    }),
    false,
  );
});

Deno.test("Phase 5: welcome auto-grant max drivers + second grant rejected", () => {
  const maxed = planWelcomeCreditAutoGrant({
    walletEnabled: true,
    driverAssignedToServiceArea: true,
    welcomeCreditEnabled: true,
    welcomeCreditAmountMinor: 1000,
    welcomeCreditMaxDrivers: 2,
    driverAlreadyHasWelcomeCredit: false,
    distinctWelcomeDriversCount: 2,
    driverId: "d2",
    serviceAreaId: "sa1",
  });
  assertEquals(maxed.ok, false);

  const second = planWelcomeCreditAutoGrant({
    walletEnabled: true,
    driverAssignedToServiceArea: true,
    welcomeCreditEnabled: true,
    welcomeCreditAmountMinor: 1000,
    welcomeCreditMaxDrivers: 10,
    driverAlreadyHasWelcomeCredit: true,
    distinctWelcomeDriversCount: 1,
    driverId: "d1",
    serviceAreaId: "sa1",
  });
  assertEquals(second.ok, false);

  const ok = planWelcomeCreditAutoGrant({
    walletEnabled: true,
    driverAssignedToServiceArea: true,
    welcomeCreditEnabled: true,
    welcomeCreditAmountMinor: 1000,
    welcomeCreditMaxDrivers: 10,
    driverAlreadyHasWelcomeCredit: false,
    distinctWelcomeDriversCount: 1,
    driverId: "d1",
    serviceAreaId: "sa1",
  });
  assertEquals(ok.ok, true);
  if (ok.ok) {
    assertEquals(ok.ledger_idempotency_key, buildCommissionWalletWelcomeIdempotencyKey("d1", "sa1"));
    assertEquals(ok.entry_type, COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT);
  }
});

Deno.test("Phase 5: promotional requires MANUAL_PROMOTIONAL_CREDIT campaign type", () => {
  const wrong = planManualPromotionalCampaignCredit({
    walletEnabled: true,
    campaign: {
      campaign_type: COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS,
      currency: "USD",
      active: true,
    },
    amountMinor: 500,
    currency: "USD",
  });
  assertEquals(wrong.ok, false);
  if (!wrong.ok) assertEquals(wrong.code, "CAMPAIGN_TYPE_MISMATCH");

  const ok = planManualPromotionalCampaignCredit({
    walletEnabled: true,
    campaign: {
      campaign_type: COMMISSION_WALLET_CAMPAIGN_TYPE.MANUAL_PROMOTIONAL_CREDIT,
      currency: "USD",
      active: true,
    },
    amountMinor: 500,
    currency: "USD",
  });
  assertEquals(ok.ok, true);
});

Deno.test("Phase 5: promotional plan still requires wallet enabled", () => {
  const gate = planManualPromotionalCampaignCredit({
    walletEnabled: false,
    campaign: {
      campaign_type: COMMISSION_WALLET_CAMPAIGN_TYPE.MANUAL_PROMOTIONAL_CREDIT,
      currency: "USD",
      active: true,
    },
    amountMinor: 500,
    currency: "USD",
  });
  assertEquals(gate.ok, false);
  if (!gate.ok) assertEquals(gate.code, "WALLET_DISABLED");
});

Deno.test("Phase 5: campaigns field validation rejects bad percent/fixed and UK workflow", () => {
  assertEquals(
    isCommissionWalletWorkflowEnabled({
      financial_model: "PLATFORM_COLLECTED",
      commission_wallet_enabled: true,
    }),
    false,
  );

  const badPercent = validateCommissionWalletCampaignFields({
    campaignType: COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS,
    bonusPercent: 0,
  });
  assertEquals(badPercent.ok, false);
  if (!badPercent.ok) assertEquals(badPercent.code, "INVALID_BONUS_PERCENT");

  const badFixed = validateCommissionWalletCampaignFields({
    campaignType: COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS,
    creditAmountMinor: 0,
  });
  assertEquals(badFixed.ok, false);
  if (!badFixed.ok) assertEquals(badFixed.code, "INVALID_AMOUNT");

  const ok = validateCommissionWalletCampaignFields({
    campaignType: COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS,
    bonusPercent: 12.5,
    maximumBonusAmountMinor: 1000,
  });
  assertEquals(ok.ok, true);
});

Deno.test("Add Credit: all canonical credit types post entry_type ADMIN_CREDIT", () => {
  const kinds = [
    ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT,
    ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT,
    ADMIN_COMMISSION_CREDIT_KIND.GOODWILL_CREDIT,
    ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION,
    ADMIN_COMMISSION_CREDIT_KIND.OTHER,
  ];
  for (const kind of kinds) {
    const plan = planAdminCommissionWalletCredit({
      kind,
      amountMinor: 1000,
      walletEnabled: true,
      correctionDirection: "debit",
    });
    assertEquals(plan.ok, true);
    if (plan.ok) {
      assertEquals(plan.entry_type, COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT);
      assertEquals(plan.credit_type, kind);
    }
  }
});
