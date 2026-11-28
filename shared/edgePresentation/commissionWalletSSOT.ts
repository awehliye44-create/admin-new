/** Admin presentation-only helpers; not part of Edge uploads. */
import { normalizeAdminCommissionCreditType, ADMIN_COMMISSION_CREDIT_KIND, CommissionWalletRolloutState, CommissionWalletSaEnablementPlan, COMMISSION_WALLET_PHASE8_PILOT } from "../../supabase/functions/_shared/commissionWalletSSOT.ts";


export const DEFAULT_CASH_UPFRONT_POLICY_NOTICE =
  "ONECAB is digital-only. Passenger cash is retired — customers must pay in the app (card or mobile wallet). Driver-collected cash is not supported for new trips.";


export function adminCommissionCreditTypeLabel(creditType: string | null | undefined): string {
  switch (normalizeAdminCommissionCreditType(creditType) ?? String(creditType ?? "").toUpperCase()) {
    case ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT:
      return "Welcome Credit";
    case ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT:
      return "Promotional Credit";
    case ADMIN_COMMISSION_CREDIT_KIND.GOODWILL_CREDIT:
      return "Goodwill Credit";
    case ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION:
      return "Support Correction";
    case ADMIN_COMMISSION_CREDIT_KIND.OTHER:
      return "Other";
    default:
      return String(creditType ?? "Credit");
  }
}


/** True when a driver row is eligible for Admin Add Credit listing. */
export function isDriverEligibleForAdminCommissionCredit(input: {
  approvalStatus: string | null | undefined;
  driverStatus: string | null | undefined;
  deletedAt?: string | null;
  /** Canonical drivers.service_area_id */
  driverServiceAreaId: string | null | undefined;
  selectedServiceAreaId: string;
  includeInactive?: boolean;
}): boolean {
  if (input.deletedAt) return false;
  if (String(input.approvalStatus ?? "").toLowerCase() !== "approved") return false;
  const status = String(input.driverStatus ?? "").toLowerCase();
  if (!input.includeInactive && status !== "active") return false;
  if (input.includeInactive && (status === "deleted" || !status)) return false;
  return String(input.driverServiceAreaId ?? "") === String(input.selectedServiceAreaId ?? "");
}


/** Client search for Add Credit driver picker. */
export function matchesAdminCommissionCreditDriverSearch(
  driver: {
    id: string;
    driver_code?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    license_plate?: string | null;
  },
  search: string,
): boolean {
  const q = String(search ?? "").trim().toLowerCase();
  if (!q) return true;
  const name = `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim().toLowerCase();
  const code = String(driver.driver_code ?? "").toLowerCase();
  const phone = String(driver.phone ?? "").toLowerCase();
  const plate = String(driver.license_plate ?? "").toLowerCase();
  const id = String(driver.id ?? "").toLowerCase();
  return (
    name.includes(q)
    || code.includes(q)
    || phone.includes(q)
    || plate.includes(q)
    || id.startsWith(q)
    || id.includes(q)
  );
}


/**
 * Admin enable gate for Phase 8. Disabling is always allowed.
 * When multi_sa_unlocked is false, only the pilot SA may turn commission_wallet_enabled on.
 */
export function planCommissionWalletServiceAreaEnablement(input: {
  serviceAreaId: string;
  enabling: boolean;
  rollout: CommissionWalletRolloutState | null | undefined;
}): CommissionWalletSaEnablementPlan {
  if (!input.enabling) return { ok: true };
  if (!input.rollout) {
    return {
      ok: false,
      code: "ROLLOUT_MISSING",
      error:
        "Commission Wallet rollout lock is missing. Refuse enable until Phase 8 rollout row exists.",
    };
  }
  if (input.rollout.multi_sa_unlocked === true) return { ok: true };
  const pilotId = String(input.rollout.pilot_service_area_id ?? "").trim();
  if (!pilotId) {
    return {
      ok: false,
      code: "ROLLOUT_MISSING",
      error: "Commission Wallet pilot service area is not configured.",
    };
  }
  if (String(input.serviceAreaId) === pilotId) return { ok: true };
  return {
    ok: false,
    code: "PILOT_LOCK",
    error:
      `Phase 8 pilot lock: only ${COMMISSION_WALLET_PHASE8_PILOT.service_area_name} `
      + "may enable Commission Wallet until reconciliation unlocks multi-SA.",
  };
}

export * from "../../supabase/functions/_shared/commissionWalletSSOT.ts";
