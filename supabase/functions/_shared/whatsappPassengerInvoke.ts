/**
 * Mint a short-lived passenger session and call an existing customer Edge
 * Function. Does not replace that function's ownership or money rules.
 *
 * Guest Web / WhatsApp cancel + modify go through the same cancel-trip /
 * request-trip-modification paths as the native Customer app (#57 authority).
 * Guest Realtime reuses the same mint so RLS passenger policies apply —
 * never open anon SELECT on trip_driver_live_location.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { whatsAppWaIdToE164 } from "./whatsappGuestBookingSSOT.ts";

export type MintPassengerAccessResult =
  | {
    ok: true;
    userId: string;
    accessToken: string;
    expiresAtIso: string | null;
  }
  | {
    ok: false;
    status: number;
    error: string;
    detail?: string;
  };

/**
 * Mint a short-lived Auth access token for the trip passenger.
 * Used by guest-trip-action (cancel/modify) and guest-trip-realtime-session.
 */
export async function mintTripPassengerAccessToken(
  service: ReturnType<typeof createClient>,
  passengerId: string,
): Promise<MintPassengerAccessResult> {
  const { data: customer } = await service
    .from("customers")
    .select("user_id, phone")
    .eq("id", passengerId)
    .limit(1)
    .maybeSingle();
  const userId = typeof customer?.user_id === "string" ? customer.user_id : "";
  if (!userId) {
    return {
      ok: false,
      status: 403,
      error: "This trip has no passenger account to authorise.",
    };
  }

  const { data: authLookup, error: authErr } = await service.auth.admin.getUserById(userId);
  if (authErr || !authLookup?.user) {
    return {
      ok: false,
      status: 403,
      error: "This trip cannot be changed from the tracking link.",
    };
  }

  let email = authLookup.user.email?.trim() ?? "";
  const authPhone = authLookup.user.phone?.trim() ?? "";
  const customerPhone = typeof customer?.phone === "string" ? customer.phone.trim() : "";

  // Phone-only WhatsApp guests may lack email. Attach a stable synthetic email
  // so magic-link minting works without changing payment / ownership rules.
  if (!email) {
    const e164 = whatsAppWaIdToE164(authPhone || customerPhone);
    if (!e164) {
      return {
        ok: false,
        status: 403,
        error: "This trip cannot be changed from the tracking link.",
      };
    }
    const synthetic = `wa-guest-${e164.replace(/\D/g, "")}@users.onecab.local`;
    const { error: updateErr } = await service.auth.admin.updateUserById(userId, {
      email: synthetic,
      email_confirm: true,
    });
    if (updateErr) {
      return { ok: false, status: 503, error: "Couldn't authorise this trip change." };
    }
    email = synthetic;
  }

  const { data: link, error: linkErr } = await service.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    return {
      ok: false,
      status: 503,
      error: "Couldn't authorise this trip change.",
      detail: typeof linkErr?.message === "string" ? linkErr.message : undefined,
    };
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data: otp, error: otpErr } = await anon.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });
  const accessToken = otp.session?.access_token;
  if (otpErr || !accessToken) {
    return { ok: false, status: 503, error: "Couldn't authorise this trip change." };
  }

  const expiresAt = otp.session?.expires_at;
  const expiresAtIso = typeof expiresAt === "number"
    ? new Date(expiresAt * 1000).toISOString()
    : null;

  return { ok: true, userId, accessToken, expiresAtIso };
}

export async function invokeAsTripPassenger(
  service: ReturnType<typeof createClient>,
  passengerId: string,
  functionName: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const minted = await mintTripPassengerAccessToken(service, passengerId);
  if (!minted.ok) {
    return {
      status: minted.status,
      json: {
        error: minted.error,
        ...(minted.detail ? { detail: minted.detail } : {}),
      },
    };
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const res = await fetch(`${url}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${minted.accessToken}`,
      apikey: anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, json };
}
