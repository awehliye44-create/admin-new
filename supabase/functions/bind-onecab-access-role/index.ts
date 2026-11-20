/**
 * #57 — Bind JWT app_metadata.onecab_access for dual-role RLS isolation.
 * Customer app binds "customer"; Driver app binds "driver".
 * Does not change phone, Auth user, or profile rows.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders, errorResponse, successResponse } from "../_shared/security.ts";
import { requireUser } from "../_shared/internalAuth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authed = await requireUser(req);
  if (authed instanceof Response) return authed;
  const userId = authed.userId;

  let body: { role?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const roleRaw = typeof body.role === "string" ? body.role.trim().toLowerCase() : "";
  if (roleRaw !== "customer" && roleRaw !== "driver") {
    return errorResponse("role must be customer or driver", 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  if (roleRaw === "customer") {
    const { data: customer } = await admin
      .from("customers")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!customer?.id) {
      return errorResponse("No Customer profile for this Auth user", 403);
    }
  } else {
    const { data: driver } = await admin
      .from("drivers")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!driver?.id) {
      return errorResponse("No Driver profile for this Auth user", 403);
    }
  }

  const { data: userData, error: getErr } = await admin.auth.admin.getUserById(userId);
  if (getErr || !userData?.user) {
    return errorResponse(getErr?.message ?? "User lookup failed", 500);
  }

  const prevMeta =
    userData.user.app_metadata && typeof userData.user.app_metadata === "object"
      ? { ...userData.user.app_metadata }
      : {};

  if (prevMeta.onecab_access === roleRaw) {
    return successResponse({
      ok: true,
      role: roleRaw,
      refreshed: false,
    });
  }

  const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...prevMeta,
      onecab_access: roleRaw,
    },
  });
  if (updErr) {
    return errorResponse(updErr.message, 500);
  }

  return successResponse({
    ok: true,
    role: roleRaw,
    refreshed: true,
  });
});
