/**
 * Step 9.4C — Revolut Business OAuth continuity audit SSOT (read-only / mocks).
 * Does not refresh, deploy, or call providers.
 */

export const BUSINESS_OAUTH_CONTINUITY_VERSION = "business_oauth_continuity_ssot_v1";

/** Shared helper — now the sole logical refresh owner via ON_DEMAND_DB_CLAIM_CAS. */
export const SHARED_REFRESH_HELPER = "ensureFreshRevolutBusinessAccessToken" as const;

export const DURABLE_REFRESH_MODEL = "ON_DEMAND_DB_CLAIM_CAS" as const;

export const REFRESH_SKEW_MS = 60_000;

/**
 * Production Edge functions / modules that bundle the canonical refresh helper.
 * Linkage remains GO_LIVE_CRITICAL_BOOT_DEFECT (deferred to 9.4E) — listed but not redeployed here.
 */
export const BUSINESS_TOKEN_REFRESH_WRITERS = [
  "admin-submit-driver-payout-payment",
  "admin-finalize-driver-payout-completion",
  "admin-execute-weekly-payout-occurrence",
  "driver-withdraw",
  "admin-company-payees",
  "admin-submit-company-transfer-payment",
  "admin-finalize-company-transfer-completion",
  "admin-sync-company-transfer-provider-status",
  "admin-sync-driver-payout-provider-linkage", // DEFERRED — boot defect
  "reconcile-submitted-driver-withdrawals", // via driverWithdrawProviderReconcile
  // Shared modules (bundled into the Edge entrypoints above)
  "_shared/driverWithdrawProviderReconcile",
  "_shared/companyBalanceResolveSSOT.ensureBusinessAccessToken",
] as const;

/** Atomic Edge redeploy set for 9.4D (excludes linkage). */
export const BUSINESS_OAUTH_REFRESH_REDEPLOY_SET = [
  "admin-submit-driver-payout-payment",
  "admin-finalize-driver-payout-completion",
  "admin-execute-weekly-payout-occurrence",
  "driver-withdraw",
  "admin-company-payees",
  "admin-submit-company-transfer-payment",
  "admin-finalize-company-transfer-completion",
  "admin-sync-company-transfer-provider-status",
  "reconcile-submitted-driver-withdrawals",
  // company balance surfaces
  "admin-company-outgoing-transfer",
  "admin-payout-ledger",
] as const;

/** Jail-validated subset ready for atomic deploy once migration is approved. */
export const BUSINESS_OAUTH_REFRESH_JAIL_PASS_SET = [
  "admin-submit-driver-payout-payment",
  "admin-finalize-driver-payout-completion",
  "admin-execute-weekly-payout-occurrence",
  "driver-withdraw",
  "admin-company-payees",
  "reconcile-submitted-driver-withdrawals",
  "admin-payout-ledger",
] as const;


/** Functions that only read tokens / pass them to relay (no vault write in that module). */
export const BUSINESS_TOKEN_READ_PASSERS = [
  "admin-revolut-business-oauth", // diagnostics; may refresh when include_accounts
] as const;


export type ContinuityOwnerVerdict =
  | "NO_DURABLE_BUSINESS_OAUTH_REFRESH_OWNER"
  | { model: "A" | "B" | "C"; owner: string };

/**
 * Rejected patterns that prevent declaring a durable owner.
 */
export function classifyDurableRefreshOwner(args: {
  scheduledRefreshCronExists: boolean;
  relayOwnsRefresh: boolean;
  refreshWriters: readonly string[];
  hasDurableLock: boolean;
  temporaryManualRefreshDeployed: boolean;
}): ContinuityOwnerVerdict {
  if (args.temporaryManualRefreshDeployed) {
    return "NO_DURABLE_BUSINESS_OAUTH_REFRESH_OWNER";
  }
  if (args.relayOwnsRefresh && args.refreshWriters.length === 0) {
    return { model: "C", owner: "fixed-egress-relay" };
  }
  if (args.scheduledRefreshCronExists && args.refreshWriters.length <= 1 && args.hasDurableLock) {
    return { model: "A", owner: "scheduled-refresh-job" };
  }
  if (
    args.refreshWriters.length === 1
    && args.hasDurableLock
    && !args.relayOwnsRefresh
  ) {
    return { model: "B", owner: args.refreshWriters[0]! };
  }
  // Multiple independent writers and/or no lock → not durable.
  return "NO_DURABLE_BUSINESS_OAUTH_REFRESH_OWNER";
}

