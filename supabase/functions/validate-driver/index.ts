import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  evaluateDriverAuthState,
  logDriverEligibilityBlocked,
} from "../_shared/driverEligibility.ts";
import { evaluateDriverDocumentState } from "../_shared/driverDocumentEligibility.ts";
import { nativeAppCorsHeaders as corsHeaders } from "../_shared/security.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ valid: false, reason: "no_session", message: "No authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ valid: false, reason: "invalid_session", message: "Session is invalid or expired" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    const eligibility = await evaluateDriverAuthState(serviceClient, user.id);

    const { data: driver } = await serviceClient
      .from("drivers")
      .select("id, first_name, last_name, phone, approval_status, driver_status, documents_approved, is_online, deleted_at, updated_at, email_verified, phone_verified")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const documentEligibility = driver?.id
      ? await evaluateDriverDocumentState(serviceClient, driver.id)
      : null;

    const documentPayload = documentEligibility
      ? {
        document_state: documentEligibility.document_state,
        missing_documents: documentEligibility.missing_documents,
        expired_documents: documentEligibility.expired_documents,
        rejected_documents: documentEligibility.rejected_documents,
        pending_documents: documentEligibility.pending_documents,
      }
      : {
        document_state: null,
        missing_documents: [],
        expired_documents: [],
        rejected_documents: [],
        pending_documents: [],
      };

    if (!eligibility.allowed || (documentEligibility && !documentEligibility.allowed)) {
      logDriverEligibilityBlocked("validate-driver", driver?.id ?? eligibility.driver_id, eligibility);
      const reason =
        documentEligibility?.document_state === "documents_expired"
          ? "documents_expired"
          : eligibility.state === "suspended" || eligibility.state === "rejected"
          ? "account_disabled"
          : eligibility.blocked_reasons.includes("DRIVER_NOT_APPROVED")
          || eligibility.blocked_reasons.includes("DOCUMENTS_PENDING_REVIEW")
          || eligibility.blocked_reasons.includes("DOCUMENTS_EXPIRED")
          ? "pending_approval"
          : "pending_verification";

      return new Response(
        JSON.stringify({
          valid: false,
          reason,
          message: documentEligibility?.message || eligibility.message,
          auth_state: eligibility.state,
          blocked_reasons: [
            ...eligibility.blocked_reasons,
            ...(documentEligibility?.blocked_reasons ?? []),
          ],
          email_verified: !eligibility.blocked_reasons.includes("EMAIL_UNVERIFIED"),
          phone_verified: !eligibility.blocked_reasons.includes("PHONE_UNVERIFIED"),
          ...documentPayload,
          driver,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!driver) {
      return new Response(
        JSON.stringify({
          valid: false,
          reason: "pending_verification",
          message: "Complete signup to create your driver profile.",
          auth_state: "documents_missing",
          blocked_reasons: ["DRIVER_PROFILE_MISSING"],
          email_verified: true,
          phone_verified: true,
          driver: null,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        valid: true,
        reason: "active",
        auth_state: eligibility.state,
        blocked_reasons: [],
        email_verified: true,
        phone_verified: true,
        ...documentPayload,
        driver: {
          id: driver.id,
          first_name: driver.first_name,
          last_name: driver.last_name,
          approval_status: driver.approval_status,
          driver_status: driver.driver_status,
          is_online: driver.is_online,
          documents_approved: driver.documents_approved,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("validate-driver error:", err);
    return new Response(
      JSON.stringify({ valid: false, reason: "server_error", message: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
