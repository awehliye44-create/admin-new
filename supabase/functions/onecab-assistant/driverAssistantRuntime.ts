/**
 * Live Driver Assistant auth + busy-workflow checks for the Edge entrypoint.
 * Injected into the I/O-free handler so unit tests never touch Supabase.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveAuthenticatedDriver } from "../_shared/resolveAuthenticatedDriver.ts";
import {
  evaluateDriverAssistantBusyFromRows,
  isDriverAssistantBusy,
} from "./driverBusyGate.ts";
import type { AuthenticateDriver, DriverAuthResult } from "./driverAuth.ts";
import { readInstallationId } from "./driverAuth.ts";

const DRIVER_TRIP_SELECT =
  "id, status, booking_type, trip_type, is_scheduled, scheduled_status, dispatch_mode, scheduled_at, scheduled_broadcast_at, scheduled_convert_at, driver_id, confirmed_driver_id";

function isActiveDriverAccount(row: {
  deleted_at?: string | null;
  status?: string | null;
} | null): boolean {
  if (!row) return false;
  if (row.deleted_at) return false;
  const status = String(row.status ?? "active").trim().toLowerCase();
  return status === "active" || status === "";
}

export function createDriverAuthenticator(admin: SupabaseClient): AuthenticateDriver {
  return async function authenticateDriver(args): Promise<DriverAuthResult> {
    const jwt = args.jwt?.trim() ?? "";
    if (!jwt) return { ok: false, reason: "unauthorized" };

    const installationId = readInstallationId(args.installationId);
    if (!installationId) return { ok: false, reason: "unauthorized" };

    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    const authUserId = userData?.user?.id ?? null;
    if (userError || !authUserId) return { ok: false, reason: "unauthorized" };

    const resolved = await resolveAuthenticatedDriver(admin, authUserId, "DRIVER_ASSISTANT");
    if (!resolved.ok) return { ok: false, reason: "not_driver" };

    const driverId = resolved.driver.driver_id;
    const { data: driverRow } = await admin
      .from("drivers")
      .select("id, status, deleted_at, first_name")
      .eq("id", driverId)
      .maybeSingle();

    if (!isActiveDriverAccount(driverRow)) return { ok: false, reason: "not_driver" };

    const { data: profile } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", authUserId)
      .maybeSingle();
    const role = String(profile?.role ?? "driver").trim().toLowerCase();
    if (role && role !== "driver") return { ok: false, reason: "not_driver" };

    const { data: activeDevice } = await admin
      .from("driver_active_devices")
      .select("device_id")
      .eq("driver_id", driverId)
      .maybeSingle();
    const activeDeviceId =
      typeof activeDevice?.device_id === "string" ? activeDevice.device_id.trim() : "";
    if (!activeDeviceId || activeDeviceId !== installationId) {
      return { ok: false, reason: "device_replaced" };
    }

    const [{ data: offers }, { data: trips }] = await Promise.all([
      admin
        .from("ride_offers")
        .select("status, expires_at")
        .eq("driver_id", driverId)
        .in("status", ["pending", "countered"])
        .limit(20),
      admin
        .from("trips")
        .select(DRIVER_TRIP_SELECT)
        .or(`driver_id.eq.${driverId},confirmed_driver_id.eq.${driverId}`)
        .limit(30),
    ]);

    const busy = evaluateDriverAssistantBusyFromRows({
      offers: (offers ?? []) as Array<{ status?: string | null; expires_at?: string | null }>,
      trips: (trips ?? []) as Array<{
        status?: string | null;
        booking_type?: string | null;
        trip_type?: string | null;
        is_scheduled?: boolean | null;
        scheduled_status?: string | null;
        driver_id?: string | null;
        confirmed_driver_id?: string | null;
      }>,
    });
    if (isDriverAssistantBusy(busy)) return { ok: false, reason: "busy_workflow" };

    const firstName =
      typeof resolved.driver.first_name === "string" && resolved.driver.first_name.trim()
        ? resolved.driver.first_name.trim()
        : typeof driverRow?.first_name === "string" && driverRow.first_name.trim()
          ? driverRow.first_name.trim()
          : null;

    return {
      ok: true,
      identity: {
        authUserId,
        driverId,
        firstName,
        installationId,
      },
    };
  };
}
