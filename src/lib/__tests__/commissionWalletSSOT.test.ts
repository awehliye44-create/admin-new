import { describe, expect, it } from "vitest";
import {
  ADMIN_COMMISSION_CREDIT_KIND,
  ADMIN_COMMISSION_CREDIT_TYPES,
  COMMISSION_WALLET_ENTRY_TYPE,
  COMMISSION_WALLET_FORBIDDEN_ACTIONS,
  SERVICE_AREA_FINANCIAL_MODEL,
  assertCommissionWalletDoesNotTouchDriverWalletLedger,
  buildTripFinancialModelSnapshot,
  commissionableFareMinor,
  deriveBalancesFromCommissionLedgerEntries,
  deriveCommissionWalletBalances,
  commissionWalletDisplayBalanceMinor,
  isCommissionWalletWorkflowEnabled,
  isPlatformCollectedFinancialModel,
  onecabCommissionDeductionMinor,
  planAdminCommissionWalletCredit,
  validateAdminCommissionCreditReason,
  isWelcomeCommissionWalletLedgerEntry,
  requiredCommissionReserveMinor,
  shouldApplyCommissionWalletDispatchGate,
  shouldShowDriverCommissionWalletPage,
  splitCommissionConsumption,
  validateAdminWelcomeCredit,
  validateAdminCommissionWalletCreditContext,
  validateDriverCommissionWalletServiceAreaAssignment,
  isDriverEligibleForAdminCommissionCredit,
  matchesAdminCommissionCreditDriverSearch,
  aggregateCommissionWalletOverviewCards,
  buildAdminCommissionWalletCreditIdempotencyKey,
  planDriverCommissionWalletPageAccess,
  planCommissionWalletTopupInitiate,
  planCommissionWalletTopupConfirm,
  planCommissionWalletTopupReversal,
  shouldEnableDriverCommissionWalletTopup,
  canTransitionCommissionTopupStatus,
  buildCommissionWalletTopupIdempotencyKey,
  buildCommissionWalletTopupCreditIdempotencyKey,
  buildCommissionWalletTopupBonusIdempotencyKey,
  COMMISSION_TOPUP_STATUS,
  COMMISSION_TOPUP_PROVIDER,
  COMMISSION_WALLET_CAMPAIGN_TYPE,
  planCommissionWalletTopupBonus,
  planWelcomeCreditAutoGrant,
  planManualPromotionalCampaignCredit,
  validateCommissionWalletCampaignFields,
  planCommissionWalletDispatchEligibility,
  planCommissionWalletReserve,
  planCommissionWalletReserveRelease,
  planCommissionWalletDeduction,
  tripUsesCommissionWalletDeduction,
  buildCommissionWalletDriverRosterRow,
  isCommissionWalletOfferEligibleFromBalances,
  planCommissionWalletServiceAreaMove,
  COMMISSION_WALLET_SETUP_ERROR,
  excludeTripFromPlatformCollectedFinance,
  aggregateCommissionWalletFinanceReport,
  buildCommissionWalletDeductionIdempotencyKey,
  buildCommissionWalletReserveIdempotencyKey,
  buildCommissionWalletReserveReleaseIdempotencyKey,
  commissionPercentToBps,
  estimatedFinalFareMinorFromTrip,
  REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION,
} from "../../../shared/commissionWalletSSOT";

const mkPlatform = {
  financial_model: SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
  commission_wallet_enabled: false,
};

const mkAfrica = {
  financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
  commission_wallet_enabled: true,
  commission_reserve_enabled: true,
  customer_payment_policy: "DRIVER_COLLECTS_UPFRONT" as const,
  commission_wallet_currency: "USD",
};

