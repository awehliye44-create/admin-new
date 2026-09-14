/**
 * Mint a short-lived passenger session and call an existing customer Edge
 * Function. Does not replace that function's ownership or money rules.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";

export async function invokeAsTripPassenger(
  service: ReturnType<typeof createClient>,
  passengerId: string,
  functionName: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { data: customer } = await service
    .from("customers")
    .select("user_id")
    .eq("id", passengerId)
    .maybeSingle();
  const userId = typeof customer?.user_id === "string" ? customer.user_id : "";
  if (!userId) {
    return { status: 403, json: { error: "This trip has no passenger account to authorise." } };
  }

  const { data: authLookup, error: authErr } = await service.auth.admin.getUserById(userId);
  const email = authLookup?.user?.email?.trim() ?? "";
  if (authErr || !email) {
    return { status: 403, json: { error: "This trip cannot be changed from the tracking link." } };
  }

  const { data: link, error: linkErr } = await service.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    return { status: 503, json: { error: "Couldn't authorise this trip change." } };
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
