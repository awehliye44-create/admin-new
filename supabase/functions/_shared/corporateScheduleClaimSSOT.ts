/**
 * Corporate schedule window claim SSOT (org-scoped).
 * Pure logic + in-memory claim registry for concurrency tests.
 * Production Edge persists via draft RPC claim_corporate_schedule_hold (NOT APPLIED until Ahmed).
 */
import {
  findCorporateScheduleOverlap,
  tripWindowMs,
  type CorporateOverlapTrip,
  CORPORATE_OVERLAP_BUFFER_MINUTES,
} from "./corporateScheduleOverlapSSOT.ts";

export type ScheduleClaim = {
  corporateAccountId: string;
  clientActionId: string;
  scheduledAt: string;
  durationMinutes: number;
  windowStartMs: number;
  windowEndMs: number;
};

export type ClaimResult =
  | { ok: true; claim: ScheduleClaim; idempotent: boolean }
  | { ok: false; code: "SCHEDULE_OVERLAP"; conflicting_client_action_id?: string; conflicting_trip_id?: string }
  | { ok: false; code: "CLAIM_RACE" };

/** In-memory registry — mirrors DB exclusion for unit/concurrency tests. */
export class CorporateScheduleClaimRegistry {
  private claims = new Map<string, ScheduleClaim>(); // key = clientActionId
  private byOrg = new Map<string, Set<string>>(); // org -> clientActionIds
  private locks = new Map<string, Promise<void>>();

  private async withOrgLock<T>(orgId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.locks.get(orgId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(orgId, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(orgId) === gate) this.locks.delete(orgId);
    }
  }

  async claim(args: {
    corporateAccountId: string;
    clientActionId: string;
    scheduledAt: string;
    durationMinutes: number;
    existingTrips: CorporateOverlapTrip[];
  }): Promise<ClaimResult> {
    return await this.withOrgLock(args.corporateAccountId, () => {
      const existing = this.claims.get(args.clientActionId);
      if (existing) {
        return { ok: true as const, claim: existing, idempotent: true };
      }

      const win = tripWindowMs({
        scheduled_at: args.scheduledAt,
        estimated_duration_minutes: args.durationMinutes,
      });
      if (!win) {
        return { ok: false as const, code: "SCHEDULE_OVERLAP" as const };
      }

      // Against committed trips
      const tripHit = findCorporateScheduleOverlap({
        candidateScheduledAt: args.scheduledAt,
        candidateDurationMinutes: args.durationMinutes,
        existing: args.existingTrips,
      });
      if (tripHit.has_conflict) {
        return {
          ok: false as const,
          code: "SCHEDULE_OVERLAP" as const,
          conflicting_trip_id: tripHit.conflicting_trip_id,
        };
      }

      // Against other held claims for this org
      const ids = this.byOrg.get(args.corporateAccountId) ?? new Set();
      for (const id of ids) {
        const other = this.claims.get(id);
        if (!other) continue;
        const otherAsTrip: CorporateOverlapTrip = {
          id: other.clientActionId,
          scheduled_at: other.scheduledAt,
          estimated_duration_minutes: other.durationMinutes,
          status: "scheduled",
        };
        const hit = findCorporateScheduleOverlap({
          candidateScheduledAt: args.scheduledAt,
          candidateDurationMinutes: args.durationMinutes,
          existing: [otherAsTrip],
        });
        if (hit.has_conflict) {
          return {
            ok: false as const,
            code: "SCHEDULE_OVERLAP" as const,
            conflicting_client_action_id: other.clientActionId,
          };
        }
      }

      const claim: ScheduleClaim = {
        corporateAccountId: args.corporateAccountId,
        clientActionId: args.clientActionId,
        scheduledAt: args.scheduledAt,
        durationMinutes: args.durationMinutes,
        windowStartMs: win.start,
        windowEndMs: win.end,
      };
      this.claims.set(args.clientActionId, claim);
      if (!this.byOrg.has(args.corporateAccountId)) {
        this.byOrg.set(args.corporateAccountId, new Set());
      }
      this.byOrg.get(args.corporateAccountId)!.add(args.clientActionId);
      return { ok: true as const, claim, idempotent: false };
    });
  }
}

export function hashCorporateScheduleLockKeys(
  corporateAccountId: string,
): { k1: number; k2: number } {
  // Stable 32-bit keys for pg_advisory_lock(k1,k2) — Edge draft RPC.
  let h = 2166136261;
  for (let i = 0; i < corporateAccountId.length; i++) {
    h ^= corporateAccountId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const k1 = (h >>> 0) % 2147483647;
  const k2 = 0xC0FFEE ^ (CORPORATE_OVERLAP_BUFFER_MINUTES << 8);
  return { k1, k2 };
}
