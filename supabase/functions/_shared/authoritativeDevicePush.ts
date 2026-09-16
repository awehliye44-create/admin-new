/**
 * Sole-active-device delivery resolution.
 * Senders must use these helpers — never fan out to all historical tokens.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type AuthoritativeToken = {
  token: string;
  platform: string;
  device_id: string;
};

/** Driver: active device → matching active push token only. */
export async function resolveDriverAuthoritativeToken(
  client: SupabaseClient,
  driverId: string,
): Promise<AuthoritativeToken | null> {
  const { data: active, error: activeErr } = await client
    .from("driver_active_devices")
    .select("device_id, platform")
    .eq("driver_id", driverId)
    .maybeSingle();

  if (activeErr || !active?.device_id) {
    return null;
  }

  const { data: row, error: tokenErr } = await client
    .from("push_tokens")
    .select("token, platform, device_id")
    .eq("driver_id", driverId)
    .eq("app_type", "driver")
    .eq("is_active", true)
    .eq("device_id", active.device_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (tokenErr || !row?.token) {
    return null;
  }

  return {
    token: row.token,
    platform: row.platform ?? active.platform ?? "android",
    device_id: row.device_id ?? active.device_id,
  };
}

/**
 * trips.passenger_id is customers.id. Push tokens and customer_active_devices
 * are keyed by auth.users.id. Resolve either shape to the auth user id.
 */
export async function resolveCustomerAuthUserId(
  client: SupabaseClient,
  passengerOrUserId: string,
): Promise<string> {
  const id = passengerOrUserId.trim();
  if (!id) return id;
  const { data: byUser } = await client
    .from("customers")
    .select("user_id")
    .eq("user_id", id)
    .maybeSingle();
  if (typeof byUser?.user_id === "string" && byUser.user_id) return byUser.user_id;
  const { data: byCustomer } = await client
    .from("customers")
    .select("user_id")
    .eq("id", id)
    .maybeSingle();
  return typeof byCustomer?.user_id === "string" && byCustomer.user_id
    ? byCustomer.user_id
    : id;
}

/**
 * Customer: active device must exist; only the latest token for that user is
 * selectable (claim/bind must have wiped siblings). No historical fan-out.
 * Prefer platform matching the active device when multiple rows exist transiently.
 */
export async function resolveCustomerAuthoritativeToken(
  client: SupabaseClient,
  userId: string,
): Promise<AuthoritativeToken | null> {
  const authUserId = await resolveCustomerAuthUserId(client, userId);
  const { data: active, error: activeErr } = await client
    .from("customer_active_devices")
    .select("device_id, platform")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (activeErr || !active?.device_id) {
    return null;
  }

  let query = client
    .from("customer_push_tokens")
    .select("token, platform")
    .eq("user_id", authUserId)
    .order("updated_at", { ascending: false })
    .limit(1);

  // Prefer token whose platform matches the claimed device when available.
  if (active.platform === "ios" || active.platform === "android") {
    const { data: matched } = await client
      .from("customer_push_tokens")
      .select("token, platform")
      .eq("user_id", authUserId)
      .eq("platform", active.platform)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (matched?.token) {
      return {
        token: matched.token,
        platform: matched.platform ?? active.platform,
        device_id: active.device_id,
      };
    }
  }

  const { data: row, error: tokenErr } = await query.maybeSingle();

  if (tokenErr || !row?.token) {
    return null;
  }

  return {
    token: row.token,
    platform: row.platform ?? active.platform ?? "android",
    device_id: active.device_id,
  };
}
