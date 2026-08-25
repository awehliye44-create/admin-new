/**
 * Step 9.4A local read-only Revolut auth proof.
 * One Merchant GET order + one Business GET transaction. Zero DB writes.
 *
 * Usage (from admin-new):
 *   deno run --allow-net --allow-env --allow-read scripts/step94a-revolut-auth-readonly-audit.ts
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (never logged)
 *   STEP94A_AUDIT_DIR (optional)
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { getProviderSecrets } from "../supabase/functions/_shared/paymentProviders/secretManager.ts";
import { resolveRevolutMerchantContext } from "../supabase/functions/_shared/revolutMerchantContext.ts";
import { resolveRevolutBusinessAccessToken } from "../supabase/functions/_shared/revolutApi.ts";
import {
  evaluateBusinessTransferAuthMatch,
  evaluateMerchantOrderAuthMatch,
  liveBaseUrls,
  maskProviderId,
  retrieveMerchantOrderReadOnly,
  retrieveRevolutBusinessTransferReadOnly,
  classifyAuthFailure,
} from "../supabase/functions/_shared/revolutProviderAuthReadOnlyAuditSSOT.ts";

function mustEnv(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`missing_credential:${name}`);
  return v;
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") {
    if (/sk_|oa_prod_|Bearer\s/i.test(value)) return "[REDACTED]";
    if (value.length > 20 && /^[0-9a-f-]{20,}$/i.test(value)) return maskProviderId(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/authorization|secret|token|key|password/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out;
  }
  return value;
}

async function main() {
  const url = mustEnv("SUPABASE_URL");
  const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  const auditDir = Deno.env.get("STEP94A_AUDIT_DIR")?.trim() || ".audit-step94a-2026-08-21";

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const bases = liveBaseUrls("live");
  const merchantCandidate = JSON.parse(
    await Deno.readTextFile(`${auditDir}/merchant_candidates.json`),
  ).rows[0];
  const businessCandidate = JSON.parse(
    await Deno.readTextFile(`${auditDir}/business_candidates.json`),
  ).rows[0];

  // Resolve credentials via production resolvers (values never written to artifacts).
  let merchantOk = false;
  let businessOk = false;
  const merchantResult: Record<string, unknown> = {};
  const businessResult: Record<string, unknown> = {};

  try {
    const merchantCtx = await resolveRevolutMerchantContext(supabase, "live");
    if (!merchantCtx.secretKey) throw new Error("missing_credential:merchant_secret");
    // Prove resolver path used vault/env without logging key
    const secrets = await getProviderSecrets(supabase, "revolut", "live");
    merchantResult.resolver = {
      environment: merchantCtx.environment,
      secret_present: Boolean(secrets.secret_key || merchantCtx.secretKey),
      secret_prefix_class: (secrets.secret_key || merchantCtx.secretKey).startsWith("sk_")
        ? "sk_"
        : "other",
      base_url: bases.merchant,
      endpoint: `GET /orders/{id}`,
    };

    const order = await retrieveMerchantOrderReadOnly({
      environment: "live",
      secretKey: merchantCtx.secretKey,
      orderId: merchantCandidate.provider_order_id,
    });
    const match = evaluateMerchantOrderAuthMatch({
      localOrderId: merchantCandidate.provider_order_id,
      localCapturedPence: Number(merchantCandidate.captured_amount_pence),
      localCurrency: String(merchantCandidate.currency || "GBP"),
      order,
    });
    merchantOk = match.identity_match && match.amount_currency_match && match.provider_state_terminal;
    merchantResult.http_status = 200;
    merchantResult.match = match;
    merchantResult.safe_response = redactDeep({
      id: order.id,
      state: order.state,
      completed_amount: order.completed_amount,
      amount: order.amount,
      currency: order.currency,
    });
    merchantResult.local = {
      trip_code: merchantCandidate.trip_code,
      ps_id_masked: maskProviderId(merchantCandidate.ps_id),
      captured_amount_pence: merchantCandidate.captured_amount_pence,
      ten_n: merchantCandidate.ten_n,
      order_id_masked: maskProviderId(merchantCandidate.provider_order_id),
    };
  } catch (err) {
    merchantResult.failure = classifyAuthFailure(err);
  }

  try {
    const token = await resolveRevolutBusinessAccessToken(supabase, "live");
    if (!token) throw new Error("missing_credential:business_access_token");
    businessResult.resolver = {
      environment: "live",
      token_present: true,
      token_prefix_class: token.startsWith("oa_prod_") ? "oa_prod_" : "other",
      base_url: bases.business,
      endpoint: `GET /transaction/{id}`,
    };

    const transfer = await retrieveRevolutBusinessTransferReadOnly({
      environment: "live",
      accessToken: token,
      transferId: businessCandidate.provider_payment_id,
    });
    const localNetPence = Number(
      businessCandidate.net_payout_pence ?? businessCandidate.amount_pence,
    );
    const match = evaluateBusinessTransferAuthMatch({
      localPaymentId: businessCandidate.provider_payment_id,
      localAmountPence: localNetPence,
      localCurrency: String(businessCandidate.currency || "GBP"),
      localPaymentReference: businessCandidate.payment_reference ?? null,
      transfer,
    });
    businessOk =
      match.identity_match &&
      match.amount_currency_match &&
      match.provider_state_terminal &&
      match.reference_match;
    businessResult.http_status = 200;
    businessResult.match = match;
    businessResult.safe_response = redactDeep({
      id: transfer.id ?? transfer.transaction_id,
      state: transfer.state,
      amount: transfer.amount,
      currency: transfer.currency,
      reference: transfer.reference,
      type: transfer.type,
    });
    businessResult.local = {
      intent_id_masked: maskProviderId(businessCandidate.intent_id),
      payout_item_id_masked: maskProviderId(businessCandidate.payout_item_id),
      amount_pence: businessCandidate.amount_pence,
      net_payout_pence: localNetPence,
      fee_pence: businessCandidate.fee_pence ?? null,
      accounting: businessCandidate.accounting ?? null,
      payment_reference: businessCandidate.payment_reference,
      reservation_status: businessCandidate.reservation_status,
      provider_payment_id_masked: maskProviderId(businessCandidate.provider_payment_id),
    };
  } catch (err) {
    businessResult.failure = classifyAuthFailure(err);
  }

  const out = {
    merchant: merchantResult,
    business: businessResult,
    MERCHANT_API_AUTH_HEALTHY: merchantOk,
    BUSINESS_API_AUTH_HEALTHY: businessOk,
    PAYMENT_PROVIDER_AUTH_HEALTHY: merchantOk && businessOk,
    PROVIDER_MUTATION: "ZERO",
    note: "No Authorization headers or raw secrets included.",
  };

  await Deno.writeTextFile(
    `${auditDir}/provider_auth_calls.json`,
    JSON.stringify(out, null, 2),
  );
  console.log(JSON.stringify({
    MERCHANT_API_AUTH_HEALTHY: merchantOk,
    BUSINESS_API_AUTH_HEALTHY: businessOk,
    PAYMENT_PROVIDER_AUTH_HEALTHY: merchantOk && businessOk,
    merchant_match: merchantResult.match ?? merchantResult.failure ?? null,
    business_match: businessResult.match ?? businessResult.failure ?? null,
  }, null, 2));

  if (!merchantOk || !businessOk) {
    Deno.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
