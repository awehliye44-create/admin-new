/**
 * Step 9.4E — lock restored driver payout destination exports + durable OAuth parity.
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decryptDestinationIdentifier,
  encryptDestinationIdentifier,
  normalizeDestinationVerificationStatus,
  parseUkBankIdentifier,
  DESTINATION_STATUS,
} from "./driverPayoutDestinationSSOT.ts";

const LINKAGE = new URL(
  "../admin-sync-driver-payout-provider-linkage/index.ts",
  import.meta.url,
);
const HELPER = new URL("./revolutBusinessAccessTokenRefresh.ts", import.meta.url);
const HELPER_EXPECTED =
  "5688fa0990e176f1cca9621144e58cfb09a4c3eb960668578f4e12bff3ce8ba7";

Deno.test("restored exports: encrypt/decrypt round-trip + fail-closed malformed", async () => {
  Deno.env.set("PAYOUT_DESTINATION_ENCRYPTION_KEY", "x".repeat(32) + "-step94e-test-key");
  const cipher = await encryptDestinationIdentifier("12345612345678");
  const plain = await decryptDestinationIdentifier(cipher);
  assertEquals(plain, "12345612345678");
  await assertRejects(() => decryptDestinationIdentifier(""), Error, "DESTINATION_CIPHERTEXT_EMPTY");
  await assertRejects(
    () => decryptDestinationIdentifier("not-valid-base64!!!"),
    Error,
  );
  await assertRejects(() => decryptDestinationIdentifier(btoa("short")), Error);
});

Deno.test("parseUkBankIdentifier validates UK structure and rejects foreign/partial", () => {
  assertEquals(parseUkBankIdentifier("12345612345678"), {
    sortCode: "123456",
    accountNumber: "12345678",
  });
  assertEquals(parseUkBankIdentifier("12-34-56 12345678"), {
    sortCode: "123456",
    accountNumber: "12345678",
  });
  assertEquals(parseUkBankIdentifier("123456|12345678"), {
    sortCode: "123456",
    accountNumber: "12345678",
  });
  assertEquals(parseUkBankIdentifier("12345"), null);
  assertEquals(parseUkBankIdentifier("1234561234567"), null); // 7-digit account
  assertEquals(parseUkBankIdentifier("GB82WEST12345698765432"), null);
  assertEquals(parseUkBankIdentifier(""), null);
});

Deno.test("normalizeDestinationVerificationStatus never upgrades failed/unknown to verified", () => {
  assertEquals(
    normalizeDestinationVerificationStatus("MANUAL_VERIFIED"),
    DESTINATION_STATUS.MANUAL_VERIFIED,
  );
  assertEquals(
    normalizeDestinationVerificationStatus("provider_verified"),
    DESTINATION_STATUS.PROVIDER_VERIFIED,
  );
  assertEquals(
    normalizeDestinationVerificationStatus("FAILED"),
    DESTINATION_STATUS.FAILED,
  );
  assertEquals(
    normalizeDestinationVerificationStatus("UNVERIFIED"),
    DESTINATION_STATUS.UNVERIFIED,
  );
  assertEquals(
    normalizeDestinationVerificationStatus("VERIFIED"),
    DESTINATION_STATUS.UNKNOWN,
  );
  assertEquals(
    normalizeDestinationVerificationStatus("something_weird"),
    DESTINATION_STATUS.UNKNOWN,
  );
  assertEquals(
    normalizeDestinationVerificationStatus(null),
    DESTINATION_STATUS.UNVERIFIED,
  );
});

Deno.test("linkage index boots with restored exports + dry_run + durable OAuth", async () => {
  const src = await Deno.readTextFile(LINKAGE);
  assertStringIncludes(src, "decryptDestinationIdentifier");
  assertStringIncludes(src, "normalizeDestinationVerificationStatus");
  assertStringIncludes(src, "parseUkBankIdentifier");
  assertStringIncludes(src, 'from "../_shared/driverPayoutDestinationSSOT.ts"');
  assertStringIncludes(src, "ensureFreshRevolutBusinessAccessToken");
  assertStringIncludes(src, "dry_run");
  assertStringIncludes(src, "ALREADY_LINKED");
  assertStringIncludes(src, "driver_ids must be a non-empty string array");
  assertEquals(src.includes("DEFAULT_DRIVER_IDS"), false);
  // No unlocked credential writers outside claim/CAS helper
  assertEquals(src.includes("updateRevolutBusinessCredentials"), false);
});

Deno.test("durable OAuth helper SHA matches Step 9.4D2", async () => {
  const bytes = await Deno.readFile(HELPER);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assertEquals(hex, HELPER_EXPECTED);
  const src = await Deno.readTextFile(HELPER);
  assertStringIncludes(src, "claim_revolut_business_oauth_refresh");
  assertStringIncludes(src, "complete_revolut_business_oauth_refresh");
  assertStringIncludes(src, "fail_revolut_business_oauth_refresh");
});

Deno.test("linkage source: already-linked before decrypt; no /pay", async () => {
  const src = await Deno.readTextFile(LINKAGE);
  const alreadyIdx = src.indexOf("Idempotent reuse of existing mapping");
  const decryptIdx = src.indexOf("Decrypt server-side only");
  assertEquals(alreadyIdx > 0 && decryptIdx > alreadyIdx, true);
  assertEquals(src.includes('"/pay"') || src.includes("'/pay'") || src.includes("`/pay`"), false);
  assertEquals(src.includes("relayRevolutPay") || src.includes("mayCallRevolutPayEndpoint"), false);
  assertStringIncludes(src, "revolut_pay_called: false");
});
