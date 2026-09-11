/**
 * A8B28F-B2R Stage 5 — driver UK counterparty create via fixed-IP relay locks.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { dirname, fromFileUrl, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  buildUkDriverRevolutCounterpartyBody,
  detectUkDriverCounterpartyKind,
} from "./revolutUkDriverCounterpartyPayload.ts";
import {
  classifyCounterpartyCreateFailure,
  DRIVER_FACING_VERIFY_FAILED_NEUTRAL,
  driverFacingMessageForOutcome,
  inferCounterpartyFailureSignals,
  PAYOUT_DESTINATION_OUTCOME,
  PROVIDER_LINK_FAILURE_CLASS,
} from "./payoutDestinationVerificationOutcomeSSOT.ts";

const SHARED = dirname(fromFileUrl(import.meta.url));

Deno.test("Stage 5 source: handler defaults to relay create, not direct createRevolutCounterparty", async () => {
  const handler = await Deno.readTextFile(join(SHARED, "updateDriverPayoutDestinationHandler.ts"));
  const api = await Deno.readTextFile(join(SHARED, "revolutApi.ts"));
  assert(handler.includes("createDriverUkBankCounterpartyViaRelay"));
  assert(!/\?\?\s*createRevolutCounterparty\b/.test(handler));
  assert(!handler.includes('from "./revolutApi.ts";\nimport { createRevolutCounterparty'));
  assertEquals(handler.includes("import { createDriverUkBankCounterpartyViaRelay }"), true);
  assertEquals(handler.includes("import { createRevolutCounterparty }"), false);

  const fnStart = api.indexOf("export async function createDriverUkBankCounterpartyViaRelay");
  assert(fnStart >= 0);
  const fnEnd = api.indexOf("\nexport async function executeRevolutPay", fnStart);
  const fn = api.slice(fnStart, fnEnd);
  assert(fn.includes("relayRevolutCreateCounterparty"));
  assert(fn.includes("buildUkDriverRevolutCounterpartyBody"));
  assert(!fn.includes("revolutBusinessRequest("));
  assert(!fn.includes("b2b.revolut.com"));
  assert(!fn.includes("sandbox-b2b.revolut.com"));
  assert(!fn.includes("console."));
  assert(!fn.includes("payouts_enabled"));
});

Deno.test("Stage 5 payloads: company + personal still map for relay body", () => {
  assertEquals(detectUkDriverCounterpartyKind("ONECAB Limited"), "business");
  const company = buildUkDriverRevolutCounterpartyBody({
    accountHolderName: "ONECAB Limited",
    destinationIdentifier: "04000379313778",
  });
  assertEquals(company.company_name, "ONECAB Limited");
  assertEquals(company.account_no, "79313778");
  assertEquals(company.sort_code, "040003");
  assertEquals(company.bank_country, "GB");
  assertEquals(company.currency, "GBP");
  assertEquals("profile_type" in company, false);

  const personal = buildUkDriverRevolutCounterpartyBody({
    accountHolderName: "Jane Driver",
    destinationIdentifier: "04000379313778",
  });
  assertEquals(personal.individual_name, { first_name: "Jane", last_name: "Driver" });
  assertEquals("company_name" in personal, false);
});

Deno.test("Stage 5: relay 403 / IP whitelist → PROVIDER_CONFIGURATION_REQUIRED + neutral copy", () => {
  const signals = inferCounterpartyFailureSignals(
    "IP address is not whitelisted. Verify IP whitelist configuration in Revolut Business Portal.",
  );
  const cls = classifyCounterpartyCreateFailure({ http_status: 403, ...signals });
  assertEquals(cls, PROVIDER_LINK_FAILURE_CLASS.PROVIDER_CONFIGURATION_REQUIRED);
  const msg = driverFacingMessageForOutcome(
    PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED,
    cls,
  );
  assertEquals(msg, DRIVER_FACING_VERIFY_FAILED_NEUTRAL);
});

Deno.test("Stage 5: relay network failure 503 classifies retryable/config, not user typo", () => {
  const signals = inferCounterpartyFailureSignals("revolut_business_relay_unreachable");
  const cls = classifyCounterpartyCreateFailure({ http_status: 503, ...signals });
  assertEquals(cls === PROVIDER_LINK_FAILURE_CLASS.USER_INPUT_CORRECTION_REQUIRED, false);
  assert(
    cls === PROVIDER_LINK_FAILURE_CLASS.RETRYABLE_TRANSIENT ||
      cls === PROVIDER_LINK_FAILURE_CLASS.UNRESOLVED_PROVIDER_CALL_REQUIRED ||
      cls === PROVIDER_LINK_FAILURE_CLASS.PROVIDER_CONFIGURATION_REQUIRED,
  );
});
