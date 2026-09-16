import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Public endpoint (verify_jwt = false). Used during signup BEFORE auth user
// creation to enforce the global rule:
//   one phone + one email = one account only
//
// Checks across:
//   - auth.users (email + phone)
//   - public.customers (phone, deleted_at IS NULL)
//   - public.drivers   (email + phone, deleted_at IS NULL)
//
// Returns 200 with { available: boolean, conflict?: 'email' | 'phone', message?: string }.
// Never returns 4xx for "taken" — taken is a normal business response.

interface RequestBody {
  email?: string | null;
  phone?: string | null;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

function normalizePhone(raw: string | null | undefined): string {
  const cleaned = (raw ?? "").replace(/[\s\-()]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("00")) return `+${cleaned.slice(2)}`;
  return `+${cleaned.replace(/^\++/, "")}`;
}

async function emailExistsInAuth(email: string): Promise<boolean> {
  // IMPORTANT: Only return true for email-CONFIRMED users. Unverified / stale auth
  // users (email_confirmed_at IS NULL) must NOT block new signups — they are
  // orphan/abandoned accounts and will be reclaimed by reclaim_stale_onboarding_auth_user.
  const { data: users, error } = await admin.auth.admin.listUsers({ perPage: 100 });
  if (error || !users?.users) return false;
  return users.users.some(
    (u) =>
      (u.email ?? "").toLowerCase() === email &&
      u.email_confirmed_at != null &&
      u.deleted_at == null,
  );
}

async function phoneExistsInAuth(phone: string): Promise<boolean> {
  // Only return true for phone-CONFIRMED users (phone_confirmed_at IS NOT NULL).
  const { data: users, error } = await admin.auth.admin.listUsers({ perPage: 100 });
  if (error || !users?.users) return false;
  const normalizedInput = phone.replace(/^\+/, "");
  return users.users.some(
    (u) =>
      (u.phone ?? "").replace(/^\+/, "") === normalizedInput &&
      u.phone_confirmed_at != null &&
      u.deleted_at == null,
  );
}

async function emailExistsInDrivers(email: string): Promise<boolean> {
  const { data, error } = await admin
    .from("drivers")
    .select("id")
    .eq("email", email)
    .is("deleted_at", null)
    .limit(1);
  if (error) {
    console.warn("[check-identity] drivers email lookup failed", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

async function phoneExistsInProfiles(phone: string): Promise<boolean> {
  // Only match verified phones. Unverified placeholder phones must not block signup.
  const [{ data: drv, error: drvErr }, { data: cus, error: cusErr }] = await Promise.all([
    admin.from("drivers").select("id").eq("phone", phone).eq("phone_verified", true).is("deleted_at", null).limit(1),
    admin.from("customers").select("id").eq("phone", phone).eq("phone_verified", true).is("deleted_at", null).limit(1),
  ]);
  if (drvErr) console.warn("[check-identity] drivers phone lookup failed", drvErr.message);
  if (cusErr) console.warn("[check-identity] customers phone lookup failed", cusErr.message);
  return (drv?.length ?? 0) > 0 || (cus?.length ?? 0) > 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);

    if (!email && !phone) {
      return new Response(
        JSON.stringify({ error: "email or phone is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // EMAIL — check first because email is the typical primary identifier
    if (email) {
      const [authHit, drvHit] = await Promise.all([
        emailExistsInAuth(email),
        emailExistsInDrivers(email),
      ]);
      if (authHit || drvHit) {
        return new Response(
          JSON.stringify({
            available: false,
            conflict: "email",
            message: "This email address already exists. Please sign in instead.",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // PHONE
    if (phone) {
      const [authHit, profileHit] = await Promise.all([
        phoneExistsInAuth(phone),
        phoneExistsInProfiles(phone),
      ]);
      if (authHit || profileHit) {
        return new Response(
          JSON.stringify({
            available: false,
            conflict: "phone",
            message: "This phone number already exists. Please sign in instead.",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    return new Response(
      JSON.stringify({ available: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[check-identity] error:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});