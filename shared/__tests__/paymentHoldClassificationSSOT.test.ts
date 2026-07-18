import { describe, expect, it } from "vitest";
import {
  classifyPaymentHoldAttention,
  classifyPaymentHoldOperationalBucket,
  holdIdentityKey,
  mapRevolutProviderHoldState,
  moneyAtRiskInclude,
  paymentHoldActionPolicy,
  shouldEmailHoldReconciliationIncident,
  summariseMoneyAtRisk,
} from "../paymentHoldClassificationSSOT";

describe("mapRevolutProviderHoldState", () => {
  it("maps CANCELLED and REVERTED as terminal resolved (not UNKNOWN)", () => {
    expect(mapRevolutProviderHoldState("CANCELLED")).toBe("CANCELLED");
    expect(mapRevolutProviderHoldState("cancelled")).toBe("CANCELLED");
    expect(mapRevolutProviderHoldState("REVERTED")).toBe("REVERTED");
    expect(mapRevolutProviderHoldState("reverted")).toBe("REVERTED");
    expect(mapRevolutProviderHoldState("AUTHORISED")).toBe("ACTIVE_AUTHORISED");
    expect(mapRevolutProviderHoldState("COMPLETED")).toBe("CAPTURED");
    expect(mapRevolutProviderHoldState("weird")).toBe("UNKNOWN");
  });
});

