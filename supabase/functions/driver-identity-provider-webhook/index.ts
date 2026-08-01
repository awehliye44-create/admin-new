/**
 * driver-identity-provider-webhook
 * Veriff decision/event webhook. Signature required. Idempotent.
 * Event webhooks never approve.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { applyIdentityDecision } from "../_shared/driverIdentity/applyDecision.ts";
import { createDriverIdentityProvider } from "../_shared/driverIdentity/veriffProvider.ts";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json(503, { error: "CONFIG_MISSING" });
  }

  const rawBody = await req.text();
  const provider = createDriverIdentityProvider("veriff");

  let verified;
  try {
    verified = await provider.verifyWebhook({
      rawBody,
      headers: req.headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "verify_failed";
    console.error("[driver-identity-provider-webhook]", message);
    return json(401, { error: "INVALID_SIGNATURE" });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Idempotency insert first.
  const { error: idemErr } = await admin
    .from("driver_identity_provider_webhook_events")
    .insert({
      provider: "veriff",
      provider_event_id: verified.providerEventId,
      provider_session_id: verified.providerSessionId,
      event_kind: verified.kind,
      metadata: { progress: verified.progressStatus ?? null },
    });

  if (idemErr) {
    // Unique violation → already processed
    if (String(idemErr.code) === "23505" || /duplicate/i.test(idemErr.message)) {
      return json(200, { ok: true, duplicate: true });
    }
    console.error("[driver-identity-provider-webhook] idempotency", idemErr.message);
    return json(500, { error: "IDEMPOTENCY_FAILED" });
  }

  const { data: verification } = await admin
    .from("driver_identity_verifications")
    .select("id, driver_id, status, provider_session_id")
    .eq("provider_session_id", verified.providerSessionId)
    .maybeSingle();

  if (!verification) {
    return json(404, { error: "UNKNOWN_SESSION" });
  }

  await admin
    .from("driver_identity_provider_webhook_events")
    .update({ verification_id: verification.id })
    .eq("provider", "veriff")
    .eq("provider_event_id", verified.providerEventId);

  if (verified.kind === "progress") {
    const next =
      verified.progressStatus === "submitted" ? "processing" : "started";
    if (!["approved", "rejected", "expired"].includes(verification.status)) {
      await admin
        .from("driver_identity_verifications")
        .update({
          status: next,
          submitted_at:
            next === "processing" ? new Date().toISOString() : undefined,
          updated_at: new Date().toISOString(),
        })
        .eq("id", verification.id)
        .eq("driver_id", verification.driver_id)
        .not("status", "in", "(approved,rejected,expired)");
    }
    // Never approve on progress.
    return json(200, { ok: true, kind: "progress", status: next });
  }

  if (!verified.decision) {
    return json(200, { ok: true, kind: "ignored" });
  }

  // Ownership: session must match row.
  if (verification.provider_session_id !== verified.providerSessionId) {
    return json(409, { error: "SESSION_MISMATCH" });
  }

  const result = await applyIdentityDecision({
    supabase: admin,
    verificationId: verification.id,
    driverId: verification.driver_id,
    fromStatus: verification.status,
    decision: verified.decision.decision,
    livenessResult: verified.decision.livenessResult,
    faceMatchResult: verified.decision.faceMatchResult,
    imageQualityResult: verified.decision.imageQualityResult,
    failureCode: verified.decision.failureCode,
    decidedAt: verified.decision.decidedAt,
    source: "webhook",
  });

  return json(200, {
    ok: true,
    kind: "decision",
    applied: result.applied,
    status: result.status,
  });
});
