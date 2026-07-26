/**
 * Driver offer-eligibility gate used by send-driver-notification.
 * Resolves from drivers + document/online signals — never trusts client flags.
 */

// deno-lint-ignore no-explicit-any
type Sb = any;

export type DriverOfferEligibility = {
  allowed: boolean;
  state: string;
  blocked_reasons: string[];
};

export async function canReceiveOffersByDriverId(
  supabase: Sb,
  driverId: string,
): Promise<DriverOfferEligibility> {
  const blocked: string[] = [];
  let state = "unknown";

  const { data: driver, error } = await supabase
    .from("drivers")
    .select(
      "id, deleted_at, approval_status, driver_status, onboarding_complete, is_online",
    )
    .eq("id", driverId)
    .maybeSingle();

  if (error || !driver) {
    return {
      allowed: false,
      state: "missing_driver",
      blocked_reasons: ["driver_not_found"],
    };
  }

  if (driver.deleted_at) {
    blocked.push("driver_deleted");
    state = "deleted";
  }

  const approval = String(driver.approval_status ?? "").toLowerCase();
  if (approval && approval !== "approved" && approval !== "active") {
    blocked.push(`approval:${approval || "unknown"}`);
    state = approval || state;
  }

  const status = String(driver.driver_status ?? "").toLowerCase();
  if (
    status &&
    ["suspended", "banned", "inactive", "blocked", "offboarded"].includes(status)
  ) {
    blocked.push(`status:${status}`);
    state = status;
  }

  if (driver.onboarding_complete === false) {
    blocked.push("onboarding_incomplete");
    state = "onboarding_incomplete";
  }

  if (blocked.length === 0) {
    state = driver.is_online ? "online" : "offline";
  }

  return {
    allowed: blocked.length === 0,
    state,
    blocked_reasons: blocked,
  };
}

export function logDriverEligibilityBlocked(
  source: string,
  driverId: string,
  eligibility: DriverOfferEligibility,
): void {
  console.warn(
    `[${source}] driver_offer_eligibility_blocked driver=${driverId} state=${eligibility.state} reasons=${eligibility.blocked_reasons.join(",")}`,
  );
}
