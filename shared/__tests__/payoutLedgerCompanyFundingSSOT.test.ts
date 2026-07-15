import { describe, expect, it } from "vitest";
import {
  computeCompanyAvailableBeforeOperationalReservePence,
  computeCompanyAvailableForTransferPence,
} from "../companyBalanceSSOT";
import {
  SLICE8_FUNDING_PROOF,
  buildCompanyFundingAuditRows,
  computeOtherCompanyOwnedCashPence,
  sumActiveReservedDriverPayoutsPence,
  sumCompletedDriverPayoutsThisMonthPence,
  sumProtectedDriverLiabilitiesPence,
} from "../payoutLedgerCompanyFundingSSOT";

const {
  AHMED_ID,
  BOSTEYO_ID,
  AHMED_LIVE_PENCE,
  AHMED_RESERVED_PENCE,
  BOSTEYO_COMPLETED_PENCE,
  REVOLUT_SOURCE_PENCE,
  EXPECTED_LIABILITY_PENCE,
  EXPECTED_RESERVED_PENCE,
  EXPECTED_COMPLETED_MONTH_PENCE,
  EXPECTED_AVAILABLE_PENCE,
  EXPECTED_NET_COMMISSION_PENCE,
  EXPECTED_OTHER_COMPANY_CASH_PENCE,
} = SLICE8_FUNDING_PROOF;

