/** Offline test/audit-only helpers; not part of Edge uploads. */


export function customerSubmittedBeforeDeadline(input: {
  submittedAtMs: number;
  deadlineMs: number | null;
}): boolean {
  if (input.deadlineMs == null || !Number.isFinite(input.deadlineMs)) return true;
  return input.submittedAtMs <= input.deadlineMs;
}

export * from "../../../functions/_shared/customerNegotiationDecisionHold.ts";
