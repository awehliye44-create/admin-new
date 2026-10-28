const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Public endpoint (verify_jwt = false). Used during signup before account creation.
//
// It intentionally never reveals whether an email or phone number is already
// registered (prevents account enumeration). It only validates input format.
// Duplicate identities are enforced server-side at account creation time.
//
// Returns 200 with { available: true, message } for any well-formed input.

interface RequestBody {
  email?: string | null;
  phone?: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9]{6,16}$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const body = (await req.json().catch(() => ({}))) as RequestBody;
  const email = (body.email ?? "").trim().toLowerCase();
  const phone = (body.phone ?? "").replace(/[\s\-()]/g, "");

  if (!email && !phone) {
    return json({ error: "email or phone is required", error_code: "VALIDATION_ERROR" }, 400);
  }
  if ((email && (email.length > 254 || !EMAIL_RE.test(email))) || (phone && !PHONE_RE.test(phone))) {
    return json({ error: "Invalid email or phone format", error_code: "VALIDATION_ERROR" }, 400);
  }

  return json({
    available: true,
    message: "If these details are already registered, you'll be asked to sign in when your account is created.",
  });
});
