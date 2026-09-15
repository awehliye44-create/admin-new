/**
 * Corporate schedule overlap check (organisation / passenger scoped).
 * Client preview is informational; create-corporate-book must re-check atomically.
 * Does NOT call postgres check_schedule_overlap (driver-centric, EXECUTE-locked).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import {
  findCorporateScheduleOverlap,
  type CorporateOverlapTrip,
} from "../_shared/corporateScheduleOverlapSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authClient = createClient(supabaseUrl, anon, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await authClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const corporateAccountId = String(body.corporate_account_id ?? "").trim();
    const scheduledAt = String(body.scheduled_at ?? "").trim();
    const durationMinutes = Math.max(1, Number(body.estimated_duration_minutes ?? 30));
    const passengerId = body.passenger_id ? String(body.passenger_id) : null;
    const excludeTripId = body.exclude_trip_id ? String(body.exclude_trip_id) : null;

    if (!corporateAccountId || !scheduledAt) {
      return new Response(
        JSON.stringify({ error: "corporate_account_id and scheduled_at are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!Number.isFinite(Date.parse(scheduledAt))) {
      return new Response(JSON.stringify({ error: "scheduled_at must be a valid ISO timestamp" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // Membership gate — same link table as Corporate portal
    const { data: membership } = await admin
      .from("corporate_user_accounts")
      .select("role")
      .eq("user_id", user.id)
      .eq("corporate_account_id", corporateAccountId)
      .maybeSingle();

    if (!membership) {
      return new Response(JSON.stringify({ error: "Forbidden", code: "CORPORATE_ACCESS_DENIED" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let query = admin
      .from("trips")
      .select("id, scheduled_at, estimated_duration_minutes, status, passenger_id, corporate_account_id")
      .eq("corporate_account_id", corporateAccountId)
      .not("scheduled_at", "is", null);

    if (passengerId) {
      query = query.eq("passenger_id", passengerId);
    }

    const { data: rows, error } = await query.limit(200);
    if (error) {
      console.error("corporate overlap query failed", error);
      return new Response(JSON.stringify({ error: "Unable to check schedule overlap" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = findCorporateScheduleOverlap({
      candidateScheduledAt: scheduledAt,
      candidateDurationMinutes: durationMinutes,
      existing: (rows ?? []) as CorporateOverlapTrip[],
      excludeTripId,
    });

    if (result.has_conflict) {
      return new Response(
        JSON.stringify({ ...result, code: "SCHEDULE_OVERLAP" }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("check-corporate-schedule-overlap", e);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
