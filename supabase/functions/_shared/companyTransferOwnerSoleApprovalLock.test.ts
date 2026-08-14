/**
 * Lock: Owner sole-approval for COMPANY_OUTGOING — no /pay on approve.
 * Run: deno test --allow-read supabase/functions/_shared/companyTransferOwnerSoleApprovalLock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const edgePath = new URL("../admin-company-outgoing-transfer/index.ts", import.meta.url);
const ssotPath = new URL("./companyTransferSoleAdminApprovalSSOT.ts", import.meta.url);
const panelPath = new URL(
  "../../../src/components/finance/PayoutLedgerCompanyTransfersPanel.tsx",
  import.meta.url,
);

Deno.test("I/J/K: approve path records SOLE_OWNER_APPROVAL and never calls /pay", async () => {
  const edge = await Deno.readTextFile(edgePath);
  assertStringIncludes(edge, "SOLE_OWNER_APPROVAL");
  assertStringIncludes(edge, "actor_is_owner");
  assertStringIncludes(edge, "loadActorIsOwner");
  assertStringIncludes(edge, "staff_profiles");
  assertStringIncludes(edge, "is_owner");
  // Approve response must keep provider execution separate
  assertStringIncludes(edge, "revolut_pay_called: false");
  assertStringIncludes(edge, "money_moved: false");
  // Must not invoke provider pay endpoints (comments may mention /pay)
  assertEquals(edge.includes('"/pay"'), false);
  assertEquals(edge.includes("/v1/pay"), false);
  assertEquals(/fetch\([^)]*\/pay/.test(edge), false);
  assertEquals(/revolutMerchantRequest[^\n]*pay/.test(edge), false);
  // Provider submission is a separate edge — not invoked from approve
  assertEquals(/functions\/v1\/admin-submit-company-transfer-payment/.test(edge), false);
});

Deno.test("SSOT Owner helpers present", async () => {
  const ssot = await Deno.readTextFile(ssotPath);
  assertStringIncludes(ssot, "SOLE_OWNER_CT_APPROVAL_V1");
  assertStringIncludes(ssot, "COMPANY_OUTGOING");
  assertStringIncludes(ssot, "canUiSoleApproveCompanyTransfer");
  assertStringIncludes(ssot, "actor_is_owner");
});

Deno.test("L: UI uses canUiSoleApproveCompanyTransfer + Owner copy", async () => {
  const panel = await Deno.readTextFile(panelPath);
  assertStringIncludes(panel, "canUiSoleApproveCompanyTransfer");
  assertStringIncludes(panel, "Approve as owner");
  assertStringIncludes(panel, "Owner sole approval");
  assertStringIncludes(panel, "isOwner");
  // Legacy hard CERTIFICATION+1p disable must not remain as sole gate
  assertEquals(
    panel.includes("!== 'CERTIFICATION'\n                || Number(soleAdminTransfer?.amount_pence) !== 1"),
    false,
  );
});
