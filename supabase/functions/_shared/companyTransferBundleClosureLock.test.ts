/**
 * Step 9.4D1.1 — company-transfer consumer bundle closure boot locks.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertDirectTransferAllowed,
  resolveCompanyTransferApprovalsRequiredForCategory,
} from "./companyOutgoingTransferApprovalSSOT.ts";
import {
  classifyGetAuthFailurePolicy,
  classifyPayAuthFailurePolicy,
} from "./revolutBusinessOAuthContinuitySSOT.ts";

const RELAY = new URL("./revolutBusinessRelayClient.ts", import.meta.url);
const APPROVAL = new URL("./companyOutgoingTransferApprovalSSOT.ts", import.meta.url);

Deno.test("relay exports company-transfer payment + status (not driver-payout aliases)", async () => {
  const src = await Deno.readTextFile(RELAY);
  assertStringIncludes(src, "export async function relayApprovedCompanyTransferPayment");
  assertStringIncludes(src, "export async function relayCompanyTransferPaymentStatus");
  assertStringIncludes(src, "/v1/revolut/company-transfer-payment");
  assertStringIncludes(src, "/v1/revolut/company-transfer-payment-status");
  // Isolation from driver payout ledger path
  assertEquals(
    /relayApprovedCompanyTransferPayment[\s\S]*?driver-payout-payment/.test(
      src.slice(src.indexOf("relayApprovedCompanyTransferPayment")),
    ),
    false,
  );
  assertEquals(src.includes("oa_prod_"), false);
  assertEquals(src.includes("BEGIN PRIVATE KEY"), false);
});

Deno.test("approval SSOT exports category + direct-transfer gates", async () => {
  const src = await Deno.readTextFile(APPROVAL);
  assertStringIncludes(src, "export function resolveCompanyTransferApprovalsRequiredForCategory");
  assertStringIncludes(src, "export function assertDirectTransferAllowed");
  const high = resolveCompanyTransferApprovalsRequiredForCategory(1_000, "DIRECTOR_DIVIDEND");
  assertEquals(high.approvals_required >= 1, true);
  const directOk = assertDirectTransferAllowed({
    execution_mode: "DIRECT_TRANSFER",
    category: "SUPPLIER",
    amount_pence: 5_000,
  });
  assertEquals(directOk.ok, true);
  const directBlocked = assertDirectTransferAllowed({
    execution_mode: "DIRECT_TRANSFER",
    category: "DIRECTOR_LOAN",
    amount_pence: 1_000,
  });
  assertEquals(directBlocked.ok, false);
});

Deno.test("company-transfer entrypoints import restored relay/approval symbols", async () => {
  const submit = await Deno.readTextFile(
    new URL("../admin-submit-company-transfer-payment/index.ts", import.meta.url),
  );
  const sync = await Deno.readTextFile(
    new URL("../admin-sync-company-transfer-provider-status/index.ts", import.meta.url),
  );
  const finalize = await Deno.readTextFile(
    new URL("../admin-finalize-company-transfer-completion/index.ts", import.meta.url),
  );
  const outgoing = await Deno.readTextFile(
    new URL("../admin-company-outgoing-transfer/index.ts", import.meta.url),
  );
  assertStringIncludes(submit, "relayApprovedCompanyTransferPayment");
  assertStringIncludes(submit, "ensureFreshRevolutBusinessAccessToken");
  assertStringIncludes(sync, "relayCompanyTransferPaymentStatus");
  assertStringIncludes(finalize, "relayCompanyTransferPaymentStatus");
  assertStringIncludes(outgoing, "resolveCompanyTransferApprovalsRequiredForCategory");
  assertStringIncludes(outgoing, "assertDirectTransferAllowed");
  // Auth gate present on outgoing (admin/staff)
  assertStringIncludes(outgoing, "requireAdminOrStaff");
  // No blind /pay replay after refresh
  assertEquals(submit.includes("refresh_then_replay_pay"), false);
  assertEquals(submit.includes('"/pay"'), false);
});

Deno.test("pay replay forbidden; GET may retry once after refresh", () => {
  const pay = classifyPayAuthFailurePolicy({
    revolut_pay_called: true,
    http_status: 401,
    provider_payment_id: null,
  });
  assertEquals(pay.retry_pay, false);
  assertEquals(pay.refresh_then_replay_pay, false);
  assertEquals(pay.abort_claim, true);
  const getDesired = classifyGetAuthFailurePolicy(false);
  assertEquals(getDesired.get_retry_max, 1);
  assertEquals(getDesired.refresh_count_max, 1);
});

Deno.test("refresh failure before payment → no provider payment contract in submit", async () => {
  const submit = await Deno.readTextFile(
    new URL("../admin-submit-company-transfer-payment/index.ts", import.meta.url),
  );
  // ensureFresh must precede relayApprovedCompanyTransferPayment
  const tokIdx = submit.indexOf("ensureFreshRevolutBusinessAccessToken");
  const payIdx = submit.indexOf("relayApprovedCompanyTransferPayment({");
  assertEquals(tokIdx >= 0 && payIdx > tokIdx, true);
  // On token failure, revolut_pay_called: false
  assertStringIncludes(submit, "ACCESS_TOKEN_REQUIRED");
  assertStringIncludes(submit, "revolut_pay_called: false");
});

Deno.test("status sync retrieves before finalize; never calls /pay", async () => {
  const sync = await Deno.readTextFile(
    new URL("../admin-sync-company-transfer-provider-status/index.ts", import.meta.url),
  );
  const finalize = await Deno.readTextFile(
    new URL("../admin-finalize-company-transfer-completion/index.ts", import.meta.url),
  );
  assertStringIncludes(sync, "relayCompanyTransferPaymentStatus");
  assertStringIncludes(sync, "never calls /pay");
  assertStringIncludes(finalize, "Never calls /pay");
  assertStringIncludes(finalize, "relayCompanyTransferPaymentStatus");
  assertEquals(finalize.includes("relayApprovedCompanyTransferPayment"), false);
});
