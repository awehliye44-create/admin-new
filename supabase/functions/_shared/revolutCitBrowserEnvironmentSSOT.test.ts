/**
 * TSRC14 / CIT browser environment SSOT + Book pay wiring locks.
 *
 * Run:
 *   deno test --allow-read --no-check supabase/functions/_shared/revolutCitBrowserEnvironmentSSOT.test.ts
 *   deno test --allow-read --no-check supabase/tests/_shared/savedCardPaymentReconcileLock.test.ts
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  extractBrowserEnvironmentFromPreauthBody,
  parseAndValidateCitBrowserEnvironment,
} from "./revolutCitBrowserEnvironmentSSOT.ts";
import { isTechnicalDeclineReason } from "./savedCardPaymentReconcileSSOT.ts";

const SAMSUNG_A165F_BST = {
  type: "browser",
  time_zone_utc_offset: 60,
  color_depth: 24,
  screen_width: 1080,
  screen_height: 2340,
  java_enabled: false,
  challenge_window_width: 1080,
  browser_url: "onecab-customer://payment-acs",
};

Deno.test("Samsung-like CIT browser env accepted", () => {
  const parsed = parseAndValidateCitBrowserEnvironment(SAMSUNG_A165F_BST);
  assert(parsed.ok);
  if (!parsed.ok) return;
  assertEquals(parsed.environment.time_zone_utc_offset, 60);
  assertEquals(parsed.environment.screen_width, 1080);
  assertEquals(parsed.environment.screen_height, 2340);
  assertEquals(parsed.environment.browser_url, "onecab-customer://payment-acs");
});

Deno.test("missing browser env rejected", () => {
  const parsed = parseAndValidateCitBrowserEnvironment(null);
  assert(!parsed.ok);
  if (parsed.ok) return;
  assertEquals(parsed.code, "BROWSER_ENVIRONMENT_REQUIRED");
});

Deno.test("invalid browser env rejected (non-finite / wrong type / bad url)", () => {
  assert(!parseAndValidateCitBrowserEnvironment({ type: "browser" }).ok);
  assert(!parseAndValidateCitBrowserEnvironment({
    ...SAMSUNG_A165F_BST,
    type: "mobile",
  }).ok);
  assert(!parseAndValidateCitBrowserEnvironment({
    ...SAMSUNG_A165F_BST,
    screen_width: Number.NaN,
  }).ok);
  assert(!parseAndValidateCitBrowserEnvironment({
    ...SAMSUNG_A165F_BST,
    time_zone_utc_offset: 12.5,
  }).ok);
  assert(!parseAndValidateCitBrowserEnvironment({
    ...SAMSUNG_A165F_BST,
    browser_url: "",
  }).ok);
  assert(!parseAndValidateCitBrowserEnvironment({
    ...SAMSUNG_A165F_BST,
    browser_url: "ftp://evil",
  }).ok);
});

Deno.test("extractBrowserEnvironmentFromPreauthBody reads top-level or nested", () => {
  assertEquals(
    extractBrowserEnvironmentFromPreauthBody({ browser_environment: SAMSUNG_A165F_BST }),
    SAMSUNG_A165F_BST,
  );
  assertEquals(
    extractBrowserEnvironmentFromPreauthBody({ environment: SAMSUNG_A165F_BST }),
    SAMSUNG_A165F_BST,
  );
  assertEquals(extractBrowserEnvironmentFromPreauthBody({}), null);
});

Deno.test("pay body uses provided env fields — no hardcoded 390/0 stubs", async () => {
  const orders = await Deno.readTextFile(
    new URL("./revolutOrders.ts", import.meta.url),
  );
  const payIdx = orders.indexOf("export async function payRevolutOrderWithSavedCard");
  assert(payIdx >= 0);
  const paySlice = orders.slice(payIdx, payIdx + 1200);
  assert(
    paySlice.includes("environment: browserEnvironment"),
    "pay must pass validated browserEnvironment",
  );
  assert(!paySlice.includes("screen_width: 390"), "must not hardcode iPhone width");
  assert(!paySlice.includes("screen_height: 844"), "must not hardcode iPhone height");
  assert(!paySlice.includes("time_zone_utc_offset: 0"), "must not hardcode UTC offset 0");
  assert(!paySlice.includes('"https://onecab.app"'), "must not hardcode onecab.app url");
  assert(
    paySlice.includes('initiator: "customer" | "merchant" = "customer"'),
    "initiator must default to customer",
  );
});

Deno.test("Book saved-card path remains CIT initiator=customer", async () => {
  const preauth = await Deno.readTextFile(
    new URL("./revolutPreauth.ts", import.meta.url),
  );
  assert(preauth.includes('const initiator = "customer" as const'));
  assert(!/initiator\s*=\s*["']merchant["']/.test(preauth));
  assert(preauth.includes("parseAndValidateCitBrowserEnvironment"));
  assert(preauth.includes("citBrowserEnvironmentErrorResponse"));
  // Pay call (not the import) passes validated env before initiator
  const payIdx = preauth.indexOf("const payment = await payRevolutOrderWithSavedCard");
  assert(payIdx >= 0);
  const paySlice = preauth.slice(payIdx, payIdx + 400);
  assert(paySlice.includes("payEnv.environment"));
  assert(paySlice.includes("initiator"));
});

Deno.test("create-preauth validates browser_environment before Revolut for saved card", async () => {
  const edge = await Deno.readTextFile(
    new URL("../create-preauth-payment-intent/index.ts", import.meta.url),
  );
  assert(edge.includes("BROWSER_ENVIRONMENT_REJECTED"));
  assert(edge.includes("extractBrowserEnvironmentFromPreauthBody"));
  assert(edge.includes("validatedBrowserEnvironment"));
  assert(edge.includes("browserEnvironment: validatedBrowserEnvironment"));
  // Fail closed happens before the createRevolutPreauthResponse *call*
  const rejectIdx = edge.indexOf("BROWSER_ENVIRONMENT_REJECTED");
  const createCallIdx = edge.indexOf("return await createRevolutPreauthResponse");
  assert(rejectIdx >= 0 && createCallIdx >= 0 && rejectIdx < createCallIdx);
});

Deno.test("technical_error still preserve_saved_card", () => {
  assert(isTechnicalDeclineReason("technical_error"));
});
