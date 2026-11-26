/**
 * #57 — cancel-trip caller authority.
 *
 * Never trust body `cancelled_by` as proof of authority.
 * Never fall through from a failed Customer (rider) check to Driver assignment.
 * Verified role is the only source of fee / payment / notification semantics.
 *
 * #110 P6 H1: corporate members and trip-managing staff are resolved server-side
 * (membership / page access), never from body cancelled_by_role.
 */

export type CancelTripClaimedRole = "rider" | "driver" | "admin";

export type CancelTripAuthOk = {
  ok: true;
  /** Authoritative workflow role — not the raw body string. */
  cancelledBy: CancelTripClaimedRole;
  cancelledById: string;
};

export type CancelTripAuthDenied = {
  ok: false;
  status: 403;
  error: string;
  code:
    | "FORBIDDEN"
    | "RIDER_NOT_PASSENGER"
    | "DRIVER_NOT_ASSIGNED"
    | "ROLE_MISMATCH"
    | "INVALID_CANCELLED_BY";
};

export type CancelTripAuthDecision = CancelTripAuthOk | CancelTripAuthDenied;

function normalizeClaimedRole(raw: unknown): CancelTripClaimedRole | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "rider" || v === "passenger" || v === "customer" || v === "corporate") {
    return "rider";
  }
  if (v === "driver") return "driver";
  if (v === "admin") return "admin";
  return null;
}

function isAssignedDriver(args: {
  driverId: string | null;
  tripDriverId: string | null;
  tripConfirmedDriverId: string | null;
}): boolean {
  if (!args.driverId) return false;
  return (
    args.tripDriverId === args.driverId ||
    args.tripConfirmedDriverId === args.driverId
  );
}

/**
 * Resolve cancel authority from verified identities + claimed workflow role.
 */
export function resolveCancelTripCallerAuthority(input: {
  claimedCancelledBy: unknown;
  isAdmin: boolean;
  /**
   * Staff with active-trips / corporate-accounts page access (server-verified).
   * Same fee semantics as isAdmin when claiming admin/rider.
   */
  isStaffTripManager?: boolean;
  /**
   * Caller is a verified member of the trip's corporate_account_id.
   * May cancel with rider fee semantics (corporate booking on behalf of rider).
   */
  isCorporateMemberOfTrip?: boolean;
  callerUserId: string;
  customerId: string | null;
  driverId: string | null;
  tripPassengerId: string | null;
  tripDriverId: string | null;
  tripConfirmedDriverId: string | null;
}): CancelTripAuthDecision {
  const claimed = normalizeClaimedRole(input.claimedCancelledBy);
  if (!claimed) {
    return {
      ok: false,
      status: 403,
      code: "INVALID_CANCELLED_BY",
      error: "Forbidden: invalid cancelled_by",
    };
  }

  const staffLike = input.isAdmin || input.isStaffTripManager === true;

  if (staffLike) {
    // Admins / trip staff may run rider-fee or admin workflows; body selects fee path only.
    if (claimed !== "admin" && claimed !== "rider") {
      return {
        ok: false,
        status: 403,
        code: "ROLE_MISMATCH",
        error: "Forbidden: admin cancel must use cancelled_by admin or rider",
      };
    }
    return {
      ok: true,
      cancelledBy: claimed === "rider" ? "rider" : "admin",
      cancelledById: input.callerUserId,
    };
  }

  if (claimed === "admin") {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      error: "Forbidden: caller not authorised to cancel this trip",
    };
  }

  if (claimed === "rider") {
    if (input.isCorporateMemberOfTrip === true) {
      return {
        ok: true,
        cancelledBy: "rider",
        cancelledById: input.callerUserId,
      };
    }
    const passengerId =
      typeof input.tripPassengerId === "string" ? input.tripPassengerId : null;
    if (!input.customerId || !passengerId || input.customerId !== passengerId) {
      return {
        ok: false,
        status: 403,
        code: "RIDER_NOT_PASSENGER",
        error: "Forbidden: caller is not the passenger for this trip",
      };
    }
    // Do not fall through to driver assignment when rider claim fails —
    // ownership is exclusive for this claimed role.
    return {
      ok: true,
      cancelledBy: "rider",
      cancelledById: input.customerId,
    };
  }

  // claimed === "driver"
  if (
    !isAssignedDriver({
      driverId: input.driverId,
      tripDriverId: input.tripDriverId,
      tripConfirmedDriverId: input.tripConfirmedDriverId,
    })
  ) {
    return {
      ok: false,
      status: 403,
      code: "DRIVER_NOT_ASSIGNED",
      error: "Forbidden: caller is not the assigned driver for this trip",
    };
  }
  return {
    ok: true,
    cancelledBy: "driver",
    cancelledById: input.driverId!,
  };
}