describe("post-Slice-8 payout ledger company funding SSOT", () => {
  it("cross-driver: Bosteyo COMPLETED must not zero Ahmed reserved/liability", () => {
    const liability = sumProtectedDriverLiabilitiesPence([
      { driver_id: AHMED_ID, live_pence: AHMED_LIVE_PENCE },
      { driver_id: BOSTEYO_ID, live_pence: 0 },
    ]);
    const reserved = sumActiveReservedDriverPayoutsPence([
      {
        driver_id: AHMED_ID,
        amount_pence: AHMED_RESERVED_PENCE,
        status: "ACTIVE",
      },
      {
        driver_id: BOSTEYO_ID,
        amount_pence: BOSTEYO_COMPLETED_PENCE,
        status: "CONSUMED",
      },
    ]);
    expect(liability).toBe(EXPECTED_LIABILITY_PENCE);
    expect(reserved).toBe(EXPECTED_RESERVED_PENCE);
    expect(reserved).not.toBe(0);
    expect(liability).not.toBe(0);
  });

  it("completed-payout omission: COMPLETED Bosteyo must appear in completed_this_month", () => {
    const monthStart = "2026-06-30T23:00:00.000Z"; // Europe/London July 2026
    const pence = sumCompletedDriverPayoutsThisMonthPence({
      month_start_iso: monthStart,
      executions: [
        {
          driver_id: BOSTEYO_ID,
          amount_pence: BOSTEYO_COMPLETED_PENCE,
          provider_state: "completed",
          financially_applied: true,
          financially_applied_at: "2026-07-15T16:26:44.229818Z",
          provider_completed_at: "2026-07-14T22:11:57.265514Z",
          item_status: "COMPLETED",
          execution_status: "COMPLETED",
        },
        {
          driver_id: AHMED_ID,
          amount_pence: AHMED_RESERVED_PENCE,
          provider_state: null,
          item_status: "RESERVED",
          execution_status: "BLOCKED_EXECUTION_DISABLED",
          financially_applied: false,
        },
        {
          driver_id: "failed-driver",
          amount_pence: 999,
          provider_state: "failed",
          financially_applied: false,
          completed_at: "2026-07-15T12:00:00.000Z",
        },
        {
          driver_id: "reverted-driver",
          amount_pence: 500,
          provider_state: "reverted",
          completed_at: "2026-07-15T12:00:00.000Z",
        },
      ],
    });
    expect(pence).toBe(EXPECTED_COMPLETED_MONTH_PENCE);
  });

  it("completed counts once (item + intent same execution, even if provider clock differs)", () => {
    const monthStart = "2026-06-30T23:00:00.000Z";
    const appliedAt = "2026-07-15T16:26:44.229818Z";
    const providerAt = "2026-07-14T22:11:57.265514Z";
    const pence = sumCompletedDriverPayoutsThisMonthPence({
      month_start_iso: monthStart,
      executions: [
        {
          driver_id: BOSTEYO_ID,
          amount_pence: BOSTEYO_COMPLETED_PENCE,
          provider_state: "completed",
          financially_applied: true,
          financially_applied_at: appliedAt,
          provider_completed_at: providerAt,
        },
        {
          driver_id: BOSTEYO_ID,
          amount_pence: BOSTEYO_COMPLETED_PENCE,
          item_status: "COMPLETED",
          completed_at: appliedAt,
        },
      ],
    });
    expect(pence).toBe(BOSTEYO_COMPLETED_PENCE);
  });

  it("ONECAB available subtracts liabilities once — not reserved again", () => {
    // Provisional (before reserve): source £15.26 − liability £10.01 = £5.25
    expect(
      computeCompanyAvailableBeforeOperationalReservePence({
        provider_available_balance_pence: REVOLUT_SOURCE_PENCE,
        driver_liability_pence: EXPECTED_LIABILITY_PENCE,
        approved_company_payables_pence: 0,
        customer_refund_reserved_pence: null,
      }),
    ).toBe(EXPECTED_AVAILABLE_PENCE);

    // Fail-closed: NOT_CONFIGURED reserve → final available UNAVAILABLE (null).
    expect(
      computeCompanyAvailableForTransferPence({
        provider_available_balance_pence: REVOLUT_SOURCE_PENCE,
        driver_liability_pence: EXPECTED_LIABILITY_PENCE,
        driver_payout_reserved_pence: EXPECTED_RESERVED_PENCE,
        approved_company_payables_pence: 0,
        operational_reserve_pence: null,
        customer_refund_reserved_pence: null,
      }),
    ).toBeNull();

    // Configured reserve £0 is an explicit policy — final available = £5.25.
    expect(
      computeCompanyAvailableForTransferPence({
        provider_available_balance_pence: REVOLUT_SOURCE_PENCE,
        driver_liability_pence: EXPECTED_LIABILITY_PENCE,
        driver_payout_reserved_pence: EXPECTED_RESERVED_PENCE,
        approved_company_payables_pence: 0,
        operational_reserve_pence: 0,
      }),
    ).toBe(EXPECTED_AVAILABLE_PENCE);
  });

  it("derives unclassified company cash as before_reserve − net commission (353)", () => {
    const audit = buildCompanyFundingAuditRows({
      company_available_before_operational_reserve_pence: EXPECTED_AVAILABLE_PENCE,
      onecab_net_commission_available_pence: EXPECTED_NET_COMMISSION_PENCE,
    });
    expect(audit.find((r) => r.kind === "NET_COMMISSION")?.amount_pence)
      .toBe(EXPECTED_NET_COMMISSION_PENCE);
    const unclassified = audit.find((r) => r.kind === "UNATTRIBUTED_CASH");
    expect(unclassified?.amount_pence).toBe(EXPECTED_OTHER_COMPANY_CASH_PENCE);
    expect(unclassified?.label).toBe("Unclassified Company Cash");
    expect(unclassified?.status).toBe("RECONCILIATION_REQUIRED");
    expect(computeOtherCompanyOwnedCashPence({
      company_available_before_operational_reserve_pence: EXPECTED_AVAILABLE_PENCE,
      classified_sources: audit.filter((r) => r.kind !== "UNATTRIBUTED_CASH"),
      onecab_net_commission_available_pence: EXPECTED_NET_COMMISSION_PENCE,
    })).toBe(EXPECTED_OTHER_COMPANY_CASH_PENCE);
    // £5.25 must appear only once as before-reserve — not duplicated as unclassified.
    expect(unclassified?.amount_pence).not.toBe(EXPECTED_AVAILABLE_PENCE);
  });

  it("fail-closed: no unclassified residue when Payment Sessions net commission missing", () => {
    const audit = buildCompanyFundingAuditRows({
      company_available_before_operational_reserve_pence: EXPECTED_AVAILABLE_PENCE,
      onecab_net_commission_available_pence: null,
    });
    expect(audit.find((r) => r.kind === "NET_COMMISSION")).toBeUndefined();
    expect(audit.find((r) => r.kind === "UNATTRIBUTED_CASH")).toBeUndefined();
    expect(computeOtherCompanyOwnedCashPence({
      company_available_before_operational_reserve_pence: EXPECTED_AVAILABLE_PENCE,
      classified_sources: [],
      onecab_net_commission_available_pence: null,
    })).toBeNull();
  });
});