describe("commissionWalletSSOT isolation", () => {
  it("1: PLATFORM_COLLECTED remains the default isolation path", () => {
    expect(isCommissionWalletWorkflowEnabled(mkPlatform)).toBe(false);
    expect(isPlatformCollectedFinancialModel(mkPlatform)).toBe(true);
    expect(shouldShowDriverCommissionWalletPage(mkPlatform)).toBe(false);
    expect(shouldApplyCommissionWalletDispatchGate(mkPlatform)).toBe(false);
    expect(buildTripFinancialModelSnapshot({
      serviceAreaId: "sa-uk",
      currency: "GBP",
      commissionRateBps: 1500,
      config: mkPlatform,
    })).toBeNull();
  });

  it("2: Commission Wallet invisible when disabled even if model string set", () => {
    expect(
      isCommissionWalletWorkflowEnabled({
        financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
        commission_wallet_enabled: false,
      }),
    ).toBe(false);
    expect(shouldShowDriverCommissionWalletPage({
      financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
      commission_wallet_enabled: false,
    })).toBe(false);
  });

  it("3: only explicitly assigned SA enables workflow (not currency alone)", () => {
    expect(
      isCommissionWalletWorkflowEnabled({
        financial_model: SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
        commission_wallet_enabled: false,
        commission_wallet_currency: "USD",
      }),
    ).toBe(false);
    expect(isCommissionWalletWorkflowEnabled(mkAfrica)).toBe(true);
    expect(shouldShowDriverCommissionWalletPage(mkAfrica)).toBe(true);
    expect(shouldShowDriverCommissionWalletPage(mkAfrica, {
      commissionWalletTestAccess: false,
    })).toBe(true);
  });

  it("dispatch eligibility applies whenever CW workflow is enabled (reserve flag ignored)", () => {
    expect(
      shouldApplyCommissionWalletDispatchGate({
        ...mkAfrica,
        commission_reserve_enabled: false,
      }),
    ).toBe(true);
    expect(shouldApplyCommissionWalletDispatchGate(mkAfrica)).toBe(true);
    expect(shouldApplyCommissionWalletDispatchGate(mkPlatform)).toBe(false);
  });

  it("builds trip snapshot only for enabled Africa SA", () => {
    const snap = buildTripFinancialModelSnapshot({
      serviceAreaId: "sa-moga",
      regionId: "reg-so",
      currency: "USD",
      commissionRateBps: 1500,
      config: mkAfrica,
    });
    expect(snap).toMatchObject({
      financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
      commission_wallet_enabled: true,
      commission_rate_bps: 1500,
      currency: "USD",
      service_area_id: "sa-moga",
    });
  });

  it("11/12 reserve math from estimated fare × rate bps", () => {
    expect(
      requiredCommissionReserveMinor({
        estimatedFinalFareMinor: 2000,
        commissionRateBps: 1500,
      }),
    ).toBe(300);
  });

  it("16 commission deduction from commissionable fare", () => {
    const commissionable = commissionableFareMinor({
      finalFareAfterNegotiationMinor: 2000,
      airportChargeMinor: 0,
      discountsMinor: 0,
    });
    expect(commissionable).toBe(2000);
    expect(
      onecabCommissionDeductionMinor({
        commissionableFareMinor: commissionable,
        commissionRateBps: 1500,
      }),
    ).toBe(300);
  });

  it("10 promotional preferred then purchased; withdrawable always 0", () => {
    const split = splitCommissionConsumption({
      deductionMinor: 300,
      promotionalBalanceMinor: 100,
      purchasedBalanceMinor: 500,
    });
    expect(split).toEqual({
      promotional_portion_minor: 100,
      purchased_portion_minor: 200,
    });
    const bal = deriveCommissionWalletBalances({
      purchasedBalanceMinor: 500,
      promotionalBalanceMinor: 100,
      reservedBalanceMinor: 50,
    });
    expect(bal.usable_commission_balance_minor).toBe(600);
    expect(bal.commission_wallet_balance_minor).toBe(600);
    expect(bal.reserved_balance_minor).toBe(0);
    expect(bal.withdrawable_balance_minor).toBe(0);
    expect(bal.payout_due_minor).toBe(0);
    expect(commissionWalletDisplayBalanceMinor(bal)).toBe(600);
  });

  it("forbids withdraw/payout/transfer actions in SSOT list", () => {
    expect(COMMISSION_WALLET_FORBIDDEN_ACTIONS).toContain("Withdraw");
    expect(COMMISSION_WALLET_FORBIDDEN_ACTIONS).toContain("Cash Out");
    expect(COMMISSION_WALLET_FORBIDDEN_ACTIONS).toContain("Transfer");
    expect(assertCommissionWalletDoesNotTouchDriverWalletLedger()).toBe(true);
  });
  it("shows Commission Wallet when SA workflow is enabled (no test-flag gate)", () => {
    expect(shouldShowDriverCommissionWalletPage(mkAfrica, {
      commissionWalletTestAccess: false,
    })).toBe(true);
    expect(planDriverCommissionWalletPageAccess({
      config: mkAfrica,
      commissionWalletTestAccess: false,
      hasServiceArea: true,
    })).toMatchObject({ ok: true, page_visible: true });
    expect(planDriverCommissionWalletPageAccess({
      config: mkAfrica,
      commissionWalletTestAccess: true,
      hasServiceArea: false,
    })).toMatchObject({ ok: false, code: "NO_SERVICE_AREA" });
    expect(planDriverCommissionWalletPageAccess({
      config: mkPlatform,
      commissionWalletTestAccess: true,
      hasServiceArea: true,
    })).toMatchObject({ ok: false, code: "WALLET_DISABLED" });
    expect(planDriverCommissionWalletPageAccess({
      config: mkAfrica,
      commissionWalletTestAccess: true,
      hasServiceArea: true,
    })).toMatchObject({ ok: true, page_visible: true });
  });
});