describe("classifyPaymentHoldAttention", () => {
  it("ORDER_CANCELLED / provider CANCELLED → resolved, no actions, not in queue", () => {
    const result = classifyPaymentHoldAttention({
      sessionStatus: "payment_authorised",
      tripStatus: null,
      paymentHoldStatus: "authorised_hold",
      releasedAt: null,
      capturedAt: null,
      tripId: null,
      ageMinutes: 30,
      releaseFailureReason: null,
      providerOrderState: "CANCELLED",
    });
    expect(result.attention_class).toBe("RESOLVED_PROVIDER_CANCELLED");
    expect(result.in_active_queue).toBe(false);
    expect(result.classification).toBe("GREEN");
    const policy = paymentHoldActionPolicy({
      attentionClass: result.attention_class,
      hasTrip: false,
    });
    expect(policy.can_release).toBe(false);
    expect(policy.can_retry_release).toBe(false);
    expect(policy.can_retry_recovery).toBe(false);
  });

  it("REVERTED maps to resolved, not UNKNOWN", () => {
    const result = classifyPaymentHoldAttention({
      sessionStatus: "payment_authorised",
      tripStatus: null,
      paymentHoldStatus: null,
      releasedAt: null,
      capturedAt: null,
      tripId: null,
      ageMinutes: 10,
      releaseFailureReason: null,
      providerOrderState: "REVERTED",
    });
    expect(result.attention_class).toBe("RESOLVED_PROVIDER_REVERTED");
    expect(result.in_active_queue).toBe(false);
  });

  it("provider CANCELLED + orphan pending → one resolved row, no actions", () => {
    const result = classifyPaymentHoldAttention({
      sessionStatus: "payment_orphaned",
      tripStatus: null,
      paymentHoldStatus: null,
      releasedAt: null,
      capturedAt: null,
      tripId: null,
      ageMinutes: 60,
      releaseFailureReason: null,
      providerOrderState: "CANCELLED",
      orphanReversalStatus: "pending",
    });
    expect(result.attention_class).toBe("RESOLVED_PROVIDER_CANCELLED");
    expect(result.in_active_queue).toBe(false);
    const policy = paymentHoldActionPolicy({
      attentionClass: result.attention_class,
      hasTrip: false,
    });
    expect(policy.can_release).toBe(false);
  });

  it("session released + orphan pending → companion evidence, not RED", () => {
    const result = classifyPaymentHoldAttention({
      sessionStatus: "payment_orphaned",
      tripStatus: null,
      paymentHoldStatus: null,
      releasedAt: null,
      capturedAt: null,
      tripId: null,
      ageMinutes: 60,
      releaseFailureReason: "finalize failed",
      orphanReversalStatus: "pending",
      companionSessionReleased: true,
    });
    expect(result.attention_class).toBe("RESOLVED_COMPANION_SESSION");
    expect(result.classification).toBe("GREEN");
    expect(result.in_active_queue).toBe(false);
  });

  it("provider AUTHORISED + no trip → AMBER while recovering, RED after exhausted", () => {
    const young = classifyPaymentHoldAttention({
      sessionStatus: "payment_authorised",
      tripStatus: null,
      paymentHoldStatus: null,
      releasedAt: null,
      capturedAt: null,
      tripId: null,
      ageMinutes: 1,
      releaseFailureReason: null,
      providerOrderState: "AUTHORISED",
      recoveryAttemptCount: 0,
    });
    expect(young.in_active_queue).toBe(true);
    expect(young.classification).toBe("AMBER");
    expect(young.attention_class).toBe("RECOVERY_PENDING");

    const agedStillRecovering = classifyPaymentHoldAttention({
      sessionStatus: "payment_authorised",
      tripStatus: null,
      paymentHoldStatus: null,
      releasedAt: null,
      capturedAt: null,
      tripId: null,
      ageMinutes: 30,
      releaseFailureReason: null,
      providerOrderState: "AUTHORISED",
      recoveryAttemptCount: 0,
    });
    expect(agedStillRecovering.classification).toBe("AMBER");

    const aged = classifyPaymentHoldAttention({
      sessionStatus: "payment_authorised",
      tripStatus: null,
      paymentHoldStatus: null,
      releasedAt: null,
      capturedAt: null,
      tripId: null,
      ageMinutes: 5,
      releaseFailureReason: null,
      providerOrderState: "AUTHORISED",
      recoveryAttemptCount: 1,
    });
    expect(aged.classification).toBe("RED");
    expect(aged.in_active_queue).toBe(true);
    const policy = paymentHoldActionPolicy({
      attentionClass: aged.attention_class,
      hasTrip: false,
      recoveryAttemptCount: 1,
    });
    expect(policy.can_release).toBe(true);
  });

  it("customer_cancelled terminal trip still holding → AMBER auto-recover, not RED by age", () => {
    const result = classifyPaymentHoldAttention({
      sessionStatus: "payment_authorised",
      tripStatus: "customer_cancelled",
      paymentHoldStatus: "authorised_hold",
      releasedAt: null,
      capturedAt: null,
      tripId: "trip-1",
      ageMinutes: 200,
      releaseFailureReason: null,
      providerOrderState: "AUTHORISED",
    });
    expect(result.classification).toBe("AMBER");
    expect(result.in_active_queue).toBe(true);
  });

  it("released session with hold_terminal_reason PROVIDER_CANCELLED stays resolved", () => {
    const result = classifyPaymentHoldAttention({
      sessionStatus: "cancelled",
      tripStatus: null,
      paymentHoldStatus: "released",
      releasedAt: "2026-07-10T12:00:00Z",
      capturedAt: null,
      tripId: null,
      ageMinutes: 100,
      releaseFailureReason: null,
      holdTerminalReason: "PROVIDER_CANCELLED",
    });
    expect(result.in_active_queue).toBe(false);
    expect(result.attention_class).toBe("RESOLVED_PROVIDER_CANCELLED");
  });
});

describe("money-at-risk SSOT", () => {
  it("excludes provider CANCELLED from money at risk", () => {
    expect(moneyAtRiskInclude({
      attentionClass: "RESOLVED_PROVIDER_CANCELLED",
      providerState: "CANCELLED",
      amountPence: 1499,
    })).toBe(false);
  });

  it("includes only RED unresolved exposure — not auto-recovering holds", () => {
    const summary = summariseMoneyAtRisk([
      {
        attention_class: "ACTIVE_AUTHORISED_HOLD",
        provider_state: "ACTIVE_AUTHORISED",
        amount_pence: 894,
        in_active_queue: true,
        classification: "RED",
      },
      {
        attention_class: "RELEASE_PENDING",
        provider_state: "ACTIVE_AUTHORISED",
        amount_pence: 780,
        in_active_queue: true,
        classification: "AMBER",
      },
      {
        attention_class: "RECOVERY_PENDING",
        provider_state: "ACTIVE_AUTHORISED",
        amount_pence: 780,
        in_active_queue: true,
        classification: "AMBER",
      },
      {
        attention_class: "RESOLVED_PROVIDER_CANCELLED",
        provider_state: "CANCELLED",
        amount_pence: 14098,
        in_active_queue: false,
        classification: "GREEN",
      },
      {
        attention_class: "ACTIVE_AUTHORISED_HOLD",
        provider_state: "ACTIVE_AUTHORISED",
        amount_pence: null,
        in_active_queue: true,
        classification: "RED",
      },
    ]);
    expect(summary.active_hold_count).toBe(1);
    expect(summary.active_hold_amount_pence).toBe(894);
    expect(summary.resolved_count).toBe(1);
  });
});

