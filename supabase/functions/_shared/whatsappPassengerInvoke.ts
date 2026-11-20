/**
 * Mint a short-lived passenger session and call an existing customer Edge
 * Function. Does not replace that function's ownership or money rules.
 *
 * Guest Web / WhatsApp cancel + modify go through the same cancel-trip /
 * request-trip-modification paths as the native Customer app (#57 authority).
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { whatsAppWaIdToE164 } from "./whatsappGuestBookingSSOT.ts";

export async function invokeAsTripPassenger(
  service: ReturnType<typeof createClient>,
  passengerId: string,
  functionName: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { data: customer } = await service
    .from("customers")
    .select("user_id, phone")
    .eq("id", passengerId)
    .limit(1)
    .maybeSingle();
  const userId = typeof customer?.user_id === "string" ? customer.user_id : "";
  if (!userId) {
    return { status: 403, json: { error: "This trip has no passenger account to authorise." } };
  }

  const { data: authLookup, error: authErr } = await service.auth.admin.getUserById(userId);
  if (authErr || !authLookup?.user) {
    return { status: 403, json: { error: "This trip cannot be changed from the tracking link." } };
  }

  let email = authLookup.user.email?.trim() ?? "";
  const authPhone = authLookup.user.phone?.trim() ?? "";
  const customerPhone = typeof customer?.phone === "string" ? customer.phone.trim() : "";

  // Phone-only WhatsApp guests may lack email. Attach a stable synthetic email
  // so magic-link minting works without changing payment / ownership rules.
  if (!email) {
    const e164 = whatsAppWaIdToE164(authPhone || customerPhone);
    if (!e164) {
      return { status: 403, json: { error: "This trip cannot be changed from the tracking link." } };
    }
    const synthetic = `wa-guest-${e164.replace(/\D/g, "")}@users.onecab.local`;
    const { error: updateErr } = await service.auth.admin.updateUserById(userId, {
      email: synthetic,
      email_confirm: true,
    });
    if (updateErr) {
      return { status: 503, json: { error: "Couldn't authorise this trip change." } };
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
      status: 503,
      json: {
        error: "Couldn't authorise this trip change.",
        detail: typeof linkErr?.message === "string" ? linkErr.message : undefined,
      },
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
    return { status: 503, json: { error: "Couldn't authorise this trip change." } };
  }

  const res = await fetch(`${url}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, json };
}