describe("Phase 2 admin credit plan", () => {
  it("rejects credits when wallet disabled (UK/EU isolation)", () => {
    const plan = planAdminCommissionWalletCredit({
      kind: ADMIN_COMMISSION_CREDIT_KIND.OTHER,
      amountMinor: 1000,
      walletEnabled: false,
    });
    expect(plan).toMatchObject({ ok: false, code: "WALLET_DISABLED" });
  });

  it("rejects forbidden actions", () => {
    const plan = planAdminCommissionWalletCredit({
      kind: ADMIN_COMMISSION_CREDIT_KIND.OTHER,
      amountMinor: 1000,
      walletEnabled: true,
      forbiddenAction: "Withdraw",
    });
    expect(plan).toMatchObject({ ok: false, code: "FORBIDDEN_ACTION" });
  });

  it("plans welcome/promotional/goodwill/other credits as ADMIN_CREDIT with credit_type", () => {
    expect(planAdminCommissionWalletCredit({
      kind: ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT,
      amountMinor: 500,
      walletEnabled: true,
    })).toMatchObject({
      ok: true,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
      credit_type: ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT,
      direction: "credit",
      balance_bucket: "promotional",
    });
    expect(planAdminCommissionWalletCredit({
      kind: ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT,
      amountMinor: 700,
      walletEnabled: true,
    })).toMatchObject({
      ok: true,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
      credit_type: ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT,
    });
    expect(planAdminCommissionWalletCredit({
      kind: ADMIN_COMMISSION_CREDIT_KIND.GOODWILL_CREDIT,
      amountMinor: 800,
      walletEnabled: true,
    })).toMatchObject({
      ok: true,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
      credit_type: ADMIN_COMMISSION_CREDIT_KIND.GOODWILL_CREDIT,
    });
    expect(planAdminCommissionWalletCredit({
      kind: ADMIN_COMMISSION_CREDIT_KIND.OTHER,
      amountMinor: 900,
      walletEnabled: true,
    })).toMatchObject({
      ok: true,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
      credit_type: ADMIN_COMMISSION_CREDIT_KIND.OTHER,
      amount_minor: 900,
    });
    // Legacy MANUAL alias → OTHER / ADMIN_CREDIT
    expect(planAdminCommissionWalletCredit({
      kind: ADMIN_COMMISSION_CREDIT_KIND.MANUAL,
      amountMinor: 900,
      walletEnabled: true,
    })).toMatchObject({
      ok: true,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
      credit_type: ADMIN_COMMISSION_CREDIT_KIND.OTHER,
    });
  });

  it("plans compensating support correction as ADMIN_CREDIT debit/credit", () => {
    expect(planAdminCommissionWalletCredit({
      kind: ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION,
      amountMinor: 250,
      walletEnabled: true,
      correctionDirection: "debit",
    })).toMatchObject({
      ok: true,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
      credit_type: ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION,
      direction: "debit",
    });
    // Legacy CORRECTION alias
    expect(planAdminCommissionWalletCredit({
      kind: ADMIN_COMMISSION_CREDIT_KIND.CORRECTION,
      amountMinor: 250,
      walletEnabled: true,
      correctionDirection: "debit",
    })).toMatchObject({
      ok: true,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
      credit_type: ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION,
    });
  });

  it("detects welcome credits from legacy entry_type or ADMIN_CREDIT credit_type", () => {
    expect(isWelcomeCommissionWalletLedgerEntry({
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT,
    })).toBe(true);
    expect(isWelcomeCommissionWalletLedgerEntry({
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
      metadata: { credit_type: ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT },
    })).toBe(true);
    expect(isWelcomeCommissionWalletLedgerEntry({
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
      metadata: { credit_type: ADMIN_COMMISSION_CREDIT_KIND.OTHER },
    })).toBe(false);
  });

  it("Add Credit: every canonical credit type posts entry_type ADMIN_CREDIT", () => {
    for (const creditType of ADMIN_COMMISSION_CREDIT_TYPES) {
      const plan = planAdminCommissionWalletCredit({
        kind: creditType,
        amountMinor: 1000,
        walletEnabled: true,
        correctionDirection: "debit",
      });
      expect(plan).toMatchObject({
        ok: true,
        entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
        credit_type: creditType,
      });
    }
  });

  it("derives balances from admin credit ledger rows without touching payout", () => {
    const bal = deriveBalancesFromCommissionLedgerEntries([
      {
        entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
        amount_minor: 1000,
        direction: "credit",
      },
      {
        entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CORRECTION,
        amount_minor: 200,
        direction: "debit",
      },
    ]);
    expect(bal.promotional_balance_minor).toBe(800);
    expect(bal.withdrawable_balance_minor).toBe(0);
    expect(bal.payout_due_minor).toBe(0);
  });
});

describe("Admin credit reason validation", () => {
  it("rejects empty, whitespace-only, and too-short reasons", () => {
    expect(validateAdminCommissionCreditReason("")).toMatchObject({
      ok: false,
      code: "REASON_REQUIRED",
    });
    expect(validateAdminCommissionCreditReason("   ")).toMatchObject({
      ok: false,
      code: "REASON_REQUIRED",
    });
    expect(validateAdminCommissionCreditReason("short")).toMatchObject({
      ok: false,
      code: "REASON_TOO_SHORT",
    });
    expect(validateAdminCommissionCreditReason(
      "First 100 approved drivers launch promotion",
    )).toMatchObject({
      ok: true,
      reason: "First 100 approved drivers launch promotion",
    });
  });
});

