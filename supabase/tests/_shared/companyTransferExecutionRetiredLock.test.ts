/**
 * Lock: company transfers are paid manually in Revolut Business. ONECAB never
 * submits, polls or finalises them. Owner decision 2026-10-14.
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RETIRED_FUNCTIONS = [
  "admin-submit-company-transfer-payment",
  "admin-sync-company-transfer-provider-status",
  "admin-finalize-company-transfer-completion",
];

const functionsRoot = new URL("../../functions/", import.meta.url);
const panelPath = new URL("../../../src/components/finance/PayoutLedgerCompanyTransfersPanel.tsx", import.meta.url);
const ledgerSsotPath = new URL("../../functions/_shared/adminPayoutLedgerSSOT.ts", import.meta.url);
const relayClientPath = new URL("../../functions/_shared/revolutBusinessRelayClient.ts", import.meta.url);

function exists(url: URL): boolean {
  try {
    Deno.statSync(url);
    return true;
  } catch {
    return false;
  }
}

Deno.test("retired company transfer execution functions do not exist", () => {
  for (const fn of RETIRED_FUNCTIONS) {
    assertEquals(exists(new URL(`${fn}/`, functionsRoot)), false, fn);
  }
});

Deno.test("no code invokes a retired company transfer function", () => {
  const sources = [Deno.readTextFileSync(panelPath), Deno.readTextFileSync(ledgerSsotPath)];
  for (const src of sources) {
    for (const fn of RETIRED_FUNCTIONS) assertEquals(src.includes(fn), false, fn);
    for (const name of [
      "ADMIN_SUBMIT_COMPANY_TRANSFER_FN",
      "ADMIN_SYNC_COMPANY_TRANSFER_STATUS_FN",
      "ADMIN_FINALIZE_COMPANY_TRANSFER_FN",
    ]) {
      assertEquals(src.includes(name), false, name);
    }
  }
});

Deno.test("relay client has no company transfer payment path", () => {
  const relay = Deno.readTextFileSync(relayClientPath);
  assert(!/company[-_ ]?transfer/i.test(relay), "relay client must not carry a company transfer route");
});

Deno.test("admin panel tells staff to pay company transfers manually", () => {
  const panel = Deno.readTextFileSync(panelPath);
  assertStringIncludes(panel, "Pay manually in Revolut Business");
  assertEquals(panel.includes("Submit to Revolut provider"), false);
  assertEquals(/action:\s*'execute'/.test(panel), false);
});
