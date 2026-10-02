/**
 * Customer submits ID + selfie paths after private Storage upload.
 * Admin decides via admin_decide_customer_identity RPC — never client-approved.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getServiceSupabase } from "../_shared/customerIdentityVeriff.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "customer-identity-documents";
const DOC_TYPES = ["driving_licence", "passport", "residence_permit"] as const;
type DocType = (typeof DOC_TYPES)[number];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function needsBack(doc: DocType): boolean {
  return doc === "driving_licence" || doc === "residence_permit";
}

function pathOwnedByVerification(
  path: string,
  customerId: string,
  verificationId: string,
): boolean {
  const prefix = `${customerId}/${verificationId}/`;
  if (!path.startsWith(prefix)) return false;
  if (path.includes("..") || path.includes("//")) return false;
  const rest = path.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const anon = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const {
      data: { user },
      error: userError,
    } = await anon.auth.getUser();
    if (userError || !user) {
      return json({ ok: false, code: "UNAUTHENTICATED" }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as {
      verification_id?: string;
      document_type?: string;
      id_front_path?: string;
      id_back_path?: string | null;
      selfie_path?: string;
    };

    const verificationId =
      typeof body.verification_id === "string" ? body.verification_id.trim() : "";
    const documentType = (
      typeof body.document_type === "string" ? body.document_type.trim() : ""
    ) as DocType;
    const frontPath =
      typeof body.id_front_path === "string" ? body.id_front_path.trim() : "";
    const backPath =
      typeof body.id_back_path === "string" && body.id_back_path.trim()
        ? body.id_back_path.trim()
        : null;
    const selfiePath =
      typeof body.selfie_path === "string" ? body.selfie_path.trim() : "";

    if (!verificationId || !DOC_TYPES.includes(documentType)) {
      return json({
        ok: false,
        code: "INVALID_INPUT",
        message: "Choose a valid ID type and try again.",
      }, 400);
    }
    if (!frontPath || !selfiePath) {
      return json({
        ok: false,
        code: "MISSING_IMAGES",
        message: "ID front and selfie photos are required.",
      }, 400);
    }
    if (needsBack(documentType) && !backPath) {
      return json({
        ok: false,
        code: "MISSING_IMAGES",
        message: "ID back photo is required for this document type.",
      }, 400);
    }

    const service = getServiceSupabase();
    const { data: customer } = await service
      .from("customers")
      .select("id, identity_verified_at")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!customer) {
      return json({ ok: false, code: "NO_PROFILE" }, 404);
    }
    if (customer.identity_verified_at) {
      return json({
        ok: false,
        code: "ALREADY_VERIFIED",
        message: "Your identity is already verified.",
      });
    }

    const { data: row } = await service
      .from("customer_identity_verifications")
      .select("id, customer_id, status, expires_at")
      .eq("id", verificationId)
      .eq("customer_id", customer.id)
      .maybeSingle();

    if (!row) {
      return json({ ok: false, code: "NOT_FOUND", message: "Verification not found." }, 404);
    }
    if (row.status === "submitted" || row.status === "processing") {
      return json({
        ok: true,
        code: "OK",
        verification_id: row.id,
        status: "submitted",
        app_state: "manual_review",
        already_submitted: true,
      });
    }
    if (row.status !== "started" && row.status !== "resubmission_requested") {
      return json({
        ok: false,
        code: "INVALID_STATUS",
        message: "This verification can no longer accept photos.",
        status: row.status,
      });
    }
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      await service
        .from("customer_identity_verifications")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      return json({
        ok: false,
        code: "EXPIRED",
        message: "This verification session expired. Start again.",
      });
    }

    const paths = [frontPath, selfiePath, ...(backPath ? [backPath] : [])];
    for (const p of paths) {
      if (!pathOwnedByVerification(p, customer.id, verificationId)) {
        return json({
          ok: false,
          code: "INVALID_PATH",
          message: "Upload paths are invalid for this verification.",
        }, 400);
      }
    }

    for (const p of paths) {
      const fileName = p.split("/").pop() ?? "";
      const { data: listed, error: listError } = await service.storage
        .from(BUCKET)
        .list(`${customer.id}/${verificationId}`, { limit: 50 });
      if (listError) {
        console.warn("[submit-customer-identity] list failed", listError);
        return json({
          ok: false,
          code: "UPLOAD_MISSING",
          message: "Could not confirm uploaded photos. Try again.",
        }, 400);
      }
      const found = (listed ?? []).some((f) => f.name === fileName);
      if (!found) {
        return json({
          ok: false,
          code: "UPLOAD_MISSING",
          message: "One or more photos are missing. Capture and upload again.",
        }, 400);
      }
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error: updateError } = await service
      .from("customer_identity_verifications")
      .update({
        document_type: documentType,
        id_front_path: frontPath,
        id_back_path: needsBack(documentType) ? backPath : null,
        selfie_path: selfiePath,
        status: "submitted",
        submitted_at: nowIso,
        provider: "manual",
        metadata: {
          capture: "in_app",
          submitted_via: "submit-customer-identity-verification",
        },
        updated_at: nowIso,
      })
      .eq("id", row.id)
      .select("id, status, submitted_at")
      .single();

    if (updateError || !updated) {
      console.warn("[submit-customer-identity] update failed", updateError);
      return json({
        ok: false,
        code: "SAVE_FAILED",
        message: "Could not submit verification.",
      }, 500);
    }

    return json({
      ok: true,
      code: "OK",
      verification_id: updated.id,
      status: updated.status,
      app_state: "manual_review",
      submitted_at: updated.submitted_at,
    });
  } catch (e) {
    console.error("[submit-customer-identity] unexpected", e);
    return json({
      ok: false,
      code: "INTERNAL",
      message: e instanceof Error ? e.message : "unexpected_error",
    }, 500);
  }
});