describe("Phase 2 admin credit gates", () => {
  it("rejects credit when driver not assigned to service area", () => {
    expect(validateDriverCommissionWalletServiceAreaAssignment({
      driverAssignedToServiceArea: false,
    })).toMatchObject({ ok: false, code: "DRIVER_NOT_ASSIGNED_TO_SERVICE_AREA" });
  });

  it("re-validates canonical driver/service-area/CW context before ADMIN_CREDIT", () => {
    expect(validateAdminCommissionWalletCreditContext({
      driverFound: false,
      driverServiceAreaId: null,
      selectedServiceAreaId: "sa-1",
      financialModel: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
      commissionWalletEnabled: true,
      expectedCurrency: "USD",
      requestedCurrency: "USD",
    })).toMatchObject({ ok: false, code: "DRIVER_NOT_FOUND" });

    expect(validateAdminCommissionWalletCreditContext({
      driverFound: true,
      driverServiceAreaId: "sa-nairobi",
      selectedServiceAreaId: "sa-mogadishu",
      financialModel: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
      commissionWalletEnabled: true,
      expectedCurrency: "USD",
      requestedCurrency: "USD",
    })).toMatchObject({ ok: false, code: "DRIVER_NOT_ASSIGNED_TO_SERVICE_AREA" });

    expect(validateAdminCommissionWalletCreditContext({
      driverFound: true,
      driverServiceAreaId: "sa-1",
      selectedServiceAreaId: "sa-1",
      financialModel: SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
      commissionWalletEnabled: true,
      expectedCurrency: "USD",
      requestedCurrency: "USD",
    })).toMatchObject({ ok: false, code: "INVALID_FINANCIAL_MODEL" });

    expect(validateAdminCommissionWalletCreditContext({
      driverFound: true,
      driverServiceAreaId: "sa-1",
      selectedServiceAreaId: "sa-1",
      financialModel: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
      commissionWalletEnabled: false,
      expectedCurrency: "USD",
      requestedCurrency: "USD",
    })).toMatchObject({ ok: false, code: "COMMISSION_WALLET_DISABLED" });

    expect(validateAdminCommissionWalletCreditContext({
      driverFound: true,
      driverServiceAreaId: "sa-1",
      selectedServiceAreaId: "sa-1",
      financialModel: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
      commissionWalletEnabled: true,
      expectedCurrency: "USD",
      requestedCurrency: "GBP",
    })).toMatchObject({ ok: false, code: "CURRENCY_MISMATCH" });

    expect(isDriverEligibleForAdminCommissionCredit({
      approvalStatus: "approved",
      driverStatus: "active",
      driverServiceAreaId: "sa-1",
      selectedServiceAreaId: "sa-1",
    })).toBe(true);

    expect(matchesAdminCommissionCreditDriverSearch({
      id: "uuid-1",
      driver_code: "DRV-SO-0001",
      first_name: "Ahmed",
      last_name: "Driver",
      phone: "+252611",
      license_plate: "ABC123",
    }, "ABC")).toBe(true);
  });

  it("enforces welcome credit SA policy", () => {
    expect(validateAdminWelcomeCredit({
      creditKind: ADMIN_COMMISSION_CREDIT_KIND.MANUAL,
      welcomeCreditEnabled: false,
      requestedAmountMinor: 500,
      driverAlreadyHasWelcomeCredit: false,
      distinctWelcomeDriversCount: 0,
    })).toEqual({ ok: true });

    expect(validateAdminWelcomeCredit({
      creditKind: ADMIN_COMMISSION_CREDIT_KIND.WELCOME,
      welcomeCreditEnabled: false,
      requestedAmountMinor: 500,
      driverAlreadyHasWelcomeCredit: false,
      distinctWelcomeDriversCount: 0,
    })).toMatchObject({ ok: false, code: "WELCOME_CREDIT_DISABLED" });

    expect(validateAdminWelcomeCredit({
      creditKind: ADMIN_COMMISSION_CREDIT_KIND.WELCOME,
      welcomeCreditEnabled: true,
      welcomeCreditAmountMinor: 1000,
      requestedAmountMinor: 500,
      driverAlreadyHasWelcomeCredit: false,
      distinctWelcomeDriversCount: 0,
    })).toMatchObject({ ok: false, code: "WELCOME_CREDIT_AMOUNT_MISMATCH" });

    expect(validateAdminWelcomeCredit({
      creditKind: ADMIN_COMMISSION_CREDIT_KIND.WELCOME,
      welcomeCreditEnabled: true,
      welcomeCreditAmountMinor: 1000,
      requestedAmountMinor: 1000,
      driverAlreadyHasWelcomeCredit: true,
      distinctWelcomeDriversCount: 1,
    })).toMatchObject({ ok: false, code: "WELCOME_CREDIT_ALREADY_RECEIVED" });

    expect(validateAdminWelcomeCredit({
      creditKind: ADMIN_COMMISSION_CREDIT_KIND.WELCOME,
      welcomeCreditEnabled: true,
      requestedAmountMinor: 1000,
      driverAlreadyHasWelcomeCredit: false,
      distinctWelcomeDriversCount: 5,
      welcomeCreditMaxDrivers: 5,
    })).toMatchObject({ ok: false, code: "WELCOME_CREDIT_MAX_DRIVERS_REACHED" });
  });

  it("aggregates overview cards from full ledger slices", () => {
    expect(aggregateCommissionWalletOverviewCards([
      { entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION, amount_minor: 300 },
      { entry_type: COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT, amount_minor: 500 },
      { entry_type: COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT, amount_minor: 2000 },
      { entry_type: COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_REVERSAL, amount_minor: 100 },
    ])).toEqual({
      commission_collected_minor: 300,
      campaign_credits_minor: 500,
      provider_topups_minor: 2000,
      reversals_minor: 100,
    });
  });

  it("builds distinct correction idempotency keys for credit vs debit", () => {
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
    expect(creditKey).not.toEqual(debitKey);
    expect(creditKey).toContain("_credit_");
    expect(debitKey).toContain("_debit_");
  });
});

