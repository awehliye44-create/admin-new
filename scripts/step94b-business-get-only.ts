
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveRevolutBusinessAccessToken } from "../supabase/functions/_shared/revolutApi.ts";
import {
  evaluateBusinessTransferAuthMatch,
  maskProviderId,
  retrieveRevolutBusinessTransferReadOnly,
} from "../supabase/functions/_shared/revolutProviderAuthReadOnlyAuditSSOT.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const auditDir = Deno.env.get("STEP94A_AUDIT_DIR")!;
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const cand = JSON.parse(await Deno.readTextFile(`${auditDir}/business_candidates.json`)).rows[0];
const token = await resolveRevolutBusinessAccessToken(supabase, "live");
if (!token) throw new Error("missing_credential:business_access_token");
const transfer = await retrieveRevolutBusinessTransferReadOnly({
  environment: "live",
  accessToken: token,
  transferId: cand.provider_payment_id,
});
const net = Number(cand.net_payout_pence ?? cand.amount_pence);
const match = evaluateBusinessTransferAuthMatch({
  localPaymentId: cand.provider_payment_id,
  localAmountPence: net,
  localCurrency: String(cand.currency || "GBP"),
  localPaymentReference: cand.payment_reference ?? null,
  transfer,
});
const out = {
  http_status: 200,
  match,
  safe_response: {
    id: maskProviderId(String(transfer.id ?? transfer.transaction_id ?? "")),
    state: transfer.state,
    amount: transfer.amount,
    currency: transfer.currency,
    reference: transfer.reference,
    type: transfer.type,
  },
  local: {
    net_payout_pence: net,
    amount_pence: cand.amount_pence,
    payment_reference: cand.payment_reference,
    reservation_status: cand.reservation_status,
    provider_payment_id_masked: maskProviderId(cand.provider_payment_id),
  },
  BUSINESS_API_AUTH_HEALTHY:
    match.identity_match && match.amount_currency_match && match.provider_state_terminal && match.reference_match,
};
await Deno.writeTextFile(`${auditDir}/business_transfer_get.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  BUSINESS_API_AUTH_HEALTHY: out.BUSINESS_API_AUTH_HEALTHY,
  match: out.match,
  safe_response: out.safe_response,
}, null, 2));
if (!out.BUSINESS_API_AUTH_HEALTHY) Deno.exit(2);
