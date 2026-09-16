/**
 * Live Customer Assistant auth + busy-workflow checks for the Edge entrypoint.
 * Injected into the I/O-free handler so unit tests never touch Supabase.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { AuthenticateCustomer, CustomerAuthResult } from "./customerAuth.ts";
import { evaluateCustomerAssistantBusyFromRows, isCustomerAssistantBusy } from "./customerBusyGate.ts";
import { readInstallationId } from "./driverAuth.ts";

const BLOCKED_RIDER_STATUSES = new Set(["disabled", "suspended", "banned", "blocked"]);

const TRIP_SELECT =
  "id, status, booking_type, trip_type, is_scheduled, scheduled_status, dispatch_mode, scheduled_at, scheduled_broadcast_at, scheduled_convert_at, searching_expires_at, driver_id, confirmed_driver_id, passenger_id";

function isActiveCustomerAccount(row: {
  deleted_at?: string | null;
  rider_status?: string | null;
} | null): boolean {
  if (!row) return false;
  if (row.deleted_at) return false;
  const status = String(row.rider_status ?? "active").trim().toLowerCase();
  return !BLOCKED_RIDER_STATUSES.has(status);
}

async function hasPendingTripRating(
  admin: SupabaseClient,
  customerId: string,
): Promise<boolean> {
  const { data: trips } = await admin
    .from("trips")
    .select("id")
    .eq("passenger_id", customerId)
    .eq("status", "completed")
    .order("completed_at", { ascending: true, nullsFirst: false })
    .limit(8);
  const ids = (trips ?? []).map((row) => row.id).filter((id): id is string => typeof id === "string");
  if (!ids.length) return false;
  const { data: feedback } = await admin
    .from("rider_feedback")
    .select("trip_id")
    .eq("customer_id", customerId)
    .in("trip_id", ids);
  const rated = new Set((feedback ?? []).map((row) => String(row.trip_id ?? "")));
  return ids.some((id) => !rated.has(id));
}

export function createCustomerAuthenticator(admin: SupabaseClient): AuthenticateCustomer {
  return async function authenticateCustomer(args): Promise<CustomerAuthResult> {
    const jwt = args.jwt?.trim() ?? "";
    if (!jwt) return { ok: false, reason: "unauthorized" };

    const installationId = readInstallationId(args.installationId);
    if (!installationId) return { ok: false, reason: "unauthorized" };

    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    const authUserId = userData?.user?.id ?? null;
    if (userError || !authUserId) return { ok: false, reason: "unauthorized" };

    const { data: customerRow } = await admin
      .from("customers")
      .select("id, first_name, rider_status, deleted_at, active_trip_id")
      .eq("user_id", authUserId)
      .maybeSingle();

    if (!customerRow?.id || !isActiveCustomerAccount(customerRow)) {
      return { ok: false, reason: "not_customer" };
    }

    const { data: activeDevice } = await admin
      .from("customer_active_devices")
      .select("device_id")
      .eq("user_id", authUserId)
      .maybeSingle();
    const activeDeviceId =
      typeof activeDevice?.device_id === "string" ? activeDevice.device_id.trim() : "";
    // Fail-open when no authoritative row exists (same as verify-device).
    if (activeDeviceId && activeDeviceId !== installationId) {
      return { ok: false, reason: "device_replaced" };
    }

    const customerId = String(customerRow.id);
    const trips: Record<string, unknown>[] = [];
    if (customerRow.active_trip_id) {
      const { data: pointed } = await admin
        .from("trips")
        .select(TRIP_SELECT)
        .eq("id", customerRow.active_trip_id)
        .maybeSingle();
      if (pointed) trips.push(pointed as Record<string, unknown>);
    }
    const { data: recent } = await admin
      .from("trips")
      .select(TRIP_SELECT)
      .eq("passenger_id", customerId)
      .order("created_at", { ascending: false })
      .limit(12);
    for (const row of recent ?? []) {
      trips.push(row as Record<string, unknown>);
    }

    const pendingRating = await hasPendingTripRating(admin, customerId);
    const busy = evaluateCustomerAssistantBusyFromRows({ trips, pendingRating });
    if (isCustomerAssistantBusy(busy)) return { ok: false, reason: "busy_workflow" };

    const firstName =
      typeof customerRow.first_name === "string" && customerRow.first_name.trim()
        ? customerRow.first_name.trim()
        : null;

    return {
      ok: true,
      identity: {
        authUserId,
        customerId,
        firstName,
        installationId,
      },
    };
  };
}
