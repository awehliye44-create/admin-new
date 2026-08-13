// TEMP ops — P0 incident hold release for MK-260810-001 / 002 only.
// Uses existing cancelRevolutOrder. Does not capture. Does not delete evidence.
// Remove after incident cleanup is confirmed.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  cancelRevolutOrder,
  retrieveRevolutOrder,
  getRevolutMerchantConfig,
} from "../_shared/revolutOrders.ts";
import { corsHeaders, jsonResponse } from "../_shared/adminPaymentGate.ts";
import { stampReleaseTrigger } from "../_shared/paymentHoldGuard.ts";

const ALLOWED_SESSION_IDS = new Set([
  "1a72627b-4fe7-4f05-9cfb-bc52153f9703", // MK-260810-001
  "167a567e-3c6b-47f0-8943-457b0e12c748", // MK-260810-002
]);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    function bearerRole(token: string): string | null {
      try {
        const parts = token.split(".");
        if (parts.length < 2) return null;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
        return typeof payload?.role === "string" ? payload.role : null;
      } catch {
        return null;
      }
    }

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const auth = req.headers.get("Authorization") ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const internal = Deno.env.get("ONECAB_INTERNAL_FINALIZE_SECRET") ?? "";
    const providedInternal = req.headers.get("x-onecab-internal-secret") ?? "";
    const role = bearer ? bearerRole(bearer) : null;
    const ok =
      (serviceKey && bearer === serviceKey) ||
      role === "service_role" ||
      (internal && providedInternal === internal);
    if (!ok) {
      return jsonResponse({ error: "Forbidden", role }, 403);
    }

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: sessions, error } = await sb
      .from("payment_sessions")
      .select(
        "id, trip_id, provider_order_id, provider_state, status, authorised_amount_pence, metadata, captured_at, released_at",
      )
      .in("id", [...ALLOWED_SESSION_IDS]);
    if (error) return jsonResponse({ error: error.message }, 500);

    const { secretKey, environment } = getRevolutMerchantConfig();
    const results: Record<string, unknown>[] = [];

    for (const s of sessions ?? []) {
      const orderId = s.provider_order_id;
      if (!orderId) {
        results.push({ session_id: s.id, ok: false, error: "missing_provider_order_id" });
        continue;
      }
      if (s.captured_at) {
        results.push({ session_id: s.id, ok: false, error: "already_captured_skip" });
        continue;
      }

      let beforeState = String(s.provider_state ?? "").toUpperCase();
      try {
        const orderBefore = await retrieveRevolutOrder(environment, secretKey, orderId);
        beforeState = String(orderBefore.state ?? beforeState).toUpperCase();
      } catch (e) {
        results.push({
          session_id: s.id,
          order_id: orderId,
          ok: false,
          error: `retrieve_failed:${(e as Error).message}`,
        });
        continue;
      }

      if (s.released_at) {
        // Re-verify provider — do not trust a prior optimistic stamp.
        if (["CANCELLED", "CANCELED", "FAILED", "EXPIRED"].includes(beforeState)) {
          results.push({
            session_id: s.id,
            order_id: orderId,
            ok: true,
            idempotent: true,
            provider_state: beforeState,
          });
          continue;
        }
        // Still open — fall through and attempt cancel again.
      }

      // Provider already cancelled — sync DB only (no invent).
      if (["CANCELLED", "CANCELED", "FAILED", "EXPIRED"].includes(beforeState)) {
        const nowIso = new Date().toISOString();
        await sb
          .from("payment_sessions")
          .update({
            provider_state: beforeState,
            status: "payment_orphaned",
            hold_release_state: "released",
            released_at: nowIso,
            updated_at: nowIso,
            metadata: {
              ...((s.metadata && typeof s.metadata === "object") ? s.metadata : {}),
              never_capture: true,
              orphan_reason: "P0_DUPLICATE_TRIP_INCIDENT_CLEANUP",
              release_trigger: "provider_already_cancelled",
              released_by: "ops-p0-release-duplicate-holds",
              provider_state_synced: beforeState,
            },
          })
          .eq("id", s.id);
        results.push({
          session_id: s.id,
          order_id: orderId,
          ok: true,
          synced_only: true,
          provider_state: beforeState,
        });
        continue;
      }

      if (!["PENDING", "PROCESSING", "AUTHORISED"].includes(beforeState)) {
        results.push({
          session_id: s.id,
          order_id: orderId,
          ok: false,
          error: `not_cancellable:${beforeState}`,
          provider_state: beforeState,
        });
        continue;
      }

      if (s.id) {
        await stampReleaseTrigger(sb, s.id, "admin_abandon_recovery", {
          incident: "p0_duplicate_trip_2026_08_10",
          trip_codes: ["MK-260810-001", "MK-260810-002"],
        });
      }

      let cancelledState: string | null = null;
      try {
        const cancelled = await cancelRevolutOrder(environment, secretKey, orderId);
        cancelledState = String(cancelled.state ?? "").toUpperCase() || null;
      } catch (e) {
        results.push({
          session_id: s.id,
          order_id: orderId,
          ok: false,
          error: `cancel_failed:${(e as Error).message}`,
          provider_state_before: beforeState,
        });
        continue;
      }

      // Confirm with a fresh retrieve — never stamp released on stale AUTHORISED.
      let verifiedState = cancelledState;
      try {
        const orderAfter = await retrieveRevolutOrder(environment, secretKey, orderId);
        verifiedState = String(orderAfter.state ?? cancelledState ?? "").toUpperCase();
      } catch {
        /* keep cancelledState */
      }

      if (!["CANCELLED", "CANCELED", "FAILED", "EXPIRED"].includes(String(verifiedState ?? ""))) {
        results.push({
          session_id: s.id,
          order_id: orderId,
          ok: false,
          error: `cancel_not_confirmed:${verifiedState}`,
          provider_state_before: beforeState,
          provider_state_after: verifiedState,
        });
        continue;
      }

      const nowIso = new Date().toISOString();
      await sb
        .from("payment_sessions")
        .update({
          provider_state: verifiedState,
          status: "payment_orphaned",
          hold_release_state: "released",
          released_at: nowIso,
          updated_at: nowIso,
          metadata: {
            ...((s.metadata && typeof s.metadata === "object") ? s.metadata : {}),
            never_capture: true,
            orphan_reason: "P0_DUPLICATE_TRIP_INCIDENT_CLEANUP",
            release_trigger: "admin_abandon_recovery",
            released_by: "ops-p0-release-duplicate-holds",
            released_at: nowIso,
            provider_state_before_release: beforeState,
            provider_state_after_release: verifiedState,
          },
        })
        .eq("id", s.id);

      if (s.trip_id) {
        await sb
          .from("trips")
          .update({
            payment_status: "cancelled",
            updated_at: nowIso,
          })
          .eq("id", s.trip_id);
      }

      results.push({
        session_id: s.id,
        order_id: orderId,
        ok: true,
        provider_state_before: beforeState,
        provider_state_after: verifiedState,
        released_pence: s.authorised_amount_pence,
      });
    }

    return jsonResponse({ success: true, results });
  } catch (e) {
    console.error("[ops-p0-release-duplicate-holds]", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
