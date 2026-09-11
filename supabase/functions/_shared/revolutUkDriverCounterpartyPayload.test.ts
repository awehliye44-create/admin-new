/**
 * A8B28F-B2R — UK company/personal Revolut payload + wiring locks (no provider I/O).
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { dirname, fromFileUrl, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  classifyCounterpartyCreateFailure,
  DRIVER_FACING_VERIFY_FAILED_NEUTRAL,
  DRIVER_FACING_VERIFY_FAILED_USER_INPUT,
  driverFacingMessageForOutcome,
  inferCounterpartyFailureSignals,
  PAYOUT_DESTINATION_OUTCOME,
  PROVIDER_LINK_FAILURE_CLASS,
} from "./payoutDestinationVerificationOutcomeSSOT.ts";
import {
  buildUkDriverRevolutCounterpartyBody,
  detectUkDriverCounterpartyKind,
} from "./revolutUkDriverCounterpartyPayload.ts";

const SHARED = dirname(fromFileUrl(import.meta.url));

Deno.test("ONECAB Limited → business body with company_name (not profile_type personal)", () => {
  assertEquals(detectUkDriverCounterpartyKind("ONECAB Limited"), "business");
  const body = buildUkDriverRevolutCounterpartyBody({
    accountHolderName: "ONECAB Limited",
    destinationIdentifier: "04000379313778",
  });
  assertEquals(body.company_name, "ONECAB Limited");
  assertEquals(body.account_no, "79313778");
  assertEquals(body.sort_code, "040003");
  assertEquals(body.bank_country, "GB");
  assertEquals(body.currency, "GBP");
  assertEquals("profile_type" in body, false);
  assertEquals("individual_name" in body, false);
  assertEquals("accounts" in body, false);
  assertEquals("name" in body, false);
});

Deno.test("Ltd / Limited / PLC / LLP detection → business", () => {
  for (const holder of [
    "Acme Ltd",
    "Acme Ltd.",
    "Acme LIMITED",
    "Widgets PLC",
    "Partners LLP",
  ]) {
    assertEquals(detectUkDriverCounterpartyKind(holder), "business", holder);
    const body = buildUkDriverRevolutCounterpartyBody({
      accountHolderName: holder,
      sortCode: "040003",
      accountNumber: "79313778",
    });
    assertEquals(typeof body.company_name, "string", holder);
    assertEquals("profile_type" in body, false, holder);
    assertEquals("individual_name" in body, false, holder);
  }
});

Deno.test("personal holder → individual_name flat UK body", () => {
  assertEquals(detectUkDriverCounterpartyKind("Jane Driver"), "personal");
  const body = buildUkDriverRevolutCounterpartyBody({
    accountHolderName: "Jane Driver",
    sortCode: "04-00-03",
    accountNumber: "79313778",
  });
  assertEquals(body.individual_name, { first_name: "Jane", last_name: "Driver" });
  assertEquals(body.account_no, "79313778");
  assertEquals(body.sort_code, "040003");
  assertEquals(body.bank_country, "GB");
  assertEquals(body.currency, "GBP");
  assertEquals("company_name" in body, false);
  assertEquals("profile_type" in body, false);
  assertEquals("accounts" in body, false);
});

Deno.test("403 IP whitelist still PROVIDER_CONFIGURATION_REQUIRED (not user typo)", () => {
  const signals = inferCounterpartyFailureSignals(
    "IP address is not whitelisted. Verify IP whitelist configuration in Revolut Business Portal.",
  );
  const cls = classifyCounterpartyCreateFailure({ http_status: 403, ...signals });
  assertEquals(cls, PROVIDER_LINK_FAILURE_CLASS.PROVIDER_CONFIGURATION_REQUIRED);
  assertEquals(cls === PROVIDER_LINK_FAILURE_CLASS.USER_INPUT_CORRECTION_REQUIRED, false);
  const msg = driverFacingMessageForOutcome(
    PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED,
    cls,
  );
  assertEquals(msg, DRIVER_FACING_VERIFY_FAILED_NEUTRAL);
  assertEquals(msg.includes("Check the details"), false);
  assertEquals(
    driverFacingMessageForOutcome(
      PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED,
      PROVIDER_LINK_FAILURE_CLASS.USER_INPUT_CORRECTION_REQUIRED,
    ),
    DRIVER_FACING_VERIFY_FAILED_USER_INPUT,
  );
});

Deno.test("createRevolutCounterparty wires UK builder; no nested personal accounts for uk_bank", async () => {
  const api = await Deno.readTextFile(join(SHARED, "revolutApi.ts"));
  assert(api.includes('from "./revolutUkDriverCounterpartyPayload.ts"'));
  assert(api.includes("buildUkDriverRevolutCounterpartyBody"));
  const ukStart = api.indexOf('else if (args.destinationType === "uk_bank_account")');
  assert(ukStart >= 0);
  const ukEnd = api.indexOf("} else {", ukStart);
  assert(ukEnd > ukStart);
  const ukBranch = api.slice(ukStart, ukEnd);
  assert(ukBranch.includes("buildUkDriverRevolutCounterpartyBody"));
  assert(!ukBranch.includes('profile_type'));
  assert(!ukBranch.includes("accounts:"));
});

Deno.test("handler still fail-closed on 409 + stores failure truth columns; no payouts_enabled writes", async () => {
  const handler = await Deno.readTextFile(join(SHARED, "updateDriverPayoutDestinationHandler.ts"));
  assert(handler.includes("provider_link_failure_class"));
  assert(handler.includes("provider_http_status"));
  assert(handler.includes("AUDIT_ACTION_LINK_BLOCKED"));
  assert(handler.includes("provider_link_blocked"));
  assert(!/payouts_enabled\s*:/.test(handler));
  assert(!/payout_operational_paused\s*:/.test(handler));
  assert(!/PROVIDER_VERIFIED[\s\S]{0,40}fabricat/i.test(handler));
});

Deno.test("payload module never logs secrets or raw identifiers", async () => {
  const mod = await Deno.readTextFile(join(SHARED, "revolutUkDriverCounterpartyPayload.ts"));
  const api = await Deno.readTextFile(join(SHARED, "revolutApi.ts"));
  const banned = ["sk_live_", "rk_live_", "console.error(", "console.warn(", "console.log("];
  for (const src of [mod, api]) {
    for (const token of banned) {
      assert(!src.includes(token), `forbidden token present: ${token}`);
    }
  }
  // createRevolutCounterparty must not console.* the destination identifier / holder.
  const fnStart = api.indexOf("export async function createRevolutCounterparty");
  const fnEnd = api.indexOf("\nexport async function executeRevolutPay", fnStart);
  const fn = api.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  assert(!fn.includes("console."));
  assert(!/console\.[^(]*destinationIdentifier/.test(fn));
  assert(!/console\.[^(]*accountHolderName/.test(fn));
});