describe("Phase 4 provider sandbox top-up", () => {
  const mkAfricaTopup = {
    ...mkAfrica,
    commission_topup_provider: COMMISSION_TOPUP_PROVIDER.WAAFI_PAY,
    commission_wallet_topup_enabled: true,
  };

  it("enables top-up only when workflow + topup flag + provider", () => {
    expect(shouldEnableDriverCommissionWalletTopup({
      config: mkAfricaTopup,
    })).toBe(true);
    expect(shouldEnableDriverCommissionWalletTopup({
      config: {
        ...mkAfrica,
        commission_topup_provider: COMMISSION_TOPUP_PROVIDER.WAAFI_PAY,
        commission_wallet_topup_enabled: false,
      },
    })).toBe(false);
    expect(shouldEnableDriverCommissionWalletTopup({
      config: {
        ...mkAfrica,
        commission_wallet_topup_enabled: true,
      },
    })).toBe(false);
    expect(shouldEnableDriverCommissionWalletTopup({
      config: mkPlatform,
    })).toBe(false);
  });

  it("plans initiate with currency and provider gates", () => {
    expect(planCommissionWalletTopupInitiate({
      walletEnabled: true,
      topupEnabled: true,
      provider: "waafi_pay",
      amountMinor: 1000,
      currency: "USD",
      walletCurrency: "USD",
    })).toMatchObject({ ok: true, amount_minor: 1000, provider: "waafi_pay", sandbox: true });

    expect(planCommissionWalletTopupInitiate({
      walletEnabled: false,
      topupEnabled: true,
      provider: "waafi_pay",
      amountMinor: 1000,
      currency: "USD",
      walletCurrency: "USD",
    })).toMatchObject({ ok: false, code: "WALLET_DISABLED" });

    expect(planCommissionWalletTopupInitiate({
      walletEnabled: true,
      topupEnabled: true,
      provider: "paystack",
      amountMinor: 1000,
      currency: "USD",
      walletCurrency: "USD",
    })).toMatchObject({ ok: false, code: "PROVIDER_UNSUPPORTED" });

    expect(planCommissionWalletTopupInitiate({
      walletEnabled: true,
      topupEnabled: false,
      provider: "waafi_pay",
      amountMinor: 1000,
      currency: "USD",
      walletCurrency: "USD",
    })).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });

    expect(planCommissionWalletTopupInitiate({
      walletEnabled: true,
      topupEnabled: true,
      provider: "waafi_pay",
      amountMinor: 1000,
      currency: "KES",
      walletCurrency: "USD",
    })).toMatchObject({ ok: false, code: "CURRENCY_MISMATCH" });
  });

  it("plans confirm with amount match and idempotent succeeded", () => {
    const plan = planCommissionWalletTopupConfirm({
      currentStatus: COMMISSION_TOPUP_STATUS.PROCESSING,
      topupAmountMinor: 2500,
      topupCurrency: "USD",
      confirmedAmountMinor: 2500,
      confirmedCurrency: "USD",
      providerTransactionId: "sandbox_abc",
      topupId: "topup-1",
    });
    expect(plan).toMatchObject({
      ok: true,
      already_succeeded: false,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT,
      purchased_portion_minor: 2500,
      promotional_portion_minor: 0,
    });

    expect(planCommissionWalletTopupConfirm({
      currentStatus: COMMISSION_TOPUP_STATUS.SUCCEEDED,
      topupAmountMinor: 2500,
      topupCurrency: "USD",
      confirmedAmountMinor: 2500,
      confirmedCurrency: "USD",
      providerTransactionId: "sandbox_abc",
      topupId: "topup-1",
    })).toMatchObject({ ok: true, already_succeeded: true });

    expect(planCommissionWalletTopupConfirm({
      currentStatus: COMMISSION_TOPUP_STATUS.PROCESSING,
      topupAmountMinor: 2500,
      topupCurrency: "USD",
      confirmedAmountMinor: 999,
      confirmedCurrency: "USD",
      providerTransactionId: "sandbox_abc",
      topupId: "topup-1",
    })).toMatchObject({ ok: false, code: "AMOUNT_MISMATCH" });
  });

  it("19: provider reversal plans TOP_UP_REVERSAL and bonus reverse without deleting credits", () => {
    expect(planCommissionWalletTopupReversal({
      currentStatus: COMMISSION_TOPUP_STATUS.SUCCEEDED,
      topupAmountMinor: 1000,
      creditedLedgerEntryId: "led-1",
      bonusAmountMinor: 50,
      bonusCampaignId: "camp-1",
      topupId: "topup-rev",
    })).toMatchObject({
      ok: true,
      already_reversed: false,
      topup_amount_minor: 1000,
      bonus_amount_minor: 50,
    });
    expect(planCommissionWalletTopupReversal({
      currentStatus: COMMISSION_TOPUP_STATUS.REVERSED,
      topupAmountMinor: 1000,
      creditedLedgerEntryId: "led-1",
      topupId: "topup-rev",
    })).toMatchObject({ ok: true, already_reversed: true });
    expect(planCommissionWalletTopupReversal({
      currentStatus: COMMISSION_TOPUP_STATUS.PENDING,
      topupAmountMinor: 1000,
      creditedLedgerEntryId: "led-1",
      topupId: "topup-rev",
    })).toMatchObject({ ok: false, code: "INVALID_STATUS" });
  });

  it("allows status transitions and builds idempotency keys", () => {
    expect(canTransitionCommissionTopupStatus("PENDING", "PROCESSING")).toBe(true);
    expect(canTransitionCommissionTopupStatus("PROCESSING", "SUCCEEDED")).toBe(true);
    expect(canTransitionCommissionTopupStatus("FAILED", "SUCCEEDED")).toBe(false);
    expect(buildCommissionWalletTopupIdempotencyKey({
      driverId: "d1",
      serviceAreaId: "sa1",
      amountMinor: 500,
      clientKey: "c1",
    })).toContain("cw_topup_d1_sa1_500_c1");
    expect(buildCommissionWalletTopupCreditIdempotencyKey("t1")).toBe("cw_topup_credit_t1");
  });

  it("Phase 5 bonus idempotency is unique per topup+campaign", () => {
    expect(buildCommissionWalletTopupBonusIdempotencyKey("t1", "c1")).toBe("cw_topup_bonus_t1_c1");
    expect(buildCommissionWalletTopupBonusIdempotencyKey("t1", "c1"))
      .not.toBe(buildCommissionWalletTopupBonusIdempotencyKey("t1", "c2"));
  });
});

