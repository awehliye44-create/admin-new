/**
 * Customer identity helpers for Edge functions.
 * Approval only via Admin decide RPC — never trust client verified:true.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export type CustomerIdentityMode = "off" | "optional" | "mandatory";

export type CustomerIdentitySettings = {
  service_area_id: string;
  mode: CustomerIdentityMode;
  provider: string;
  provider_workflow_id: string | null;
  maximum_attempts: number;
  session_expiry_minutes: number;
};

export function getServiceSupabase(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("supabase_unconfigured");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function veriffApiKey(): string | null {
  return (
    Deno.env.get("VERIFF_API_KEY")?.trim() ||
    Deno.env.get("VERIFF_API_TOKEN")?.trim() ||
    null
  );
}

export function veriffSharedSecret(): string | null {
  return (
    Deno.env.get("VERIFF_SHARED_SECRET")?.trim() ||
    Deno.env.get("VERIFF_WEBHOOK_SECRET")?.trim() ||
    Deno.env.get("VERIFF_API_SECRET")?.trim() ||
    null
  );
}

export function veriffBaseUrl(): string {
  return (
    Deno.env.get("VERIFF_API_BASE_URL")?.trim() ||
    "https://stationapi.veriff.com"
  );
}

/** HMAC-SHA256 hex digest of payload with Veriff shared secret. */
export async function veriffHmacHex(
  payload: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function timingSafeEqualHex(
  a: string,
  b: string,
): Promise<boolean> {
  const aa = a.toLowerCase().trim();
  const bb = b.toLowerCase().trim();
  if (aa.length !== bb.length || aa.length === 0) return false;
  const enc = new TextEncoder();
  const ba = enc.encode(aa);
  const bbArr = enc.encode(bb);
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bbArr[i]!;
  return diff === 0;
}

export async function loadCustomerIdentitySettings(
  supabase: SupabaseClient,
  serviceAreaId: string,
): Promise<CustomerIdentitySettings | null> {
  const { data, error } = await supabase
    .from("service_area_customer_identity_settings")
    .select(
      "service_area_id, mode, provider, provider_workflow_id, maximum_attempts, session_expiry_minutes",
    )
    .eq("service_area_id", serviceAreaId)
    .maybeSingle();
  if (error || !data) return null;
  return data as CustomerIdentitySettings;
}

export async function assertCustomerIdentityBookAllowed(
  supabase: SupabaseClient,
  userId: string,
  serviceAreaId: string,
): Promise<
  | { ok: true }
  | {
      ok: false;
      code: "CUSTOMER_IDENTITY_VERIFICATION_REQUIRED";
      message: string;
    }
> {
  const settings = await loadCustomerIdentitySettings(supabase, serviceAreaId);
  if (!settings || settings.mode !== "mandatory") {
    return { ok: true };
  }

  const { data: customer, error } = await supabase
    .from("customers")
    .select("id, identity_verified_at")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !customer) {
    return {
      ok: false,
      code: "CUSTOMER_IDENTITY_VERIFICATION_REQUIRED",
      message:
        "Identity verification is required in this area before you can book.",
    };
  }

  if (customer.identity_verified_at) {
    return { ok: true };
  }

  return {
    ok: false,
    code: "CUSTOMER_IDENTITY_VERIFICATION_REQUIRED",
    message:
      "Verify your identity in Account before booking in this service area.",
  };
}

export type VeriffSessionCreateResult =
  | {
      ok: true;
      sessionId: string;
      sessionUrl: string;
      raw: Record<string, unknown>;
    }
  | { ok: false; code: string; message: string };

