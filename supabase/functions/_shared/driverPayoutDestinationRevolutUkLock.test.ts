/**
 * Lock: Revolut / UK bank payout gateways must accept Driver's uk_bank_account type.
 * Regression: missing revolut catalog fell through to mobile_money/bank_account only,
 * so Driver save failed with "destination type is not supported for your service area."
 *
 * Run: deno test --allow-read supabase/functions/_shared/driverPayoutDestinationRevolutUkLock.test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  isDestinationTypeAllowed,
  supportedDestinationTypesForProvider,
  validateDestinationIdentifier,
} from "./driverPayoutDestinationSSOT.ts";

const SHARED = fromFileUrl(new URL(".", import.meta.url));

Deno.test("revolut allows uk_bank_account (Driver native submit type)", () => {
  assertEquals(isDestinationTypeAllowed("revolut", "uk_bank_account"), true);
  assertEquals(isDestinationTypeAllowed("Revolut", "uk_bank_account"), true);
  for (const provider of ["bank", "uk_bank", "manual_bank"] as const) {
    assertEquals(isDestinationTypeAllowed(provider, "uk_bank_account"), true);
  }
});

Deno.test("revolut rejects unrelated destination types", () => {
  assertEquals(isDestinationTypeAllowed("revolut", "mobile_money"), false);
  assertEquals(isDestinationTypeAllowed("revolut", "mpesa"), false);
});

Deno.test("supportedDestinationTypesForProvider(revolut) lists uk_bank_account", () => {
  const ids = supportedDestinationTypesForProvider("revolut").map((t) => t.id);
  assertEquals(ids.includes("uk_bank_account"), true);
});

Deno.test("validateDestinationIdentifier accepts UK sort+account lengths", () => {
  assertEquals(validateDestinationIdentifier("uk_bank_account", "40166412345678"), {
    ok: true,
  });
  assertEquals(validateDestinationIdentifier("uk_bank_account", "4016641234567890"), {
    ok: true,
  });
  assertEquals(
    validateDestinationIdentifier("uk_bank_account", "401664123").ok,
    false,
  );
});

Deno.test("update handler still gates via isDestinationTypeAllowed", async () => {
  const src = await Deno.readTextFile(
    join(SHARED, "updateDriverPayoutDestinationHandler.ts"),
  );
  assertStringIncludes(src, "isDestinationTypeAllowed(provider, destinationType)");
  assertStringIncludes(
    src,
    "This payout destination type is not supported for your service area.",
  );
});

Deno.test("SSOT exports decrypt + DESTINATION_STATUS for verify/sync", async () => {
  const {
    DESTINATION_STATUS,
    decryptDestinationIdentifier,
    normalizeDestinationVerificationStatus,
    parseUkBankIdentifier,
  } = await import("./driverPayoutDestinationSSOT.ts");
  assertEquals(DESTINATION_STATUS.PROVIDER_VERIFIED, "PROVIDER_VERIFIED");
  assertEquals(normalizeDestinationVerificationStatus("pending"), "PENDING_VERIFICATION");
  assertEquals(parseUkBankIdentifier("40166412345678")?.sortCode, "401664");
  assertEquals(typeof decryptDestinationIdentifier, "function");
});

Deno.test("save handler auto-links Revolut on uk_bank_account (no manual Verify gate)", async () => {
  const src = await Deno.readTextFile(
    join(SHARED, "updateDriverPayoutDestinationHandler.ts"),
  );
  assertStringIncludes(src, "attemptAutoRevolutLinkage");
  assertStringIncludes(src, "createRevolutCounterparty");
  assertStringIncludes(src, "PROVIDER_VERIFIED");
  assertStringIncludes(src, "provider_auto_linked");
});
