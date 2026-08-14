/**
 * Register (or reconcile) the ONECAB Revolut Merchant webhook via Create Webhook API.
 * Webhooks are API-managed — not configured in the Revolut Business dashboard.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { upsertProviderSecret } from "../_shared/paymentProviders/secretManager.ts";
import { resolveRevolutMerchantContext } from "../_shared/revolutMerchantContext.ts";
import {
  ensureOnecabRevolutWebhook,
  ONECAB_REVOLUT_WEBHOOK_EVENTS,
  resolveOnecabRevolutWebhookUrl,
} from "../_shared/revolutWebhooks.ts";
import type { ProviderEnvironment } from "../_shared/paymentProviders/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function isServiceRoleToken(token: string): boolean {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (serviceRoleKey && token === serviceRoleKey) return true;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return false;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

async function requireAdminOrServiceRole(
  req: Request,
  supabase: ReturnType<typeof createClient>,
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }

  const token = authHeader.replace("Bearer ", "");
  if (isServiceRoleToken(token)) {
    return { ok: true, userId: "service_role" };
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }

  const { data: roleData } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();

  if (!roleData) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }

  return { ok: true, userId: user.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const auth = await requireAdminOrServiceRole(req, supabase);
  if (!auth.ok) return auth.response;

  try {
    const body = await req.json().catch(() => ({}));
    const environment = (body.environment === "test" ? "test" : "live") as ProviderEnvironment;
    const webhookUrl = typeof body.url === "string" && body.url.trim()
      ? body.url.trim()
      : resolveOnecabRevolutWebhookUrl(supabaseUrl);

    const merchant = await resolveRevolutMerchantContext(supabase, environment);
    const existingWebhookId =
      Deno.env.get("REVOLUT_WEBHOOK_ID")?.trim()
      || (typeof body.existing_webhook_id === "string" ? body.existing_webhook_id.trim() : null)
      || null;

    const result = await ensureOnecabRevolutWebhook({
      environment,
      secretKey: merchant.secretKey,
      webhookUrl,
      existingWebhookId,
    });

    const signingSecret = result.webhook.signing_secret?.trim()
      || Deno.env.get("REVOLUT_WEBHOOK_SECRET")?.trim()
      || merchant.webhookSecret
      || null;

    if (!signingSecret) {
      return new Response(JSON.stringify({
        error: "Revolut did not return signing_secret and none is configured in vault/env.",
        webhook_id: result.webhook.id,
        webhook_url: result.webhook.url,
        hint: "Delete and recreate the webhook via Merchant API, or paste signing_secret from initial create response.",
      }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (result.webhook.signing_secret?.trim()) {
      await upsertProviderSecret(supabase, {
        provider: "revolut",
        environment,
        secretName: "webhook_secret",
        secretValue: signingSecret,
        updatedBy: auth.userId,
      });
    }

    await supabase
      .from("payment_provider_configs")
      .update({
        webhook_endpoint_url: webhookUrl,
        last_connection_test_status: "connected",
        updated_at: new Date().toISOString(),
      })
      .eq("provider", "revolut")
      .eq("environment", environment)
      .then(({ error }) => {
        if (error) console.warn("[admin-register-revolut-webhook] config update skipped:", error.message);
      });

    console.log("[admin-register-revolut-webhook]", {
      webhook_id: result.webhook.id,
      created: result.created,
      updated: result.updated,
      url: webhookUrl,
      events: ONECAB_REVOLUT_WEBHOOK_EVENTS.length,
    });

    return new Response(JSON.stringify({
      success: true,
      webhook_id: result.webhook.id,
      webhook_url: result.webhook.url,
      events: result.webhook.events,
      created: result.created,
      updated: result.updated,
      signing_secret_configured: true,
      signing_secret_masked: `${signingSecret.slice(0, 6)}••••${signingSecret.slice(-4)}`,
      message: result.created
        ? "Revolut webhook created via Merchant API. signing_secret stored in payment_provider_vault."
        : result.updated
          ? "Revolut webhook updated to ONECAB URL and event list."
          : "Revolut webhook already registered with correct URL and events.",
      next_steps: [
        "Set Supabase secret REVOLUT_WEBHOOK_SECRET to the vault signing_secret (or rely on vault SSOT).",
        "Set REVOLUT_WEBHOOK_ID for idempotent reconcile on future runs.",
      ],
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[admin-register-revolut-webhook]", error);
    const errObj = error as { message?: string; status?: number; body?: unknown };
    const message = errObj?.message
      ?? (error instanceof Error ? error.message : String(error));
    return new Response(JSON.stringify({
      error: message,
      http_status: errObj?.status ?? null,
      revolut_body: errObj?.body ?? null,
    }), {
      status: errObj?.status && errObj.status >= 400 && errObj.status < 600
        ? errObj.status
        : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