describe("Phase 5 campaigns", () => {
  it("plans percent and fixed top-up bonuses", () => {
    expect(planCommissionWalletTopupBonus({
      campaign: {
        campaign_type: COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS,
        currency: "USD",
        active: true,
        bonus_percent: 10,
        maximum_bonus_amount_minor: 500,
        minimum_topup_amount_minor: 1000,
      },
      topupAmountMinor: 2000,
      topupCurrency: "USD",
    })).toMatchObject({ ok: true, amount_minor: 200 });

    expect(planCommissionWalletTopupBonus({
      campaign: {
        campaign_type: COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS,
        currency: "USD",
        active: true,
        bonus_percent: 50,
        maximum_bonus_amount_minor: 300,
        minimum_topup_amount_minor: 0,
      },
      topupAmountMinor: 2000,
      topupCurrency: "USD",
    })).toMatchObject({ ok: true, amount_minor: 300 });

    expect(planCommissionWalletTopupBonus({
      campaign: {
        campaign_type: COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS,
        currency: "USD",
        active: true,
        credit_amount_minor: 750,
        minimum_topup_amount_minor: 1000,
      },
      topupAmountMinor: 1500,
      topupCurrency: "USD",
    })).toMatchObject({ ok: true, amount_minor: 750 });

    expect(planCommissionWalletTopupBonus({
      campaign: {
        campaign_type: COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS,
        currency: "USD",
        active: true,
        credit_amount_minor: 750,
        minimum_topup_amount_minor: 2000,
      },
      topupAmountMinor: 1500,
      topupCurrency: "USD",
    })).toMatchObject({ ok: false, code: "BELOW_MINIMUM" });
  });

  it("plans welcome auto-grant and manual promo campaign gate", () => {
    expect(planWelcomeCreditAutoGrant({
      walletEnabled: true,
      driverAssignedToServiceArea: true,
      welcomeCreditEnabled: true,
      welcomeCreditAmountMinor: 1000,
      welcomeCreditMaxDrivers: 10,
      driverAlreadyHasWelcomeCredit: false,
      distinctWelcomeDriversCount: 2,
      driverId: "d1",
      serviceAreaId: "sa1",
    })).toMatchObject({
      ok: true,
      amount_minor: 1000,
      ledger_idempotency_key: "cw_welcome_d1_sa1",
    });

    expect(planWelcomeCreditAutoGrant({
      walletEnabled: true,
      driverAssignedToServiceArea: true,
      welcomeCreditEnabled: true,
      welcomeCreditAmountMinor: 1000,
      welcomeCreditMaxDrivers: 2,
      driverAlreadyHasWelcomeCredit: false,
      distinctWelcomeDriversCount: 2,
      driverId: "d1",
      serviceAreaId: "sa1",
    })).toMatchObject({ ok: false, code: "WELCOME_CREDIT_MAX_DRIVERS_REACHED" });

    expect(planManualPromotionalCampaignCredit({
      walletEnabled: true,
      campaign: null,
      amountMinor: 500,
      currency: "USD",
    })).toMatchObject({ ok: false, code: "CAMPAIGN_REQUIRED" });

    expect(planManualPromotionalCampaignCredit({
      walletEnabled: true,
      campaign: {
        campaign_type: COMMISSION_WALLET_CAMPAIGN_TYPE.MANUAL_PROMOTIONAL_CREDIT,
        currency: "USD",
        active: true,
      },
      amountMinor: 500,
      currency: "USD",
    })).toMatchObject({ ok: true, amount_minor: 500 });
  });

  it("validates campaign type-specific fields and blocks UK workflow for campaigns", () => {
    expect(isCommissionWalletWorkflowEnabled({
      financial_model: SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
      commission_wallet_enabled: true,
    })).toBe(false);

    expect(validateCommissionWalletCampaignFields({
      campaignType: COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS,
      bonusPercent: 0,
    })).toMatchObject({ ok: false, code: "INVALID_BONUS_PERCENT" });

    expect(validateCommissionWalletCampaignFields({
      campaignType: COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS,
      bonusPercent: 10,
      maximumBonusAmountMinor: 500,
    })).toMatchObject({ ok: true });

    expect(validateCommissionWalletCampaignFields({
      campaignType: COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS,
      creditAmountMinor: 0,
    })).toMatchObject({ ok: false, code: "INVALID_AMOUNT" });

    expect(validateCommissionWalletCampaignFields({
      campaignType: COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS,
      creditAmountMinor: 750,
      minimumTopupAmountMinor: 1000,
    })).toMatchObject({ ok: true });

    expect(validateCommissionWalletCampaignFields({
      campaignType: COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS,
      bonusPercent: 10,
      startAt: "2026-06-01T00:00:00.000Z",
      endAt: "2026-05-01T00:00:00.000Z",
    })).toMatchObject({ ok: false, code: "INVALID_WINDOW" });
  });

  it("confirm-path bonus gates: no campaign / once per topup key / no double on replay key", () => {
    expect(planCommissionWalletTopupBonus({
      campaign: null,
      topupAmountMinor: 2000,
      topupCurrency: "USD",
    })).toMatchObject({ ok: false, code: "NO_CAMPAIGN" });

    const key1 = buildCommissionWalletTopupBonusIdempotencyKey("topup-1", "camp-1");
    const keyReplay = buildCommissionWalletTopupBonusIdempotencyKey("topup-1", "camp-1");
    expect(key1).toBe(keyReplay);
    expect(key1).not.toBe(buildCommissionWalletTopupBonusIdempotencyKey("topup-1", "camp-2"));

    const plan = planCommissionWalletTopupBonus({
      campaign: {
        campaign_type: COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS,
        currency: "USD",
        active: true,
        credit_amount_minor: 500,
        minimum_topup_amount_minor: 0,
      },
      topupAmountMinor: 2000,
      topupCurrency: "USD",
    });
    expect(plan).toMatchObject({ ok: true, amount_minor: 500 });
    // Same inputs → same bonus amount (replay-safe planning).
    expect(planCommissionWalletTopupBonus({
      campaign: {
        campaign_type: COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS,
        currency: "USD",
        active: true,
        credit_amount_minor: 500,
        minimum_topup_amount_minor: 0,
      },
      topupAmountMinor: 2000,
      topupCurrency: "USD",
    })).toMatchObject({ ok: true, amount_minor: 500 });
  });
});

