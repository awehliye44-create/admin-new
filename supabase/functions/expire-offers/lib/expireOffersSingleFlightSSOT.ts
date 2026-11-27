/**
 * B1 — expire-offers single-flight lease helpers (Edge-safe durable claim).
 * Feature-flagged: EXPIRE_OFFERS_SINGLE_FLIGHT=1 required to enable.
 * Does not change TTL / rematch / wave predicates.
 *
 * Fence: after claim, every new mutation unit must re-assert ownership.
 * Ownership-safe release alone is insufficient if a stalled worker resumes
 * after lease TTL reclaim by another owner.
 */

import type { AnySupabaseClient } from "../../_shared/supabaseClientTypes.ts";

export const EXPIRE_OFFERS_LEASE_TTL_SECONDS_DEFAULT = 18;
export const EXPIRE_OFFERS_BUDGET_MS_DEFAULT = 8000;
/** Budget must finish before TTL under healthy paths; stalls use fence. */
export const EXPIRE_OFFERS_BUDGET_LEASE_SLACK_SECONDS = 10;

export type ExpireOffersLeaseClaim = {
  acquired: boolean;
  ownerToken: string;
  reason?: string;
  leaseExpiresAt?: string | null;
  ttlSeconds?: number;
  error?: string;
};

/** Pure predicate — unit-tested. Free, expired, or same-owner renew → allow. */
export function shouldAllowExpireOffersLeaseClaim(params: {
  nowMs: number;
  ownerToken: string | null | undefined;
  leaseExpiresAtMs: number | null | undefined;
  claimantToken: string;
}): boolean {
  const claimant = params.claimantToken.trim();
  if (!claimant) return false;
  if (params.ownerToken == null || String(params.ownerToken).trim() === "") return true;
  if (String(params.ownerToken).trim() === claimant) return true;
  const exp = params.leaseExpiresAtMs;
  if (exp == null || !Number.isFinite(exp)) return true;
  return exp <= params.nowMs;
}

/** Pure predicate — release only if still owner (stale worker after reclaim → no-op). */
export function isOwnershipSafeExpireOffersRelease(params: {
  ownerToken: string | null | undefined;
  releaserToken: string;
}): boolean {
  const owner = params.ownerToken == null ? "" : String(params.ownerToken).trim();
  const releaser = params.releaserToken.trim();
  if (!owner || !releaser) return false;
  return owner === releaser;
}

/**
 * Pure fence: may mutate only while owner matches AND lease not expired.
 * Expired-but-still-named owner → stop (prevents resume after TTL before reclaim).
 */
export function mayMutateUnderExpireOffersLease(params: {
  nowMs: number;
  ownerToken: string | null | undefined;
  leaseExpiresAtMs: number | null | undefined;
  workerToken: string;
}): boolean {
  const worker = params.workerToken.trim();
  const owner = params.ownerToken == null ? "" : String(params.ownerToken).trim();
  if (!worker || !owner || owner !== worker) return false;
  const exp = params.leaseExpiresAtMs;
  if (exp == null || !Number.isFinite(exp)) return false;
  return exp > params.nowMs;
}

/** Invariant: default budget + slack ≤ default lease TTL. */
export function expireOffersBudgetFitsLease(params?: {
  budgetMs?: number;
  leaseTtlSeconds?: number;
}): boolean {
  const budgetMs = params?.budgetMs ?? EXPIRE_OFFERS_BUDGET_MS_DEFAULT;
  const leaseTtlSeconds = params?.leaseTtlSeconds ?? EXPIRE_OFFERS_LEASE_TTL_SECONDS_DEFAULT;
  if (budgetMs <= 0) return true; // unlimited diagnostic — fence still required
  return budgetMs / 1000 + EXPIRE_OFFERS_BUDGET_LEASE_SLACK_SECONDS <= leaseTtlSeconds;
}

export function isExpireOffersSingleFlightEnabled(
  raw: string | undefined = typeof Deno !== "undefined"
    ? Deno.env.get("EXPIRE_OFFERS_SINGLE_FLIGHT")
    : undefined,
): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function resolveExpireOffersLeaseTtlSeconds(
  raw: string | undefined = typeof Deno !== "undefined"
    ? Deno.env.get("EXPIRE_OFFERS_LEASE_TTL_SECONDS")
    : undefined,
): number {
  if (raw == null || raw.trim() === "") return EXPIRE_OFFERS_LEASE_TTL_SECONDS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return EXPIRE_OFFERS_LEASE_TTL_SECONDS_DEFAULT;
  return Math.max(5, Math.min(60, Math.floor(n)));
}

export function resolveExpireOffersBudgetMs(
  raw: string | undefined = typeof Deno !== "undefined"
    ? Deno.env.get("EXPIRE_OFFERS_BUDGET_MS")
    : undefined,
): number {
  if (raw == null || raw.trim() === "") return EXPIRE_OFFERS_BUDGET_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return EXPIRE_OFFERS_BUDGET_MS_DEFAULT;
  // 0 disables budget (unlimited) for diagnostics only.
  if (n === 0) return 0;
  return Math.max(1000, Math.min(30_000, Math.floor(n)));
}

export async function tryClaimExpireOffersLease(
  supabase: AnySupabaseClient,
  ownerToken: string,
  ttlSeconds: number = resolveExpireOffersLeaseTtlSeconds(),
): Promise<ExpireOffersLeaseClaim> {
  const { data, error } = await supabase.rpc("try_claim_expire_offers_lease", {
    p_owner_token: ownerToken,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) {
    return {
      acquired: false,
      ownerToken,
      reason: "rpc_error",
      error: error.message,
    };
  }
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    acquired: row.acquired === true,
    ownerToken,
    reason: typeof row.reason === "string" ? row.reason : undefined,
    leaseExpiresAt: typeof row.lease_expires_at === "string" ? row.lease_expires_at : null,
    ttlSeconds: typeof row.ttl_seconds === "number" ? row.ttl_seconds : ttlSeconds,
    error: typeof row.error_code === "string" ? row.error_code : undefined,
  };
}

export async function releaseExpireOffersLease(
  supabase: AnySupabaseClient,
  ownerToken: string,
): Promise<{ released: boolean; reason?: string; error?: string }> {
  const { data, error } = await supabase.rpc("release_expire_offers_lease", {
    p_owner_token: ownerToken,
  });
  if (error) {
    return { released: false, reason: "rpc_error", error: error.message };
  }
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    released: row.released === true,
    reason: typeof row.reason === "string" ? row.reason : undefined,
    error: typeof row.error_code === "string" ? row.error_code : undefined,
  };
}

export async function assertExpireOffersLeaseOwner(
  supabase: AnySupabaseClient,
  ownerToken: string,
): Promise<{ stillOwner: boolean; reason?: string; error?: string }> {
  const { data, error } = await supabase.rpc("assert_expire_offers_lease_owner", {
    p_owner_token: ownerToken,
  });
  if (error) {
    // Fail closed: do not mutate if fence cannot be verified.
    return { stillOwner: false, reason: "rpc_error", error: error.message };
  }
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    stillOwner: row.still_owner === true,
    reason: typeof row.reason === "string" ? row.reason : undefined,
    error: typeof row.error_code === "string" ? row.error_code : undefined,
  };
}