export function tokenNeedsRefresh(args: {
  nowMs: number;
  expiresAtIso: string | null;
  skewMs?: number;
}): boolean {
  if (!args.expiresAtIso) return true;
  const exp = Date.parse(args.expiresAtIso);
  if (!Number.isFinite(exp)) return true;
  return exp <= args.nowMs + (args.skewMs ?? REFRESH_SKEW_MS);
}

export type MockVault = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  generation: number;
};

/**
 * Minimal model of ensureFresh without network — for continuity tests.
 * Intentionally has NO lock (mirrors production helper).
 */
export async function mockEnsureFresh(args: {
  vault: MockVault;
  nowMs: number;
  refreshFn: (refreshToken: string) => Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }>;
  onRefreshAttempt?: () => void;
}): Promise<{ accessToken: string; refreshed: boolean }> {
  if (!tokenNeedsRefresh({ nowMs: args.nowMs, expiresAtIso: args.vault.expires_at })) {
    return { accessToken: args.vault.access_token, refreshed: false };
  }
  args.onRefreshAttempt?.();
  const next = await args.refreshFn(args.vault.refresh_token);
  args.vault.access_token = next.access_token;
  if (next.refresh_token) args.vault.refresh_token = next.refresh_token;
  args.vault.expires_at = new Date(args.nowMs + Math.max(60, next.expires_in) * 1000).toISOString();
  args.vault.generation += 1;
  return { accessToken: args.vault.access_token, refreshed: true };
}

/**
 * Concurrent stale writer guard (desired). Production ensureFresh lacks this.
 */
export function shouldPersistRefreshAgainstNewerGeneration(args: {
  startedGeneration: number;
  currentGeneration: number;
}): boolean {
  return args.currentGeneration <= args.startedGeneration;
}

export type Pay401Policy = {
  retry_pay: boolean;
  refresh_then_replay_pay: boolean;
  abort_claim: boolean;
};

/** Production submit: single /pay attempt; 4xx without payment id aborts claim — no blind replay. */
export function classifyPayAuthFailurePolicy(args: {
  revolut_pay_called: boolean;
  http_status: number;
  provider_payment_id: string | null;
}): Pay401Policy {
  if (args.http_status === 401 && args.revolut_pay_called && !args.provider_payment_id) {
    return { retry_pay: false, refresh_then_replay_pay: false, abort_claim: true };
  }
  if (args.http_status === 401 && !args.revolut_pay_called) {
    return { retry_pay: false, refresh_then_replay_pay: false, abort_claim: true };
  }
  return { retry_pay: false, refresh_then_replay_pay: false, abort_claim: false };
}

export type Get401Policy = {
  refresh_count_max: number;
  get_retry_max: number;
};

/**
 * Desired: at most one refresh + one GET retry.
 * Production reconcile: ensureFresh once, then one GET — NO second refresh on GET 401.
 */
export function classifyGetAuthFailurePolicy(production: boolean): Get401Policy {
  if (production) {
    return { refresh_count_max: 1, get_retry_max: 0 }; // proactive refresh only; no GET-401 retry
  }
  return { refresh_count_max: 1, get_retry_max: 1 };
}

export function remainingLifetimeSeconds(args: {
  nowMs: number;
  expiresAtIso: string;
}): number {
  return (Date.parse(args.expiresAtIso) - args.nowMs) / 1000;
}

export const LINKAGE_MISSING_EXPORTS = [
  "decryptDestinationIdentifier",
  "normalizeDestinationVerificationStatus",
  "parseUkBankIdentifier",
] as const;

export type LinkageClassification =
  | "GO_LIVE_CRITICAL_BOOT_DEFECT"
  | "NON_CRITICAL_UNUSED_LEGACY_PATH"
  | "REPLACED_BY_CANONICAL_PATH";

export function classifyLinkageBootDefect(args: {
  boots: boolean;
  adminUiCallerExists: boolean;
  ownsOauthRenewal: boolean;
  replacedByOtherCanonicalLinker: boolean;
}): LinkageClassification {
  if (args.replacedByOtherCanonicalLinker) return "REPLACED_BY_CANONICAL_PATH";
  if (!args.boots && args.adminUiCallerExists) return "GO_LIVE_CRITICAL_BOOT_DEFECT";
  if (!args.boots && !args.adminUiCallerExists) return "NON_CRITICAL_UNUSED_LEGACY_PATH";
  return "NON_CRITICAL_UNUSED_LEGACY_PATH";
}
