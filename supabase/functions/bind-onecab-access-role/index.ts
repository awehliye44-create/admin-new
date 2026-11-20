/**
 * #57F/G — Bind THIS Auth session to customer|driver access role.
 * Stores role in onecab_auth_session_roles keyed by JWT session_id.
 * Does not mutate user-wide app_metadata (no last-app-wins race).
 * Does not change phone, Auth user, or profile rows.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders, errorResponse, successResponse } from "../_shared/security.ts";
import {
  normalizeOnecabAccessRole,
  resolveAuthSessionIdFromClaims,
} from "../_shared/sessionAccessRoleSSOT.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("Missing authorization header", 401);
  }
  const token = authHeader.replace("Bearer ", "");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const anon = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: claimsData, error: claimsErr } = await anon.auth.getClaims(token);
  if (claimsErr || !claimsData?.claims) {
    return errorResponse("Invalid token", 401);
  }
  const claims = claimsData.claims as Record<string, unknown>;
  const userId = typeof claims.sub === "string" ? claims.sub : null;
  if (!userId) {
    return errorResponse("Invalid token subject", 401);
  }
  const sessionId = resolveAuthSessionIdFromClaims(claims);
  if (!sessionId) {
    return errorResponse("Forbidden: missing Auth session_id", 403);
  }

  let body: { role?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const roleRaw = normalizeOnecabAccessRole(body.role);
  if (!roleRaw) {
    return errorResponse("role must be customer or driver", 400);
  }

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

  const { data: existing } = await admin
    .from("onecab_auth_session_roles")
    .select("access_role")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (existing?.access_role === roleRaw) {
    return successResponse({
      ok: true,
      role: roleRaw,
      session_id: sessionId,
      refreshed: false,
      scope: "session",
    });
  }

  const { error: upsertErr } = await admin.from("onecab_auth_session_roles").upsert(
    {
      session_id: sessionId,
      user_id: userId,
      access_role: roleRaw,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id" },
  );
  if (upsertErr) {
    return errorResponse(upsertErr.message, 500);
  }

  // Best-effort: strip legacy user-wide onecab_access so it cannot race sessions.
  try {
    const { data: userData } = await admin.auth.admin.getUserById(userId);
    const prevMeta =
      userData?.user?.app_metadata && typeof userData.user.app_metadata === "object"
        ? { ...userData.user.app_metadata }
        : {};
    if ("onecab_access" in prevMeta) {
      const nextMeta = { ...prevMeta };
      delete nextMeta.onecab_access;
      await admin.auth.admin.updateUserById(userId, { app_metadata: nextMeta });
    }
  } catch {
    // Non-fatal — session table is the SSOT.
  }

  return successResponse({
    ok: true,
    role: roleRaw,
    session_id: sessionId,
    refreshed: false,
    scope: "session",
  });
});