describe("commissionWalletSSOT Phase 6 dispatch reserve", () => {
  it("gate off skips eligibility / reserve plans without blocking UK", () => {
    expect(planCommissionWalletDispatchEligibility({
      gateApplies: false,
      estimatedFinalFareMinor: 2000,
      commissionRateBps: 1500,
      usableCommissionBalanceMinor: 0,
    })).toMatchObject({ ok: false, code: "GATE_OFF" });
    expect(planCommissionWalletReserve({
      gateApplies: false,
      estimatedFinalFareMinor: 2000,
      commissionRateBps: 1500,
      usableCommissionBalanceMinor: 9999,
      driverId: "d1",
      tripId: "t1",
    })).toMatchObject({ ok: false, code: "GATE_OFF" });
  });

  it("dispatch eligibility requires usable >= fare × bps", () => {
    expect(planCommissionWalletDispatchEligibility({
      gateApplies: true,
      estimatedFinalFareMinor: 2000,
      commissionRateBps: 1500,
      usableCommissionBalanceMinor: 299,
    })).toMatchObject({
      ok: true,
      eligible: false,
      code: "INSUFFICIENT_COMMISSION_WALLET_BALANCE",
      required_reserve_minor: 300,
    });
    expect(planCommissionWalletDispatchEligibility({
      gateApplies: true,
      estimatedFinalFareMinor: 2000,
      commissionRateBps: 1500,
      usableCommissionBalanceMinor: 300,
    })).toMatchObject({
      ok: true,
      eligible: true,
      required_reserve_minor: 300,
    });
  });

  it("pre-trip reserve/release plans are permanently disabled", () => {
    expect(planCommissionWalletReserve({
      gateApplies: true,
      estimatedFinalFareMinor: 2000,
      commissionRateBps: 1500,
      usableCommissionBalanceMinor: 500,
      driverId: "drv-a",
      tripId: "trip-b",
    })).toMatchObject({ ok: false, code: "GATE_OFF" });
    expect(planCommissionWalletReserve({
      gateApplies: true,
      estimatedFinalFareMinor: 4000,
      commissionRateBps: 1500,
      usableCommissionBalanceMinor: 400,
      driverId: "drv-a",
      tripId: "trip-b",
      alreadyHasActiveReserve: true,
      currentReserveAmountMinor: 300,
    })).toMatchObject({ ok: false, code: "GATE_OFF" });
    expect(planCommissionWalletReserveRelease({
      activeReserveAmountMinor: 300,
      driverId: "drv-a",
      tripId: "trip-b",
    })).toMatchObject({ ok: false, code: "NO_ACTIVE_RESERVE" });
  });

  it("fare source prefers final then estimated; percent→bps", () => {
    expect(commissionPercentToBps(15)).toBe(1500);
    expect(estimatedFinalFareMinorFromTrip({
      estimated_total_pence: 1800,
      final_customer_fare_pence: 2000,
    })).toBe(2000);
    expect(estimatedFinalFareMinorFromTrip({
      estimated_fare: 12.5,
    })).toBe(1250);
  });

  it("historical reserve ledger entries are ignored by live balance SSOT", () => {
    const afterReserve = deriveBalancesFromCommissionLedgerEntries([
      { entry_type: "TOP_UP_CREDIT", amount_minor: 1000, direction: "credit" },
      { entry_type: "COMMISSION_RESERVE", amount_minor: 300, direction: "debit" },
    ]);
    expect(afterReserve.usable_commission_balance_minor).toBe(1000);
    expect(afterReserve.commission_wallet_balance_minor).toBe(1000);
    expect(afterReserve.reserved_balance_minor).toBe(0);
    const afterRelease = deriveBalancesFromCommissionLedgerEntries([
      { entry_type: "TOP_UP_CREDIT", amount_minor: 1000, direction: "credit" },
      { entry_type: "COMMISSION_RESERVE", amount_minor: 300, direction: "debit" },
      { entry_type: "COMMISSION_RESERVE_RELEASE", amount_minor: 300, direction: "credit" },
    ]);
    expect(afterRelease.usable_commission_balance_minor).toBe(1000);
    expect(afterRelease.reserved_balance_minor).toBe(0);
  });
});