describe("operational bucket + email policy", () => {
  it("customer cancel auto path is not emailable", () => {
    expect(shouldEmailHoldReconciliationIncident({
      attentionClass: "ACTIVE_AUTHORISED_HOLD",
      classification: "AMBER",
      providerState: "ACTIVE_AUTHORISED",
      recoveryAttemptCount: 0,
    })).toBe(false);
    expect(classifyPaymentHoldOperationalBucket({
      attentionClass: "ACTIVE_AUTHORISED_HOLD",
      classification: "AMBER",
      tripStatus: "customer_cancelled",
    })).toBe("CANCELLED_BY_CUSTOMER");
  });

  it("RELEASE_FAILED with live provider hold is emailable RED", () => {
    expect(shouldEmailHoldReconciliationIncident({
      attentionClass: "RELEASE_FAILED",
      classification: "RED",
      providerState: "ACTIVE_AUTHORISED",
      recoveryAttemptCount: 2,
    })).toBe(true);
    expect(classifyPaymentHoldOperationalBucket({
      attentionClass: "RELEASE_FAILED",
      classification: "RED",
    })).toBe("ACTIVE_ACTION_REQUIRED");
  });
});

describe("dedupe identity", () => {
  it("deduplicates by provider + provider_order_id", () => {
    const a = holdIdentityKey("revolut", "ord_1");
    const b = holdIdentityKey("Revolut", "ord_1");
    const c = holdIdentityKey("revolut", "ord_2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(holdIdentityKey("revolut", "")).toBeNull();
  });
});

describe("stale UI action policy", () => {
  it("rejects release actions for provider CANCELLED/REVERTED", () => {
    for (const cls of ["RESOLVED_PROVIDER_CANCELLED", "RESOLVED_PROVIDER_REVERTED"] as const) {
      const policy = paymentHoldActionPolicy({ attentionClass: cls, hasTrip: false });
      expect(policy.can_release).toBe(false);
      expect(policy.can_retry_release).toBe(false);
      expect(policy.can_retry_recovery).toBe(false);
    }
  });
});

describe("released_amount_pence unknown", () => {
  it("never treats missing amount as £0 for risk — null excluded", () => {
    expect(moneyAtRiskInclude({
      attentionClass: "ACTIVE_AUTHORISED_HOLD",
      amountPence: null,
    })).toBe(false);
    expect(moneyAtRiskInclude({
      attentionClass: "ACTIVE_AUTHORISED_HOLD",
      amountPence: 0,
    })).toBe(false);
  });
});

describe("webhook replay classification idempotency", () => {
  it("repeated CANCELLED classification stays resolved", () => {
    const once = classifyPaymentHoldAttention({
      sessionStatus: "cancelled",
      tripStatus: null,
      paymentHoldStatus: null,
      releasedAt: "2026-07-10T12:00:00Z",
      capturedAt: null,
      tripId: null,
      ageMinutes: 5,
      releaseFailureReason: null,
      holdTerminalReason: "PROVIDER_CANCELLED",
      providerOrderState: "CANCELLED",
    });
    const twice = classifyPaymentHoldAttention({
      sessionStatus: "cancelled",
      tripStatus: null,
      paymentHoldStatus: null,
      releasedAt: "2026-07-10T12:00:00Z",
      capturedAt: null,
      tripId: null,
      ageMinutes: 5,
      releaseFailureReason: null,
      holdTerminalReason: "PROVIDER_CANCELLED",
      providerOrderState: "CANCELLED",
    });
    expect(once).toEqual(twice);
    expect(once.in_active_queue).toBe(false);
  });
});
