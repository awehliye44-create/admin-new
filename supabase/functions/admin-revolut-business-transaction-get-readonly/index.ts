/**
 * Step 9.4B — Temporary read-only Business transfer GET via fixed-egress relay.
 * DO_NOT_REDEPLOY_WITHOUT_EXPLICIT_CREDENTIAL_RECOVERY_APPROVAL
 * Never /pay. Never finalizes payouts. Never writes vault/wallet/payout rows.
 *
 * POST { provider_payment_id: string, expected_amount_pence?: number,
 *        expected_currency?: string, expected_reference?: string }
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  isRefreshOnlyRelayConfigured,
} from "../_shared/revolutBusinessRefreshOnlyRelay.ts";
import { readRefreshOnlyVaultTokens } from "../_shared/revolutBusinessTokenRefreshCore.ts";

function maskProviderId(id: string | null | undefined): string | null {
  const s = String(id ?? "").trim();
  if (!s) return null;
  if (s.length <= 10) return `${s.slice(0, 2)}…${s.slice(-2)}`;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function businessAmountToPence(amount: unknown, currency: string): number | null {
  if (amount == null || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const cur = String(currency ?? "GBP").toUpperCase();
  if (["GBP", "EUR", "USD"].includes(cur)) return Math.round(n * 100);
  return Math.round(n * 100);
}

/** Direct Business GET /transaction/{id} from Edge (may fail IP whitelist). */
async function directTransactionGet(args: {
  accessToken: string;
  transferId: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const url =
    `https://b2b.revolut.com/api/1.0/transaction/${encodeURIComponent(args.transferId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      Accept: "application/json",
    },
  });
  const jsonBody = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, json: jsonBody };
}

function extractTransferFields(j: Record<string, unknown>, fallbackCurrency: string) {
  const id = String(j.provider_payment_id ?? j.id ?? "").trim();
  const state = String(j.provider_state ?? j.state ?? "").toLowerCase();
  const leg0 = Array.isArray(j.legs) && j.legs[0] && typeof j.legs[0] === "object"
    ? j.legs[0] as Record<string, unknown>
    : null;
  const currency = String(j.currency ?? leg0?.currency ?? fallbackCurrency ?? "GBP").toUpperCase();
  const amountRaw = j.amount ?? leg0?.amount ?? j.bill_amount ?? null;
  const amountPence = businessAmountToPence(amountRaw, currency);
  const reference = String(
    j.reference ?? j.payment_reference ?? j.transaction_reference ?? leg0?.reference ?? "",
  );
  return { id, state, currency, amountRaw, amountPence, reference };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function decodeJwtRole(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const parsed = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof parsed?.role === "string" ? parsed.role : null;
  } catch {
    return null;
  }
}

/** Relay-only status GET — duplicated path string to avoid importing pay helpers. */
async function relayTransactionStatus(args: {
  providerPaymentId: string;
  accessToken: string;
}): Promise<{
  status: number;
  error: string | null;
  json: Record<string, unknown>;
}> {
  const enabled = (Deno.env.get("REVOLUT_BUSINESS_RELAY_ENABLED") ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0" || enabled === "off") {
    return { status: 0, error: "relay_disabled", json: {} };
  }
  const base = (
    Deno.env.get("REVOLUT_BUSINESS_RELAY_URL") ??
    Deno.env.get("REVOLUT_BUSINESS_RELAY_BASE_URL") ??
    ""
  ).trim().replace(/\/$/, "");
  const secret = (Deno.env.get("REVOLUT_BUSINESS_RELAY_SHARED_SECRET") ?? "").trim();
  if (!base || secret.length < 32) {
    return { status: 0, error: "relay_not_configured", json: {} };
  }
  const path = "/v1/revolut/driver-payout-payment-status";
  const raw = JSON.stringify({ provider_payment_id: args.providerPaymentId });
  const ts = String(Date.now());
  const nonce = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const bodyHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const message = `POST\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const signature = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-onecab-timestamp": ts,
      "x-onecab-nonce": nonce,
      "x-onecab-signature": signature,
      "x-onecab-client-id": "supabase-edge",
      "idempotency-key": `status:${args.providerPaymentId}`,
      "x-revolut-access-token": args.accessToken,
    },
    body: raw,
  });
  const jsonBody = await res.json().catch(() => ({})) as Record<string, unknown>;
  const err = typeof jsonBody.error === "string"
    ? jsonBody.error
    : (typeof jsonBody.code === "string" ? jsonBody.code : null);
  return { status: res.status, error: err, json: jsonBody };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ success: false, error: "unauthorized" }, 401);
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return json({ success: false, error: "unauthorized" }, 401);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const role = decodeJwtRole(bearer);
  if (role !== "service_role") {
    const { data: { user }, error } = await supabase.auth.getUser(bearer);
    if (error || !user) return json({ success: false, error: "unauthorized" }, 401);
    const { data: roleRow } = await supabase
      .from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
    if (!roleRow) return json({ success: false, error: "forbidden" }, 403);
  }

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (/token|secret|key|assertion|password/i.test(k) && k !== "provider_payment_id") {
      return json({ success: false, error: "invalid_body" }, 400);
    }
  }
  const providerPaymentId = String(body.provider_payment_id ?? "").trim();
  if (!providerPaymentId) {
    return json({ success: false, error: "provider_payment_id_required" }, 400);
  }
  if (!isRefreshOnlyRelayConfigured()) {
    return json({ success: false, error: "relay_not_configured" }, 503);
  }

  const vault = await readRefreshOnlyVaultTokens(supabase);
  if (!vault.access_token) {
    return json({ success: false, error: "access_token_missing" }, 503);
  }

  const statusRes = await relayTransactionStatus({
    providerPaymentId,
    accessToken: vault.access_token,
  });
  if (statusRes.status < 200 || statusRes.status >= 300) {
    return json({
      success: false,
      error: "provider_status_failed",
      http_status: statusRes.status,
      provider_error: statusRes.error,
      revolut_pay_called: false,
      database_write: false,
    }, 502);
  }

  const relayFields = extractTransferFields(
    statusRes.json,
    String(body.expected_currency ?? "GBP"),
  );

  // Enrich amount/reference via direct GET when relay status DTO omits them.
  let source: "relay_status" | "edge_direct_get" = "relay_status";
  let fields = relayFields;
  let directStatus: number | null = null;
  if (fields.amountPence == null || !fields.reference) {
    const direct = await directTransactionGet({
      accessToken: vault.access_token,
      transferId: providerPaymentId,
    });
    directStatus = direct.status;
    if (direct.status === 200) {
      source = "edge_direct_get";
      fields = extractTransferFields(direct.json, String(body.expected_currency ?? "GBP"));
      if (!fields.id) fields.id = providerPaymentId;
      if (!fields.state) fields.state = relayFields.state;
    }
  }

  const id = fields.id || providerPaymentId;
  const state = fields.state || relayFields.state;
  const currency = fields.currency;
  const amountRaw = fields.amountRaw;
  const amountPence = fields.amountPence;
  const reference = fields.reference;
  const response_keys = Object.keys(statusRes.json).sort();

  const expectedAmount = body.expected_amount_pence != null
    ? Number(body.expected_amount_pence)
    : null;
  const expectedRef = body.expected_reference != null
    ? String(body.expected_reference)
    : null;

  const identity_match = id === providerPaymentId;
  const provider_state_terminal = ["completed", "paid"].includes(state);
  const amount_currency_match = expectedAmount != null
    && amountPence === expectedAmount
    && currency === String(body.expected_currency ?? "GBP").toUpperCase();
  const reference_match = Boolean(expectedRef)
    && (reference === expectedRef || reference.includes(expectedRef.slice(0, 24)));

  return json({
    success: true,
    http_status: statusRes.status,
    enrichment_source: source,
    direct_get_http_status: directStatus,
    revolut_pay_called: false,
    database_write: false,
    provider_mutation: "ZERO",
    match: {
      identity_match,
      provider_state_terminal,
      amount_currency_match,
      reference_match,
      provider_state: state,
      provider_amount_pence: amountPence,
      expected_amount_pence: expectedAmount,
      currency,
      reference_present: Boolean(reference),
    },
    safe_response: {
      id_masked: maskProviderId(id),
      state,
      amount: amountRaw ?? null,
      currency,
      reference: reference || null,
      response_keys,
    },
    BUSINESS_TRANSFER_OK:
      identity_match && provider_state_terminal && amount_currency_match && reference_match,
  });
});
