/** Offline test/audit-only helpers; not part of Edge uploads. */
import { DISPATCH_STATUS_OFFER_CREATE_BLOCKED } from "../../../functions/_shared/sweepExpiredOffers.ts";


/**
 * @deprecated MK-261106-007 — unique collision is transient; use
 * tripPatchAfterTransientOfferCreateFailure from dispatchWaveCommitResumeSSOT.
 * Kept for source-lock string matches / rollback readability.
 */
export function tripPatchAfterPermanentOfferCreateError(nowIso: string): {
  dispatch_status: typeof DISPATCH_STATUS_OFFER_CREATE_BLOCKED;
  updated_at: string;
} {
  return {
    dispatch_status: DISPATCH_STATUS_OFFER_CREATE_BLOCKED,
    updated_at: nowIso,
  };
}

export * from "../../../functions/_shared/sweepExpiredOffers.ts";
