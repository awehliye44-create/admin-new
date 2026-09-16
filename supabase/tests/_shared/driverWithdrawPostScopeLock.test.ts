/**
 * Lock: POST must not reference helper-locals from buildDriverWithdrawQuoteReadOnly.
 * Service area must be server-owned via built.service_area_id.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DRIVER_WITHDRAW_CLIENT_SERVICE_AREA_REJECTED,
  DRIVER_WITHDRAW_DRIVER_COLLECTED_REJECTED,
  DRIVER_WITHDRAW_INTERNAL_ERROR,
  DRIVER_WITHDRAW_SERVICE_AREA_MISSING,
  DRIVER_WITHDRAW_SERVICE_AREA_MISMATCH,
  rejectClientServiceAreaOverride,
  resolveAuthoritativeWithdrawServiceArea,
  safeDriverWithdrawInternalErrorBody,
} from "../../functions/_shared/driverWithdrawPostScopeSSOT.ts";

const EDGE = new URL("../../functions/driver-withdraw/index.ts", import.meta.url);
const MK_SA = "cb58f1bd-8b6f-45b9-ad31-b3140309892c";

Deno.test("POST source lock: no undeclared summary.service_area_id; uses built.service_area_id", async () => {
  const src = await Deno.readTextFile(EDGE);
  const post = src.slice(src.indexOf('if (req.method !== "POST")'));
  assertEquals(post.includes("summary.service_area_id"), false);
  assertEquals(/\bsummary\./.test(post), false);
  assertStringIncludes(post, "built.service_area_id");
  assertStringIncludes(post, "rejectClientServiceAreaOverride");
  assertStringIncludes(src, "resolveAuthoritativeWithdrawServiceArea");
  assertStringIncludes(post, DRIVER_WITHDRAW_INTERNAL_ERROR);
  assertStringIncludes(post, "safeDriverWithdrawInternalErrorBody");
  // GET still present and write-free
  const getBlock = src.slice(
    src.indexOf('req.method === "GET"'),
    src.indexOf('if (req.method !== "POST")'),
  );
  assertEquals(getBlock.includes("reserve_driver_payout_item"), false);
  assertEquals(getBlock.includes("relayApprovedDriverPayoutPayment"), false);
});

Deno.test("resolveAuthoritativeWithdrawServiceArea: summary SA owned by driver", () => {
  const ok = resolveAuthoritativeWithdrawServiceArea({
    summary_service_area_id: MK_SA,
    driver_primary_service_area_id: MK_SA,
    driver_membership_service_area_ids: [MK_SA],
    financial_model: "PLATFORM_COLLECTED",
  });
  assertEquals(ok.ok, true);
  if (ok.ok) assertEquals(ok.service_area_id, MK_SA);
});

Deno.test("resolveAuthoritativeWithdrawServiceArea: missing SA fails closed", () => {
  const r = resolveAuthoritativeWithdrawServiceArea({
    summary_service_area_id: null,
    driver_primary_service_area_id: MK_SA,
    driver_membership_service_area_ids: [MK_SA],
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, DRIVER_WITHDRAW_SERVICE_AREA_MISSING);
});

Deno.test("resolveAuthoritativeWithdrawServiceArea: mismatch fails closed", () => {
  const r = resolveAuthoritativeWithdrawServiceArea({
    summary_service_area_id: MK_SA,
    driver_primary_service_area_id: "11111111-1111-4111-8111-111111111111",
    driver_membership_service_area_ids: ["11111111-1111-4111-8111-111111111111"],
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, DRIVER_WITHDRAW_SERVICE_AREA_MISMATCH);
});

Deno.test("resolveAuthoritativeWithdrawServiceArea: DRIVER_COLLECTED rejected", () => {
  const r = resolveAuthoritativeWithdrawServiceArea({
    summary_service_area_id: MK_SA,
    driver_primary_service_area_id: MK_SA,
    driver_membership_service_area_ids: [MK_SA],
    financial_model: "DRIVER_COLLECTED",
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, DRIVER_WITHDRAW_DRIVER_COLLECTED_REJECTED);
});

Deno.test("rejectClientServiceAreaOverride blocks client override", () => {
  const r = rejectClientServiceAreaOverride({ service_area_id: MK_SA });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, DRIVER_WITHDRAW_CLIENT_SERVICE_AREA_REJECTED);
  assertEquals(rejectClientServiceAreaOverride({ amount_pence: 3319 }).ok, true);
});

Deno.test("internal error body is typed — not NO_AVAILABLE_BALANCE", () => {
  const body = safeDriverWithdrawInternalErrorBody({ request_id: "req-1" });
  assertEquals(body.error_code, DRIVER_WITHDRAW_INTERNAL_ERROR);
  assertEquals(body.error, DRIVER_WITHDRAW_INTERNAL_ERROR);
  assertEquals(String(body.driver_message).includes("No balance"), false);
  assertEquals(String(body.driver_message).toLowerCase().includes("available balance"), false);
  assertEquals(body.revolut_pay_called, false);
});
