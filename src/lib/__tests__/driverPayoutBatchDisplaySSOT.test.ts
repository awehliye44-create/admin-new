import { describe, expect, it } from "vitest";
import {
  COMPANY_TRANSFERS_EMPTY_COPY,
  CARRIED_FORWARD_SUPPORTING_TEXT,
  aggregateDriverPayoutBatchStatus,
  buildLiveWalletCompositionDisplay,
  resolveDriverPayoutItemDisplayPresentation,
  resolveDriverPayoutItemDisplayStatus,
} from "../../../shared/driverPayoutBatchDisplaySSOT";
import { SLICE8_FUNDING_PROOF } from "../../../shared/payoutLedgerCompanyFundingSSOT";

const { AHMED_LIVE_PENCE, BOSTEYO_COMPLETED_PENCE } = SLICE8_FUNDING_PROOF;

describe("driver payout batch display SSOT", () => {
  it("item-level: Bosteyo COMPLETED, Ahmed ACTIVE reserved → NOT_SUBMITTED", () => {
    expect(resolveDriverPayoutItemDisplayStatus({
      status: "COMPLETED",
      execution_status: "COMPLETED",
      completed_at: "2026-07-15T16:26:44.229818Z",
    })).toBe("COMPLETED");
    expect(resolveDriverPayoutItemDisplayStatus({
      status: "RESERVED",
      execution_status: "BLOCKED_EXECUTION_DISABLED",
      completed_at: null,
      reservation_status: "ACTIVE",
    })).toBe("NOT_SUBMITTED");
  });

  it("Ahmed released INELIGIBLE → CARRIED_FORWARD", () => {
    const presentation = resolveDriverPayoutItemDisplayPresentation({
      status: "INELIGIBLE",
      execution_status: "INELIGIBLE",
      reservation_status: "RELEASED",
      release_reason: "BELOW_WEEKLY_MINIMUM_THRESHOLD",
    });
    expect(presentation.display_status).toBe("CARRIED_FORWARD");
    expect(presentation.supporting_text).toBe(CARRIED_FORWARD_SUPPORTING_TEXT);
    expect(presentation.reason_label).toBe("Below weekly minimum threshold");
  });

  it("composition: 1001 + 2148 = 3149", () => {
    expect(buildLiveWalletCompositionDisplay({
      live_balance_pence: 3149,
      carried_forward_pence: 1001,
    })).toEqual({
      live_balance_pence: 3149,
      carried_forward_pence: 1001,
      new_earnings_pence: 2148,
    });
  });

  it("batch aggregate: completed child + reserved child → PARTIALLY_COMPLETED", () => {
    const agg = aggregateDriverPayoutBatchStatus(
      [
        { status: "COMPLETED", execution_status: "COMPLETED" },
        { status: "RESERVED", execution_status: "BLOCKED_EXECUTION_DISABLED" },
      ],
      "PROVIDER_SUBMISSION_PARTIAL",
    );
    expect(agg.status).toBe("PARTIALLY_COMPLETED");
    expect(agg.status_label).toBe("Partially completed");
    expect(agg.successful_payouts).toBe(1);
    expect(agg.unfinished_payouts).toBe(1);
    expect(agg.status).not.toBe("COMPLETED");
    expect(agg.status).not.toBe("PROVIDER_SUBMISSION_PARTIAL");
  });

  it("proof amounts: 408 completed + 1001 not submitted", () => {
    expect(BOSTEYO_COMPLETED_PENCE).toBe(408);
    expect(AHMED_LIVE_PENCE).toBe(1001);
  });

  it("company transfers empty copy isolates driver payouts", () => {
    expect(COMPANY_TRANSFERS_EMPTY_COPY).toBe(
      "No company transfers yet. Driver payouts are shown under Driver Payouts and Batch History.",
    );
  });
});