describe("commissionWalletSSOT Phase 7 completion deduction + finance", () => {
  it("gate off / already deducted / zero commission skip without error", () => {
    expect(planCommissionWalletDeduction({
      gateApplies: false,
      commissionableFareMinor: 2000,
      commissionRateBps: 1500,
      promotionalBalanceMinor: 500,
      purchasedBalanceMinor: 500,
      usableBalanceMinorAfterReserveRelease: 1000,
      tripId: "t1",
    })).toMatchObject({ ok: true, skipped: true, code: "GATE_OFF" });
    expect(planCommissionWalletDeduction({
      gateApplies: true,
      commissionableFareMinor: 2000,
      commissionRateBps: 1500,
      promotionalBalanceMinor: 500,
      purchasedBalanceMinor: 500,
      usableBalanceMinorAfterReserveRelease: 1000,
      tripId: "t1",
      alreadyDeducted: true,
    })).toMatchObject({ ok: true, skipped: true, code: "ALREADY_DEDUCTED" });
    expect(planCommissionWalletDeduction({
      gateApplies: true,
      commissionableFareMinor: 0,
      commissionRateBps: 1500,
      promotionalBalanceMinor: 500,
      purchasedBalanceMinor: 500,
      usableBalanceMinorAfterReserveRelease: 1000,
      tripId: "t1",
    })).toMatchObject({ ok: true, skipped: true, code: "ZERO_COMMISSION" });
  });

  it("deduction consumes promo first and classifies COMMISSION_WALLET_DEDUCTION", () => {
    const plan = planCommissionWalletDeduction({
      gateApplies: true,
      commissionableFareMinor: 2000,
      commissionRateBps: 1500,
      promotionalBalanceMinor: 100,
      purchasedBalanceMinor: 900,
      usableBalanceMinorAfterReserveRelease: 1000,
      tripId: "trip-deduct-1",
      hasActiveReserve: true,
    });
    expect(plan).toMatchObject({
      ok: true,
      skipped: false,
      commission_earned_minor: 300,
      amount_minor: 300,
      shortfall_minor: 0,
      promotional_portion_minor: 100,
      purchased_portion_minor: 200,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION,
      convert_active_reserve: false,
      revenue_source: REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION,
      ledger_idempotency_key: buildCommissionWalletDeductionIdempotencyKey("trip-deduct-1"),
    });
  });

  it("deducts full confirmed commission even when balance is low (allows negative)", () => {
    expect(planCommissionWalletDeduction({
      gateApplies: true,
      commissionEarnedMinor: 500,
      commissionableFareMinor: 0,
      commissionRateBps: 0,
      promotionalBalanceMinor: 50,
      purchasedBalanceMinor: 50,
      usableBalanceMinorAfterReserveRelease: 100,
      tripId: "trip-short",
    })).toMatchObject({
      ok: true,
      skipped: false,
      amount_minor: 500,
      shortfall_minor: 400,
      promotional_portion_minor: 50,
      purchased_portion_minor: 450,
      convert_active_reserve: false,
    });
  });

  it("tripUsesCommissionWalletDeduction prefers trip snapshot then SA", () => {
    expect(tripUsesCommissionWalletDeduction({
      tripFinancialModel: SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
      tripCommissionWalletEnabled: false,
      serviceAreaConfig: mkAfrica,
    })).toBe(false);
    expect(tripUsesCommissionWalletDeduction({
      serviceAreaConfig: mkAfrica,
    })).toBe(true);
    expect(tripUsesCommissionWalletDeduction({
      tripFinancialModel: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
      tripCommissionWalletEnabled: true,
    })).toBe(true);
  });

  it("excludeTripFromPlatformCollectedFinance uses trip financial_model snapshot", () => {
    expect(excludeTripFromPlatformCollectedFinance({
      financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
    })).toBe(true);
    expect(excludeTripFromPlatformCollectedFinance({
      financial_model: SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED,
    })).toBe(false);
    expect(excludeTripFromPlatformCollectedFinance({})).toBe(false);
  });

  it("finance report never treats customer fare as ONECAB revenue", () => {
    const report = aggregateCommissionWalletFinanceReport(
      [
        {
          entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION,
          amount_minor: 100,
          metadata: { commission_earned_minor: 300, shortfall_minor: 200 },
        },
        { entry_type: COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT, amount_minor: 1000, metadata: { provider_fee_minor: 15 } },
        { entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE, amount_minor: 200 },
        { entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE_RELEASE, amount_minor: 50 },
        { entry_type: COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT, amount_minor: 100 },
        { entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT, amount_minor: 25 },
        { entry_type: COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_REVERSAL, amount_minor: 10 },
      ],
      {
        completedDriverCollectedTrips: 1,
        totalCustomerFaresReportedMinor: 2000,
        walletLiabilitiesMinor: 900,
      },
    );
    expect(report).toMatchObject({
      revenue_source: REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION,
      completed_driver_collected_trips: 1,
      total_customer_fares_reported_minor: 2000,
      onecab_customer_collection_minor: 0,
      total_onecab_commission_earned_minor: 300,
      commission_actually_deducted_minor: 100,
      commission_shortfall_minor: 200,
      onecab_revenue_minor: 100,
      driver_payout_liability_minor: 0,
      outstanding_reserves_minor: 150,
      provider_topups_minor: 1000,
      admin_credits_minor: 25,
      campaign_cost_minor: 100,
      topup_reversals_minor: 10,
      provider_transaction_fees_minor: 15,
      commission_wallet_liabilities_minor: 900,
    });
  });
});

describe("Commission Wallet account roster / SA move", () => {
  it("zero-balance profile is not offer eligible", () => {
    expect(isCommissionWalletOfferEligibleFromBalances({
      usableCommissionBalanceMinor: 0,
      minimumBalanceMinor: 0,
    })).toBe(false);
    expect(isCommissionWalletOfferEligibleFromBalances({
      usableCommissionBalanceMinor: 500,
      minimumBalanceMinor: 100,
    })).toBe(true);
  });

  it("flags missing account as setup error without inventing balances", () => {
    const row = buildCommissionWalletDriverRosterRow({
      driverId: "d1",
      driverCode: "DRV-SO-0001",
      firstName: "Ahmed",
      lastName: "Driver",
      serviceAreaId: "sa-1",
      regionId: "r-1",
      currency: "USD",
      minimumBalanceMinor: 100,
      account: null,
    });
    expect(row.profile_status).toBe("missing");
    expect(row.setup_error).toBe(COMMISSION_WALLET_SETUP_ERROR.MISSING_ACCOUNT);
    expect(row.usable_commission_balance_minor).toBe(0);
    expect(row.offer_eligible).toBe(false);
  });

  it("prohibits silent cross-currency balance transfer on SA move", () => {
    expect(planCommissionWalletServiceAreaMove({
      fromServiceAreaId: "sa-mog",
      toServiceAreaId: "sa-nai",
      fromCurrency: "USD",
      toCurrency: "KES",
    })).toMatchObject({
      preserveOldLedger: true,
      createDestinationAccountIfMissing: true,
      autoTransferBalance: false,
      requiresAuditedMigration: true,
      code: "CROSS_CURRENCY_TRANSFER_PROHIBITED",
    });
  });
});
