import { describe, expect, it } from "vitest";
import {
  assertPayeePayable,
  buildCompanyTransferRequestId,
  companyPayeeAccountFingerprint,
  isHighRiskCompanyTransferCategory,
  maskUkAccount,
  toCompanyPayeePublicDto,
  assertNoStripeCompanyTransferFields,
} from "../../../shared/companyPayeeSSOT";
import {
  computeCompanyPayeeNextRun,
  evaluateAutomaticCompanyPaymentGates,
  buildSchedulePeriodKey,
  buildAutomaticPeriodPayableDraft,
  assertTransferStatusTransition,
} from "../../../shared/companyPayeeScheduleSSOT";
import {
  encryptCompanyPayeeSecret,
  decryptCompanyPayeeSecret,
} from "../../../shared/companyPayeeEncryptionSSOT";
import { canApproveCompanyTransfer } from "../../../shared/companyOutgoingTransferApprovalSSOT";
import { assertCompanyTransferFundingAvailable } from "../../../shared/companyBalanceSSOT";

describe("company payee SSOT", () => {
  it("masks account as •••• 1234", () => {
    expect(maskUkAccount({ account_number: "12345678" })).toBe("•••• 5678");
    expect(maskUkAccount({ iban: "GB82WEST12345698765432" })).toBe("•••• 5432");
  });

  it("fingerprint is stable and duplicate-safe", async () => {
    const a = await companyPayeeAccountFingerprint({
      currency: "GBP",
      sort_code: "20-00-00",
      account_number: "12345678",
    });
    const b = await companyPayeeAccountFingerprint({
      currency: "GBP",
      sort_code: "200000",
      account_number: "12345678",
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("public DTO never includes encrypted bank fields", () => {
    const dto = toCompanyPayeePublicDto({
      id: "11111111-1111-1111-1111-111111111111",
      legal_name: "Acme Ltd",
      display_name: "Acme",
      payee_type: "SUPPLIER",
      masked_account: "•••• 5678",
      account_verification_status: "VERIFIED",
      sort_code_encrypted: "SECRET",
      account_number_encrypted: "SECRET",
      iban_encrypted: "SECRET",
      account_fingerprint: "abc",
      active: true,
      paused: false,
      currency: "GBP",
      country: "GB",
      created_at: "2026-07-12T00:00:00Z",
      updated_at: "2026-07-12T00:00:00Z",
    });
    expect(dto.masked_account).toBe("•••• 5678");
    expect((dto as Record<string, unknown>).sort_code_encrypted).toBeUndefined();
    expect((dto as Record<string, unknown>).account_fingerprint).toBeUndefined();
  });

  it("unverified payee cannot be paid", () => {
    expect(assertPayeePayable({
      active: true,
      paused: false,
      account_verification_status: "PENDING",
      revolut_counterparty_id: "cp_1",
    })).toEqual({ ok: false, status: "PAYEE_UNVERIFIED" });
  });

  it("verified payee with counterparty is payable", () => {
    expect(assertPayeePayable({
      active: true,
      paused: false,
      account_verification_status: "VERIFIED",
      revolut_counterparty_id: "cp_1",
    })).toEqual({ ok: true });
  });

  it("request_id is idempotent per transfer attempt", () => {
    expect(buildCompanyTransferRequestId({
      company_transfer_id: "t1",
      execution_attempt: 2,
    })).toBe("ct:t1:v2");
  });

  it("rejects stripe fields", () => {
    expect(() => assertNoStripeCompanyTransferFields({ stripe_account_id: "x" }))
      .toThrow("STRIPE_FORBIDDEN_ON_COMPANY_TRANSFER");
  });
});

describe("company payee encryption", () => {
  it("round-trips secrets and never equals plaintext", async () => {
    const cipher = await encryptCompanyPayeeSecret("20000012345678");
    expect(cipher).not.toContain("200000");
    expect(await decryptCompanyPayeeSecret(cipher)).toBe("20000012345678");
  });
});

describe("company payee schedule SSOT", () => {
  it("respects Tuesday 12:00 Europe/London", () => {
    const run = computeCompanyPayeeNextRun({
      frequency: "WEEKLY",
      weekly_day: "tuesday",
      local_processing_time: "12:00",
      timezone: "Europe/London",
      automatic_enabled: true,
      paused: false,
      now: new Date("2026-07-12T15:00:00.000Z"),
    });
    expect(run.status).toBe("ACTIVE");
    expect(run.next_run_at).toBe("2026-07-14T11:00:00.000Z");
    expect(run.next_run_at_local?.toLowerCase()).toContain("tuesday");
    expect(run.next_run_at_local).toContain("12:00");
  });

  it("paused schedule creates no next run", () => {
    const run = computeCompanyPayeeNextRun({
      frequency: "WEEKLY",
      weekly_day: "tuesday",
      automatic_enabled: true,
      paused: true,
    });
    expect(run.status).toBe("PAUSED");
    expect(run.next_run_at).toBeNull();
  });

  it("period key prevents duplicate execution identity", () => {
    const key = buildSchedulePeriodKey({
      frequency: "WEEKLY",
      next_run_at_utc: "2026-07-14T11:00:00.000Z",
      timezone: "Europe/London",
    });
    expect(key).toBe("D:2026-07-14");
  });

  it("staff salary schedule creates one payable draft per period", () => {
    const draft = buildAutomaticPeriodPayableDraft({
      schedule_id: "s1",
      schedule_period_key: "D:2026-07-14",
      payee_id: "p1",
      amount_pence: 100_00,
      category: "STAFF_SALARY",
    });
    expect(draft.status).toBe("DRAFT");
    expect(draft.execution_mode).toBe("DRAFT_FOR_APPROVAL");
    expect(draft.idempotency_key).toBe("sched:s1:D:2026-07-14");
    const again = buildAutomaticPeriodPayableDraft({
      schedule_id: "s1",
      schedule_period_key: "D:2026-07-14",
      payee_id: "p1",
      amount_pence: 100_00,
      category: "STAFF_SALARY",
    });
    expect(again.idempotency_key).toBe(draft.idempotency_key);
  });

  it("failed transfer cannot become completed; revert requires completed", () => {
    expect(assertTransferStatusTransition({ from: "FAILED", to: "COMPLETED" }))
      .toEqual({ ok: false, reason: "FAILED_CANNOT_BECOME_COMPLETED" });
    expect(assertTransferStatusTransition({ from: "PAID", to: "REVERTED" }).ok).toBe(true);
    expect(assertTransferStatusTransition({ from: "DRAFT", to: "REVERTED" }).ok).toBe(false);
  });

  it("gates block insufficient funds and unverified payee", () => {
    expect(evaluateAutomaticCompanyPaymentGates({
      payee_active: true,
      payee_paused: false,
      payee_verification_status: "VERIFIED",
      revolut_counterparty_id: "cp",
      schedule_paused: false,
      schedule_automatic_enabled: true,
      amount_pence: 10_000,
      company_available_for_transfer_pence: 500,
      duplicate_period_exists: false,
      currency_match: true,
    }).status).toBe("FUNDING_UNAVAILABLE");

    expect(evaluateAutomaticCompanyPaymentGates({
      payee_active: true,
      payee_paused: false,
      payee_verification_status: "UNVERIFIED",
      revolut_counterparty_id: "cp",
      schedule_paused: false,
      schedule_automatic_enabled: true,
      amount_pence: 100,
      company_available_for_transfer_pence: 10_000,
      duplicate_period_exists: false,
      currency_match: true,
    }).status).toBe("PAYEE_UNVERIFIED");
  });

  it("duplicate schedule period is blocked", () => {
    expect(evaluateAutomaticCompanyPaymentGates({
      payee_active: true,
      payee_paused: false,
      payee_verification_status: "VERIFIED",
      revolut_counterparty_id: "cp",
      schedule_paused: false,
      schedule_automatic_enabled: true,
      amount_pence: 100,
      company_available_for_transfer_pence: 10_000,
      duplicate_period_exists: true,
      currency_match: true,
    })).toEqual({ ok: false, status: "DUPLICATE_SCHEDULE_PERIOD" });
  });
});

describe("approval + funding", () => {
  it("requester cannot approve own transfer", () => {
    expect(canApproveCompanyTransfer({
      requester_id: "u1",
      approver_id: "u1",
      category: "DIRECTOR_DIVIDEND",
    })).toEqual({ ok: false, reason: "REQUESTER_CANNOT_SELF_APPROVE" });
  });

  it("high-risk categories are flagged", () => {
    expect(isHighRiskCompanyTransferCategory("DIRECTOR_LOAN")).toBe(true);
    expect(isHighRiskCompanyTransferCategory("STAFF_SALARY")).toBe(false);
  });

  it("driver wallet cannot fund company payments", () => {
    expect(() =>
      assertCompanyTransferFundingAvailable({
        money_source: "DRIVER_WALLET",
        company_balance: {
          status: "AVAILABLE",
          company_available_for_transfer_pence: 100_000,
        } as never,
        amount_pence: 100,
      }),
    ).toThrow();
  });
});
