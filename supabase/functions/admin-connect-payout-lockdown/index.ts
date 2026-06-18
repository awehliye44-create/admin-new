import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { isPayoutVerificationMode } from "../_shared/payoutExecutionGate.ts";
import {
  applyManualConnectPayoutSchedule,
  insertConnectPayoutAuditRow,
  listInFlightConnectPayouts,
  readConnectPayoutSnapshot,
} from "../_shared/connectPayoutLockdown.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function verifyAdmin(supabase: ReturnType<typeof createClient>, authHeader: string | null) {
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data: roleData } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();
  return roleData ? user : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const user = await verifyAdmin(supabase, req.headers.get("Authorization"));
    if (!user) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!stripeSecretKey) {
      return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY missing" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const verificationMode = isPayoutVerificationMode(body as Record<string, unknown>);
    const dryRun = verificationMode || body.dry_run === true;
    const confirmLockdown = body.confirm_lockdown === true;
    const regionId = body.region_id as string | undefined;
    const driverId = body.driver_id as string | undefined;

    if (!dryRun && !confirmLockdown) {
      return new Response(JSON.stringify({
        error: "confirm_lockdown is required to apply manual schedule, or use dry_run / verification_mode",
        error_code: "CONNECT_LOCKDOWN_CONFIRMATION_REQUIRED",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let driverQuery = supabase
      .from("drivers")
      .select("id, driver_code, first_name, last_name, stripe_account_id, region_id")
      .not("stripe_account_id", "is", null);

    if (driverId) driverQuery = driverQuery.eq("id", driverId);
    if (regionId) driverQuery = driverQuery.eq("region_id", regionId);

    const { data: drivers, error: driversError } = await driverQuery;
    if (driversError) throw driversError;

    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
    const platformAccount = await stripe.accounts.retrieve();
    const results: Array<Record<string, unknown>> = [];

    for (const driver of drivers ?? []) {
      const acct = driver.stripe_account_id as string;
      if (acct === platformAccount.id) {
        results.push({
          driver_id: driver.id,
          driver_code: driver.driver_code,
          skipped: true,
          reason: "Stripe account matches platform account — not a Connect account",
        });
        continue;
      }

      const before = await readConnectPayoutSnapshot(stripe, acct);
      const inFlight = await listInFlightConnectPayouts(stripe, acct);
      const inFlightIds = inFlight.map((p) => p.payout_id);

      let after = before;
      let applied = false;
      let errorMessage: string | null = null;

      if (before.automatic_payouts_enabled && !dryRun) {
        try {
          after = await applyManualConnectPayoutSchedule(stripe, acct);
          applied = true;
        } catch (e) {
          errorMessage = (e as Error).message;
        }
      } else if (before.automatic_payouts_enabled && dryRun) {
        after = {
          ...before,
          interval: "manual",
          automatic_payouts_enabled: false,
        };
      }

      await insertConnectPayoutAuditRow(supabase, {
        driver_id: driver.id,
        stripe_account_id: acct,
        action: dryRun ? "LOCKDOWN_DRY_RUN" : (applied ? "LOCKDOWN_APPLIED" : "LOCKDOWN_SKIPPED_ALREADY_MANUAL"),
        before_interval: before.interval,
        before_delay_days: before.delay_days,
        after_interval: after.interval,
        after_delay_days: after.delay_days,
        in_flight_payout_ids: inFlight,
        connect_available_pence: before.available_pence,
        connect_pending_pence: before.pending_pence,
        performed_by: user.id,
        dry_run: dryRun,
        error_message: errorMessage,
      });

      results.push({
        driver_id: driver.id,
        driver_code: driver.driver_code,
        driver_name: `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim(),
        stripe_account_id: acct,
        before,
        after,
        in_flight_payouts: inFlight,
        would_change: before.automatic_payouts_enabled,
        applied,
        dry_run: dryRun,
        error: errorMessage,
      });
    }

    const automaticRemaining = results.filter((r) => {
      const afterRow = r.after as { automatic_payouts_enabled?: boolean } | undefined;
      return afterRow?.automatic_payouts_enabled === true;
    });

    return new Response(JSON.stringify({
      success: errorMessageCount(results) === 0,
      phase: "3D.3",
      dry_run: dryRun,
      verification_mode: verificationMode,
      confirm_lockdown: confirmLockdown,
      drivers_processed: results.length,
      automatic_remaining_count: dryRun
        ? results.filter((r) => r.would_change === true).length
        : automaticRemaining.length,
      all_manual: dryRun
        ? results.every((r) => !r.would_change || r.skipped)
        : automaticRemaining.length === 0,
      results,
      message: dryRun
        ? "Dry run — no Stripe schedule changes applied"
        : "Connect payout lockdown applied where automatic was enabled",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-connect-payout-lockdown]", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function errorMessageCount(results: Array<Record<string, unknown>>): number {
  return results.filter((r) => r.error).length;
}
