/**
 * Dispatch wave recheck policy — temporary health exclusions must not permanently
 * block drivers across broadcast rounds. Each wave re-evaluates current state.
 */ /** Canonical temporary reasons (admin + ops). */ export const TEMPORARY_DISPATCH_REJECT_REASONS = new Set([
  "stale_heartbeat",
  "stale_location",
  "lost_connection",
  "presence_degraded",
  "socket_disconnected",
  "app_background_suspended",
  "backend_online_mismatch",
  "push_token_refreshing",
  "no_presence_row",
  "critical_tracking_alert",
  "no_socket_no_push",
  "not_reachable"
]);
/** Permanent exclusions for the remainder of the trip / compliance. */ export const PERMANENT_DISPATCH_REJECT_REASONS = new Set([
  "service_area_mismatch",
  "service_mismatch",
  "documents_not_approved",
  "documents_expired",
  "vehicle_not_approved",
  "vehicle_type_disabled",
  "missing_required_vehicle_category",
  "category_mismatch",
  "manual_offline",
  "manual_go_offline",
  "manual_logout",
  "logout",
  "driver_offline",
  "session_invalid",
  "token_refresh_failed",
  "admin_force_offline",
  "active_device_takeover",
  "outside_service_area",
  "outside_radius",
  "exceeds_driver_max_pickup_distance",
  "driver_declined_with_cooldown",
  "cooldown_after_decline",
  "negotiation_decline_permanent_exclusion",
  "not_approved",
  "driver_status_not_active",
  "busy_on_trip",
  "existing_offer_for_trip",
  "max_concurrent_offers",
  "no_cash_preference",
  "beyond_wave_cap",
  "identity_verification_required",
  "identity_verification_processing",
  "identity_verification_under_review",
  "identity_verification_blocked",
  "identity_reference_unavailable",
]);
/** Map internal gate codes to canonical policy reason strings. */ export function canonicalizeDispatchRejectReason(raw, ctx) {
  switch(raw){
    case "stale_heartbeat":
      return "stale_heartbeat";
    case "stale_location":
      return "lost_connection";
    case "presence_not_online":
      if (ctx?.appState === "background") return "app_background_suspended";
      return "presence_degraded";
    case "realtime_unhealthy":
      return "socket_disconnected";
    case "no_registered_push_token":
      return "push_token_refreshing";
    case "no_socket_no_push":
    case "not_reachable":
      return "no_socket_no_push";
    case "driver_offline":
      if (ctx?.driverOnlineIntent === true) return "backend_online_mismatch";
      return "manual_offline";
    case "service_mismatch":
      return "service_area_mismatch";
    case "missing_required_vehicle_category":
      return "category_mismatch";
    case "vehicle_type_disabled":
      return "vehicle_not_approved";
    case "outside_radius":
    case "exceeds_driver_max_pickup_distance":
      return "outside_service_area";
    case "cooldown_after_decline":
      return "driver_declined_with_cooldown";
    case "negotiation_decline_permanent_exclusion":
      return "negotiation_decline_permanent_exclusion";
    default:
      return raw;
  }
}
export function classifyDispatchExclusion(canonicalReason) {
  if (!canonicalReason || canonicalReason === "eligible" || canonicalReason === DISPATCHABLE_DEGRADED) {
    return "none";
  }
  if (PERMANENT_DISPATCH_REJECT_REASONS.has(canonicalReason)) return "permanent";
  if (TEMPORARY_DISPATCH_REJECT_REASONS.has(canonicalReason)) return "temporary";
  return "permanent";
}
export function isDispatchRecheckableReason(canonicalReason) {
  return classifyDispatchExclusion(canonicalReason) === "temporary";
}
export function buildPriorDispatchRecheckState(rows, currentRound) {
  const map = new Map();
  for (const row of rows){
    const driverId = row.driver_id;
    if (!driverId) continue;
    const ctx = row.context && typeof row.context === "object" ? row.context : {};
    const round = typeof ctx.round === "number" ? ctx.round : 0;
    if (round >= currentRound) continue;
    const prior = map.get(driverId) ?? {
      hadTemporaryExclusion: false,
      hadEligible: false,
      maxPriorRound: 0,
      lastRejectReason: null,
      lastExclusionClass: null
    };
    prior.maxPriorRound = Math.max(prior.maxPriorRound, round);
    if (row.is_eligible === true) {
      prior.hadEligible = true;
    } else {
      const canonical = typeof ctx.canonical_reject_reason === "string" && ctx.canonical_reject_reason || canonicalizeDispatchRejectReason(row.reject_reason ?? "unknown");
      const exClass = ctx.exclusion_class === "temporary" || ctx.exclusion_class === "permanent" ? ctx.exclusion_class : classifyDispatchExclusion(canonical);
      prior.lastRejectReason = canonical;
      prior.lastExclusionClass = exClass;
      if (exClass === "temporary") prior.hadTemporaryExclusion = true;
    }
    map.set(driverId, prior);
  }
  return map;
}
export function computeDispatchRecheckAdminLabel(args) {
  const round = Math.max(1, args.currentRound);
  const prior = args.prior;
  const hadPriorTemp = !!prior?.hadTemporaryExclusion;
  if (args.offerCreatedThisRun && hadPriorTemp) {
    return "OFFER_CREATED_AFTER_RECOVERY";
  }
  if (args.isEligible && hadPriorTemp && !prior?.hadEligible && round >= 3) {
    return "BECAME_ELIGIBLE_ROUND_3";
  }
  if (hadPriorTemp && round === 2) {
    return "RECHECKED_ROUND_2";
  }
  if (!args.isEligible && args.exclusionClass === "temporary" && round === 1) {
    return "TEMPORARY_EXCLUDED_ROUND_1";
  }
  return null;
}
/** Logged when driver passes hard gates but connection/presence is degraded — still offerable. */ export const DISPATCHABLE_DEGRADED = "dispatchable_degraded";
/**
 * Health/posture reasons that must NOT hard-exclude when driver is intentionally online
 * with a registered push token. Offers are created with lower dispatch priority.
 */ export const DEGRADABLE_HEALTH_REJECT_REASONS = new Set([
  "stale_heartbeat",
  "lost_connection",
  "presence_degraded",
  "socket_disconnected",
  "app_background_suspended",
  "connection_degraded"
]);
/**
 * Connection/presence degradation must not block dispatch when the driver is intentionally
 * online and has a push token. Hard gates (offline, no token, no coords) still apply.
 */ export function evaluateDispatchableReadiness(args) {
  const { healthIssuesRaw, driverOnlineIntent, isOnline, hasRegisteredPushToken, hasRealtimeFresh, hasCoords, appState } = args;
  if (!hasCoords) {
    return {
      eligible: false,
      degraded: false,
      hardRejectReason: "no_location",
      degradedHealthReasons: []
    };
  }
  if (!isOnline) {
    return {
      eligible: false,
      degraded: false,
      hardRejectReason: canonicalizeDispatchRejectReason("driver_offline", {
        driverOnlineIntent
      }),
      degradedHealthReasons: []
    };
  }
  const deliveryReachable = hasRegisteredPushToken || hasRealtimeFresh;
  if (!deliveryReachable) {
    return {
      eligible: false,
      degraded: false,
      hardRejectReason: "no_socket_no_push",
      degradedHealthReasons: []
    };
  }
  const filteredHealthIssues = healthIssuesRaw.filter((raw)=>{
    if (raw === "no_registered_push_token" && hasRealtimeFresh) return false;
    if (raw === "realtime_unhealthy" && hasRegisteredPushToken) return false;
    return true;
  });
  const canonicalIssues = filteredHealthIssues.map((raw)=>canonicalizeDispatchRejectReason(raw, {
      driverOnlineIntent,
      appState
    }));
  const degradable = canonicalIssues.filter((r)=>DEGRADABLE_HEALTH_REJECT_REASONS.has(r));
  const hardHealth = canonicalIssues.filter((r)=>!DEGRADABLE_HEALTH_REJECT_REASONS.has(r));
  if (hardHealth.length > 0) {
    return {
      eligible: false,
      degraded: false,
      hardRejectReason: hardHealth[0],
      degradedHealthReasons: []
    };
  }
  if (degradable.length > 0 && driverOnlineIntent && deliveryReachable && isOnline) {
    return {
      eligible: true,
      degraded: true,
      hardRejectReason: null,
      degradedHealthReasons: degradable
    };
  }
  if (degradable.length > 0) {
    return {
      eligible: false,
      degraded: false,
      hardRejectReason: degradable[0],
      degradedHealthReasons: []
    };
  }
  return {
    eligible: true,
    degraded: false,
    hardRejectReason: null,
    degradedHealthReasons: []
  };
}
/** Active offer statuses that block creating another offer for the same trip. */ export const ACTIVE_OFFER_BLOCKING_STATUSES = [
  "pending",
  "accepted",
  "countered"
];
