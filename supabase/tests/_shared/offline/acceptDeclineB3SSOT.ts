/** Offline test/audit-only helpers; not part of Edge uploads. */


/**
 * Isolated OFF vs ON wall-time model for identical stage workloads (no I/O).
 * Sequential = sum; parallel groups = max within each group then sum groups.
 */
export function measureAcceptDeclineB3Workload(params: {
  enabled: boolean;
  /** eligibility docs/local vs offer lookup (accept-offer). */
  eligibilityMs: number;
  offerLookupMs: number;
  /** hold / marketplace trip SELECT (unchanged either mode). */
  holdOrMarketplaceMs: number;
  /** Independent pre-RPC / pre-accept gates. */
  preRpcParallelMembersMs: number[];
  /** Commitment evaluation CPU after commitments already loaded (B3) or including load (OFF). */
  commitmentEvalMs: number;
  /** Accept / decline RPC (unchanged). */
  rpcMs: number;
}): {
  primaryPathMs: number;
  eligibilityOfferMs: number;
  preRpcBlockMs: number;
  savedMs: number;
} {
  const eligOfferOff = params.eligibilityMs + params.offerLookupMs;
  const eligOfferOn = Math.max(params.eligibilityMs, params.offerLookupMs);
  const members = params.preRpcParallelMembersMs.map((n) => Math.max(0, n));
  const preOff = members.reduce((a, b) => a + b, 0) + Math.max(0, params.commitmentEvalMs);
  const preOn = Math.max(0, ...members, 0) + Math.max(0, params.commitmentEvalMs);
  // When ON, commitment load is inside preRpcParallelMembers; eval is CPU-only.
  // When OFF, commitmentEvalMs includes load — model still compares structure.

  const off =
    eligOfferOff +
    Math.max(0, params.holdOrMarketplaceMs) +
    preOff +
    Math.max(0, params.rpcMs);
  const on =
    eligOfferOn +
    Math.max(0, params.holdOrMarketplaceMs) +
    preOn +
    Math.max(0, params.rpcMs);

  const primary = params.enabled ? on : off;
  return {
    primaryPathMs: primary,
    eligibilityOfferMs: params.enabled ? eligOfferOn : eligOfferOff,
    preRpcBlockMs: params.enabled ? preOn : preOff,
    savedMs: Math.max(0, off - on),
  };
}

export * from "../../../functions/_shared/acceptDeclineB3SSOT.ts";
