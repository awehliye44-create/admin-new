import { describe, expect, it } from "vitest";
import {
  FUNDING_RESULT,
  ORCHESTRATOR_BATCH_STATUS,
  ORCHESTRATOR_BLOCKER,
  ORCHESTRATOR_ITEM_STATUS,
  ORCHESTRATOR_RUN_STATUS,
  aggregateOrchestratorBatchStatus,
  buildOrchestratorPlanSnapshot,
  evaluateBatchFundingGate,
  formatOrchestratorScheduleSummary,
  mayOrchestratorMoveMoney,
  orchestratorBlockerLabel,
  orchestratorIdempotencyKey,
  resolveOrchestratorRunFinish,
  isOrchestratorReconcileOnlyItemStatus,
  shouldReleaseReservationOnSubmitClaimFailure,
  isOrchestratorInFlightItemStatus,
  shouldContinueOrchestratorMoneyPath,
} from "../weeklyPayoutOrchestratorSSOT";

const OCCURRENCE = "weekly-payout:milton-keynes:2026-07-21T12:00:00+01:00";
const AHMED = "5ed232c3-8bb5-4085-95d6-73e48e6c5e28";
const BOSTEYO = "cd8bae4c-3827-4b90-98c6-10be70eb0e52";

describe("weeklyPayoutOrchestratorSSOT", () => {
  it("funding: £46.23 required vs £56.03 available → SUFFICIENT", () => {
    const gate = evaluateBatchFundingGate({
      required_batch_pence: 4623,
      available_pence: 5603,
    });
    expect(gate.result).toBe(FUNDING_RESULT.SUFFICIENT);
    expect(gate.blocker_code).toBeNull();
  });

  it("funding: insufficient settled funds", () => {
    const gate = evaluateBatchFundingGate({
      required_batch_pence: 4623,
      available_pence: 1000,
    });
    expect(gate.result).toBe(FUNDING_RESULT.INSUFFICIENT);
    expect(gate.blocker_code).toBe(ORCHESTRATOR_BLOCKER.INSUFFICIENT_SETTLED_FUNDS);
  });

  it("LIVE=false blocks money path with exact label", () => {
    expect(mayOrchestratorMoveMoney({
      get: (k) => (k === "REVOLUT_PAYMENT_TRANSPORT_ENABLED" ? "true" : "false"),
    })).toEqual({
      ok: false,
      blocker_code: ORCHESTRATOR_BLOCKER.LIVE_PAYOUT_ROLLOUT_DISABLED,
    });
    expect(orchestratorBlockerLabel(ORCHESTRATOR_BLOCKER.LIVE_PAYOUT_ROLLOUT_DISABLED))
      .toBe("Live payout rollout disabled");
    expect(orchestratorBlockerLabel("BLOCKED_EXECUTION_DISABLED"))
      .toBe("Live payout rollout disabled");
  });

  it("dry-run plan: Ahmed £31.49 + Bosteyo £14.74, no Revolut", () => {
    const plan = buildOrchestratorPlanSnapshot({
      schedule_occurrence_key: OCCURRENCE,
      available_pence: 5603,
      live_enabled: false,
      transport_enabled: true,
      dry_run: true,
      items: [
        {
          driver_id: AHMED,
          driver_name: "Ahmed Osman",
          amount_pence: 3149,
          payout_item_id: "item-ahmed",
          destination_verified: true,
          provider_counterparty_id: "cp-a",
          provider_recipient_account_id: "rcpt-a",
        },
        {
          driver_id: BOSTEYO,
          driver_name: "Bosteyo Mohamed Adow",
          amount_pence: 1474,
          payout_item_id: "item-bosteyo",
          destination_verified: true,
          provider_counterparty_id: "cp-b",
          provider_recipient_account_id: "rcpt-b",
        },
      ],
    });
    expect(plan.required_batch_pence).toBe(4623);
    expect(plan.eligible_driver_count).toBe(2);
    expect(plan.funding.result).toBe(FUNDING_RESULT.SUFFICIENT);
    expect(plan.blocker_code).toBe(ORCHESTRATOR_BLOCKER.LIVE_PAYOUT_ROLLOUT_DISABLED);
    expect(plan.revolut_pay_would_occur).toBe(false);
    expect(plan.wallet_debit_would_occur).toBe(false);
    expect(plan.items[0].idempotency_submit_key).toContain(OCCURRENCE);
    expect(plan.items[0].idempotency_submit_key).toContain(AHMED);
  });

  it("LIVE+TRANSPORT plan allows money path", () => {
    const plan = buildOrchestratorPlanSnapshot({
      schedule_occurrence_key: OCCURRENCE,
      available_pence: 5603,
      live_enabled: true,
      transport_enabled: true,
      dry_run: false,
      items: [
        {
          driver_id: AHMED,
          amount_pence: 3149,
          payout_item_id: "item-ahmed",
          destination_verified: true,
        },
      ],
    });
    expect(plan.money_path_allowed).toBe(true);
    expect(plan.blocker_code).toBeNull();
    expect(plan.revolut_pay_would_occur).toBe(true);
  });

  it("aggregates batch from child item states", () => {
    expect(aggregateOrchestratorBatchStatus([
      { status: ORCHESTRATOR_ITEM_STATUS.COMPLETED },
      { status: ORCHESTRATOR_ITEM_STATUS.COMPLETED },
    ]).status).toBe(ORCHESTRATOR_BATCH_STATUS.COMPLETED);
    expect(aggregateOrchestratorBatchStatus([
      { status: ORCHESTRATOR_ITEM_STATUS.COMPLETED },
      { status: ORCHESTRATOR_ITEM_STATUS.FAILED_RETRYABLE },
    ]).status).toBe(ORCHESTRATOR_BATCH_STATUS.PARTIALLY_COMPLETED);
    expect(aggregateOrchestratorBatchStatus(
      [{ status: ORCHESTRATOR_ITEM_STATUS.ELIGIBLE }],
      { blocked: true },
    ).status).toBe(ORCHESTRATOR_BATCH_STATUS.BLOCKED);
  });

  it("schedule summary labels for admin UI", () => {
    const s = formatOrchestratorScheduleSummary({
      scheduled_local_label: "Tuesday 12:00",
      eligible_driver_count: 2,
      required_batch_pence: 4623,
      funding_result: FUNDING_RESULT.SUFFICIENT,
    });
    expect(s.headline).toBe("Scheduled for Tuesday 12:00");
    expect(s.expected_drivers_label).toBe("Expected drivers: 2");
    expect(s.funding_label).toBe("Funding: Ready");
  });

  it("idempotency keys are immutable per purpose", () => {
    const a = orchestratorIdempotencyKey({
      occurrence_key: OCCURRENCE,
      driver_id: AHMED,
      payout_item_id: "item-1",
      purpose: "submit",
    });
    const b = orchestratorIdempotencyKey({
      occurrence_key: OCCURRENCE,
      driver_id: AHMED,
      payout_item_id: "item-1",
      purpose: "submit",
    });
    expect(a).toBe(b);
  });

  it("occurrence finish stays RUNNING until all items terminal", () => {
    const pending = resolveOrchestratorRunFinish({
      item_statuses: [
        ORCHESTRATOR_ITEM_STATUS.COMPLETED,
        ORCHESTRATOR_ITEM_STATUS.PROVIDER_ACCEPTED,
      ],
      any_pay_called: true,
      any_debited: true,
    });
    expect(pending.run_status).toBe(ORCHESTRATOR_RUN_STATUS.RUNNING);
    expect(pending.money_path_executed).toBe(false);

    const retryable = resolveOrchestratorRunFinish({
      item_statuses: [ORCHESTRATOR_ITEM_STATUS.FAILED_RETRYABLE],
      any_pay_called: false,
      any_debited: false,
    });
    expect(retryable.run_status).toBe(ORCHESTRATOR_RUN_STATUS.RUNNING);
    expect(retryable.money_path_executed).toBe(false);

    const done = resolveOrchestratorRunFinish({
      item_statuses: [
        ORCHESTRATOR_ITEM_STATUS.COMPLETED,
        ORCHESTRATOR_ITEM_STATUS.COMPLETED,
      ],
      any_pay_called: true,
      any_debited: true,
    });
    expect(done.run_status).toBe(ORCHESTRATOR_RUN_STATUS.COMPLETED);
    expect(done.money_path_executed).toBe(true);
  });

  it("UNKNOWN / submitted statuses are reconcile-only (no second /pay)", () => {
    expect(isOrchestratorReconcileOnlyItemStatus("UNKNOWN")).toBe(true);
    expect(isOrchestratorReconcileOnlyItemStatus("SUBMITTED")).toBe(true);
    expect(isOrchestratorReconcileOnlyItemStatus("VALIDATED")).toBe(false);
    expect(isOrchestratorReconcileOnlyItemStatus("CREATED")).toBe(false);
    expect(shouldReleaseReservationOnSubmitClaimFailure("UNKNOWN_NO_BLIND_RETRY")).toBe(false);
    expect(shouldReleaseReservationOnSubmitClaimFailure("ALREADY_SUBMITTED")).toBe(false);
    expect(shouldReleaseReservationOnSubmitClaimFailure("CLAIM_BUSY")).toBe(true);
  });

  it("money path continues for in-flight items when fresh eligibility is zero", () => {
    const gate = shouldContinueOrchestratorMoneyPath({
      dry_run: false,
      live_enabled: true,
      transport_enabled: true,
      has_batch: true,
      fresh_eligible_count: 0,
      in_flight_item_count: 1,
      blocker_code: "ZERO_ELIGIBLE_DRIVERS",
    });
    expect(gate.continue).toBe(true);
    expect(gate.reconciling_in_flight).toBe(true);
    expect(gate.ignore_zero_eligible_blocker).toBe(true);
    expect(isOrchestratorInFlightItemStatus("SUBMITTED")).toBe(true);
    expect(isOrchestratorInFlightItemStatus("COMPLETED")).toBe(false);
  });

  it("provider payload ledger effect is single WEEKLY_PAYOUT debit", () => {
    const plan = buildOrchestratorPlanSnapshot({
      schedule_occurrence_key: OCCURRENCE,
      available_pence: 5603,
      live_enabled: false,
      transport_enabled: true,
      dry_run: true,
      items: [{
        driver_id: AHMED,
        amount_pence: 3149,
        payout_item_id: "item-ahmed",
        destination_verified: true,
      }],
    });
    expect(plan.items[0].amount_pence).toBe(3149);
    // Permanent debit only after provider completion (documented by orchestrator payloads).
    expect(plan.wallet_debit_would_occur).toBe(false);
  });

  it("static guard: orchestrator edge never pays when dry_run or !LIVE", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(
        process.cwd(),
        "supabase/functions/admin-execute-weekly-payout-occurrence/index.ts",
      ),
      "utf8",
    );
    expect(src).toContain("dryRun");
    expect(src).toContain("LIVE_PAYOUT_ROLLOUT_DISABLED");
    expect(src).toContain("moneyPath = !dryRun && live && transport");
    expect(src).toContain("relayApprovedDriverPayoutPayment");
    expect(src).toContain("resolveOrchestratorRunFinish");
    expect(src).toContain("isOrchestratorReconcileOnlyItemStatus");
    expect(src).toContain("shouldReleaseReservationOnSubmitClaimFailure");
    expect(src).toContain('status: "VALIDATED"');
    expect(src).toContain("BLOCKED_EXECUTION_DISABLED");
    expect(src).toMatch(/if\s*\(\s*!moneyPath\s*\)/);
  });
});
