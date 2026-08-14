/**
 * Driver auth → drivers row resolution SSOT (shared).
 * Recovered for driver-payout-settings Stripe Connect strip redeploy.
 */

export type DriverResolveErrorCode =
  | "auth_user_missing"
  | "unauthorized"
  | "rls_denied"
  | "driver_row_missing"
  | "driver_not_found"
  | "profile_mismatch"
  | "missing_driver_id"
  | "missing_email"
  | "stripe_not_configured"
  | "stripe_secret_missing";

export type ResolvedAuthenticatedDriver = {
  driver_id: string;
  user_id: string;
  email: string;
  full_name: string;
  phone: string | null;
  first_name: string;
  last_name: string;
};

export type DriverResolveResult =
  | {
    ok: true;
    driver: ResolvedAuthenticatedDriver;
    source: string;
    multiple_driver_rows?: boolean;
  }
  | {
    ok: false;
    reason: DriverResolveErrorCode;
    message: string;
    detail?: string;
  };

export type DriverRowForResolve = {
  id?: string | null;
  user_id?: string | null;
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  deleted_at?: string | null;
};

export type ProfileRowForResolve = {
  user_id?: string | null;
  role?: string | null;
  full_name?: string | null;
};

export function payoutSetupMessageForReason(
  reason: DriverResolveErrorCode | string,
  fallbackMessage: string,
): string {
  switch (reason) {
    case "driver_row_missing":
    case "driver_not_found":
      return "Driver profile not found. Please contact support.";
    case "profile_mismatch":
      return "Your account is not linked to a driver profile. Please contact support.";
    case "auth_user_missing":
    case "unauthorized":
      return "Please sign in again to set up payouts.";
    case "missing_email":
      return "Add an email to your driver profile before setting up payouts.";
    case "stripe_not_configured":
    case "stripe_secret_missing":
      return "Payout setup is temporarily unavailable. Please try again later.";
    default:
      return fallbackMessage;
  }
}

export function buildDriverFullName(
  firstName?: string | null,
  lastName?: string | null,
  profileFullName?: string | null,
): string {
  const first = (firstName ?? "").trim();
  const last = (lastName ?? "").trim();
  const combined = `${first} ${last}`.trim();
  if (combined.length > 0) return combined;
  const fromProfile = (profileFullName ?? "").trim();
  return fromProfile.length > 0 ? fromProfile : "Driver";
}

export function mapDriverRowToResolved(
  row: DriverRowForResolve,
): ResolvedAuthenticatedDriver | null {
  const driverId = (row.id ?? "").trim();
  if (!driverId) return null;
  const userId = (row.user_id ?? "").trim();
  if (!userId) return null;
  return {
    driver_id: driverId,
    user_id: userId,
    email: (row.email ?? "").trim(),
    full_name: buildDriverFullName(row.first_name, row.last_name),
    phone: row.phone?.trim() ? row.phone.trim() : null,
    first_name: (row.first_name ?? "").trim(),
    last_name: (row.last_name ?? "").trim(),
  };
}

export function pickActiveDriverRow(rows: DriverRowForResolve[]): {
  row: DriverRowForResolve | null;
  multiple: boolean;
} {
  const active = rows.filter((r) => !r.deleted_at);
  const candidates = active.length > 0 ? active : rows;
  if (candidates.length === 0) return { row: null, multiple: false };
  return { row: candidates[0], multiple: candidates.length > 1 };
}

export function resolveDriverFromRows(
  authUserId: string,
  driverRows: DriverRowForResolve[],
  profile: ProfileRowForResolve | null,
): DriverResolveResult {
  const { row, multiple } = pickActiveDriverRow(driverRows);
  if (row) {
    const mapped = mapDriverRowToResolved(row);
    if (!mapped) {
      return {
        ok: false,
        reason: "missing_driver_id",
        message: "Driver record is incomplete. Please contact support.",
      };
    }
    if (mapped.user_id !== authUserId) {
      return {
        ok: false,
        reason: "profile_mismatch",
        message: "Driver profile does not match your signed-in account.",
        detail: "driver_user_id_mismatch",
      };
    }
    return {
      ok: true,
      driver: mapped,
      source: "drivers_user_id",
      multiple_driver_rows: multiple || undefined,
    };
  }
  if (profile) {
    if (profile.role === "customer" || profile.role === "corporate") {
      return {
        ok: false,
        reason: "profile_mismatch",
        message: "This account is not registered as a driver.",
        detail: `profile_role_${profile.role}`,
      };
    }
    if (profile.role === "driver") {
      return {
        ok: false,
        reason: "driver_row_missing",
        message: "Driver profile not found. Please contact support.",
        detail: "profile_driver_role_without_drivers_row",
      };
    }
    return {
      ok: false,
      reason: "profile_mismatch",
      message: "Your account is not linked to a driver profile.",
      detail: `profile_role_${profile.role}`,
    };
  }
  return {
    ok: false,
    reason: "driver_row_missing",
    message: "Driver profile not found. Please contact support.",
    detail: "no_drivers_row_no_profile",
  };
}