export async function createVeriffSession(input: {
  firstName: string;
  lastName: string;
  vendorData: string;
  callbackUrl?: string | null;
}): Promise<VeriffSessionCreateResult> {
  const apiKey = veriffApiKey();
  const secret = veriffSharedSecret();
  if (!apiKey || !secret) {
    return {
      ok: false,
      code: "IDENTITY_REFERENCE_UNAVAILABLE",
      message: "Identity verification is temporarily unavailable.",
    };
  }

  const bodyObj = {
    verification: {
      callback: input.callbackUrl || undefined,
      person: {
        firstName: input.firstName || undefined,
        lastName: input.lastName || undefined,
      },
      vendorData: input.vendorData,
      timestamp: new Date().toISOString(),
    },
  };
  const body = JSON.stringify(bodyObj);
  const signature = await veriffHmacHex(body, secret);
  const url = `${veriffBaseUrl().replace(/\/$/, "")}/v1/sessions`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AUTH-CLIENT": apiKey,
        "X-HMAC-SIGNATURE": signature,
      },
      body,
    });
  } catch (e) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: e instanceof Error ? e.message : "veriff_network_error",
    };
  }

  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    console.warn("[customer-identity] veriff session create failed", {
      status: resp.status,
      body: json,
    });
    return {
      ok: false,
      code: "IDENTITY_REFERENCE_UNAVAILABLE",
      message: "Could not start identity verification. Try again later.",
    };
  }

  const verification = (json.verification ?? json) as Record<string, unknown>;
  const sessionId =
    (typeof verification.id === "string" && verification.id) ||
    (typeof json.id === "string" && json.id) ||
    null;
  const sessionUrl =
    (typeof verification.url === "string" && verification.url) ||
    (typeof verification.sessionUrl === "string" && verification.sessionUrl) ||
    (typeof json.url === "string" && json.url) ||
    null;

  if (!sessionId || !sessionUrl) {
    return {
      ok: false,
      code: "IDENTITY_REFERENCE_UNAVAILABLE",
      message: "Identity provider returned an incomplete session.",
    };
  }

  return { ok: true, sessionId, sessionUrl, raw: json };
}

export function mapVeriffDecisionStatus(
  raw: string | null | undefined,
): "approved" | "declined" | "resubmission_requested" | "expired" | "processing" {
  const s = (raw ?? "").toLowerCase().trim();
  if (s === "approved" || s === "success") return "approved";
  if (s === "declined" || s === "rejected") return "declined";
  if (s === "resubmission_requested" || s === "resubmission") {
    return "resubmission_requested";
  }
  if (s === "expired" || s === "abandoned") return "expired";
  return "processing";
}

export function extractVeriffPersonNames(payload: Record<string, unknown>): {
  firstName: string | null;
  lastName: string | null;
} {
  const verification = (payload.verification ?? payload) as Record<
    string,
    unknown
  >;
  const person = (verification.person ?? payload.person ?? {}) as Record<
    string,
    unknown
  >;
  const first =
    typeof person.firstName === "string"
      ? person.firstName.trim()
      : typeof person.first_name === "string"
      ? person.first_name.trim()
      : null;
  const last =
    typeof person.lastName === "string"
      ? person.lastName.trim()
      : typeof person.last_name === "string"
      ? person.last_name.trim()
      : null;
  return {
    firstName: first && first.length >= 1 ? first : null,
    lastName: last && last.length >= 1 ? last : null,
  };
}

/**
 * Prefer an enabled SA (optional/mandatory) when the preferred/last-trip SA is off,
 * so pilots can enable Milton Keynes without forcing every historical trip SA on.
 */
export async function resolveCustomerIdentityServiceAreaId(
  supabase: SupabaseClient,
  customerId: string,
  preferredServiceAreaId: string | null,
): Promise<string | null> {
  const candidates: string[] = [];
  if (preferredServiceAreaId) candidates.push(preferredServiceAreaId);

  const { data: lastTrip } = await supabase
    .from("trips")
    .select("service_area_id")
    .eq("passenger_id", customerId)
    .not("service_area_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (
    lastTrip?.service_area_id &&
    !candidates.includes(lastTrip.service_area_id)
  ) {
    candidates.push(lastTrip.service_area_id);
  }

  for (const saId of candidates) {
    const settings = await loadCustomerIdentitySettings(supabase, saId);
    if (settings && settings.mode !== "off") return saId;
  }

  const { data: anyEnabled } = await supabase
    .from("service_area_customer_identity_settings")
    .select("service_area_id")
    .in("mode", ["optional", "mandatory"])
    .limit(1)
    .maybeSingle();

  return (
    anyEnabled?.service_area_id ??
    preferredServiceAreaId ??
    lastTrip?.service_area_id ??
    null
  );
}
