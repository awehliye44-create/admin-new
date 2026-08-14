/**
 * Lock: Company Balance live /accounts via fixed-IP relay for Driver Withdraw.
 *
 * A–J coverage (source + SSOT unit):
 * A/B/C relay path + GBP source selection wiring
 * D insufficient source balance still blocks
 * E/F relay auth/network fail closed (no silent direct fallback)
 * G stale / non-AVAILABLE fail closed
 * H admin-submit shares same resolver
 * I withdraw probe path is read-only (no /pay)
 * J zero Stripe
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  listCompanyBalanceAccounts,
  normalizeRelayAccountsBody,
} from "./companyBalanceResolveSSOT.ts";
import { evaluateSourceAccountGate, SUBMISSION_ERROR } from "../../../shared/driverPayoutSubmissionSSOT.ts";

const RESOLVE = new URL("./companyBalanceResolveSSOT.ts", import.meta.url);
const WITHDRAW = new URL("../driver-withdraw/index.ts", import.meta.url);
const ADMIN = new URL("../admin-submit-driver-payout-payment/index.ts", import.meta.url);
const RELAY = new URL("./revolutBusinessRelayClient.ts", import.meta.url);

Deno.test("A/B. relay accounts body normalizes array and {accounts} shapes", () => {
  const asArray = normalizeRelayAccountsBody([
    { id: "4fb5a28b-3797-e242-0040-62910ba9f9d4", currency: "GBP", balance: 19.64, state: "active" },
  ]);
  assertEquals(asArray.length, 1);
  assertEquals(asArray[0].id, "4fb5a28b-3797-e242-0040-62910ba9f9d4");
  assertEquals(asArray[0].currency, "GBP");

  const wrapped = normalizeRelayAccountsBody({
    accounts: [{ id: "abc", currency: "GBP", balance: 10 }],
  });
  assertEquals(wrapped.length, 1);
  assertEquals(wrapped[0].id, "abc");

  assertEquals(normalizeRelayAccountsBody({}).length, 0);
  assertEquals(normalizeRelayAccountsBody(null).length, 0);
});

Deno.test("A/C. company balance resolve prefers relayRevolutAccounts when configured", async () => {
  const src = await Deno.readTextFile(RESOLVE);
  assertStringIncludes(src, "listCompanyBalanceAccounts");
  assertStringIncludes(src, "relayRevolutAccounts");
  assertStringIncludes(src, "isRevolutBusinessRelayConfigured");
  assertStringIncludes(src, "Never silently fall back");
  const liveIdx = src.indexOf("const accounts = await");
  const liveCall = src.slice(liveIdx, liveIdx + 120);
  assertStringIncludes(liveCall, "listCompanyBalanceAccounts(businessToken)");
  assertEquals(liveCall.includes('listRevolutAccounts("live"'), false);
  // Persist still present for AVAILABLE path
  assertStringIncludes(src, "persistSourceBalanceSnapshot");
  assertStringIncludes(src, 'status_code: "AVAILABLE"');
});

Deno.test("D. insufficient source balance still returns INSUFFICIENT_SOURCE_BALANCE", () => {
  const gate = evaluateSourceAccountGate({
    source_account_id: "4fb5a28b-3797-e242-0040-62910ba9f9d4",
    currency: "GBP",
    available_pence: 1964,
    amount_pence: 5000,
    account_active: true,
  });
  assertEquals(gate.ok, false);
  if (!gate.ok) {
    assertEquals(gate.code, SUBMISSION_ERROR.INSUFFICIENT_SOURCE_BALANCE);
  }

  const ok = evaluateSourceAccountGate({
    source_account_id: "4fb5a28b-3797-e242-0040-62910ba9f9d4",
    currency: "GBP",
    available_pence: 1964,
    amount_pence: 803,
    account_active: true,
  });
  assertEquals(ok.ok, true);
});

Deno.test("E/F. relay configured path must not silently fall back to direct fetch", async () => {
  const src = await Deno.readTextFile(RESOLVE);
  // Inside relay branch: throw on !res.ok, then return normalize — no listRevolutAccounts call
  const fnStart = src.indexOf("export async function listCompanyBalanceAccounts");
  const fnBody = src.slice(fnStart, fnStart + 1200);
  assertStringIncludes(fnBody, "if (isRevolutBusinessRelayConfigured())");
  assertStringIncludes(fnBody, "throw { message, status: res.status, body }");
  // Direct fetch only after the relay branch (else path)
  const elseIdx = fnBody.lastIndexOf("return listRevolutAccounts");
  assertEquals(elseIdx > fnBody.indexOf("isRevolutBusinessRelayConfigured"), true);
});

Deno.test("G. non-AVAILABLE / null available still fail closed at amount gate", () => {
  const stale = evaluateSourceAccountGate({
    source_account_id: "4fb5a28b-3797-e242-0040-62910ba9f9d4",
    currency: "GBP",
    available_pence: null,
    amount_pence: 803,
  });
  assertEquals(stale.ok, false);
  if (!stale.ok) {
    assertEquals(stale.code, SUBMISSION_ERROR.SOURCE_BALANCE_UNAVAILABLE);
  }
});

Deno.test("H. weekly/admin submit still uses same Company Balance SSOT", async () => {
  const a = await Deno.readTextFile(ADMIN);
  assertStringIncludes(a, "resolveLiveCompanyBalanceSnapshot");
  assertStringIncludes(a, 'currency: "GBP"');
  assertStringIncludes(a, "refresh: true");
  // Admin retains nested company_balance_status observability
  assertStringIncludes(a, "company_balance_status");
});

Deno.test("I. driver-withdraw probe is read-only (no /pay) and preserves company_balance_status", async () => {
  const src = await Deno.readTextFile(WITHDRAW);
  assertStringIncludes(src, "probe_company_balance");
  assertStringIncludes(src, "resolveLiveCompanyBalanceSnapshot");
  assertStringIncludes(src, "company_balance_status");
  // Probe must declare no pay
  const probeIdx = src.indexOf("probe_company_balance === true");
  const probeWin = src.slice(probeIdx, probeIdx + 1200);
  assertStringIncludes(probeWin, "revolut_pay_called: false");
  assertEquals(probeWin.includes("relayApprovedDriverPayoutPayment"), false);
  assertEquals(probeWin.includes("claim_driver_payout_submission"), false);
});

Deno.test("J. driver-withdraw Stripe runtime remains zero", async () => {
  const src = await Deno.readTextFile(WITHDRAW);
  assertEquals(src.includes("STRIPE_SECRET_KEY"), false);
  assertEquals(/new\s+Stripe\b/.test(src), false);
  assertEquals(src.includes("api.stripe.com"), false);
});

Deno.test("relayRevolutAccounts helper contract remains production GET /v1/revolut/accounts", async () => {
  const src = await Deno.readTextFile(RELAY);
  assertStringIncludes(src, "export async function relayRevolutAccounts");
  assertStringIncludes(src, 'path = "/v1/revolut/accounts"');
  assertStringIncludes(src, "x-revolut-access-token");
});

// Keep import live so Deno typechecks the export surface used by Edge.
Deno.test("listCompanyBalanceAccounts is exported for Edge/probe reuse", () => {
  assertEquals(typeof listCompanyBalanceAccounts, "function");
});
