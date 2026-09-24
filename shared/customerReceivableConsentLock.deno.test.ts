/**
 * Lock: NO_VISIBLE_CONSENT → NO_RECEIVABLE_FOLD.
 * Gate default OFF; old apps never fold; amount/quote/total mismatch fails closed.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CUSTOMER_RECEIVABLE_CONSENT_VERSION,
  RECEIVABLE_CONSENT_REFRESH_REQUIRED,
  RECEIVABLE_FOLD_GATE_OFF,
  RECEIVABLE_FOLD_SKIPPED_COMPAT,
  buildServerReceivableQuoteVersion,
  planCustomerReceivableFoldConsent,
  planReceivableReservedTotalMatchesConsent,
  readCustomerReceivableFoldGate,
} from "../supabase/functions/_shared/customerReceivableConsentSSOT.ts";

Deno.test("1. fold gate defaults OFF", () => {
  const g = readCustomerReceivableFoldGate({
    CUSTOMER_RECEIVABLE_FOLD_ENABLED: undefined,
  });
  assertEquals(g.enabled, false);
});

Deno.test("2. gate OFF → no fold even with valid consent", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    gate: { enabled: false, allowlist: new Set() },
    consent: {
      customer_receivable_consent_version: CUSTOMER_RECEIVABLE_CONSENT_VERSION,
      customer_receivable_displayed_outstanding_pence: 36,
    },
  });
  assertEquals(d.allow_fold, false);
  assertEquals(d.reason, RECEIVABLE_FOLD_GATE_OFF);
});

Deno.test("3. old app missing consent version → NO fold (compat)", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    gate: { enabled: true, allowlist: new Set() },
    consent: {},
  });
  assertEquals(d.allow_fold, false);
  assertEquals(d.reason, RECEIVABLE_FOLD_SKIPPED_COMPAT);
});

Deno.test("4. consent version mismatch amount → refresh required fail-closed", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    gate: { enabled: true, allowlist: new Set() },
    consent: {
      customer_receivable_consent_version: 1,
      customer_receivable_displayed_outstanding_pence: 30,
    },
  });
  assertEquals(d.allow_fold, false);
  assertEquals("fail_closed" in d && d.fail_closed, true);
  assertEquals(d.reason, RECEIVABLE_CONSENT_REFRESH_REQUIRED);
});

Deno.test("5. matching consent + gate ON → allow fold", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    server_ride_fare_pence: 744,
    server_buffer_pence: 0,
    gate: { enabled: true, allowlist: new Set() },
    consent: {
      customer_receivable_consent_version: 1,
      customer_receivable_displayed_outstanding_pence: 36,
      customer_receivable_quote_version: "outstanding:36:v1",
      customer_receivable_displayed_trip_fare_pence: 744,
      customer_receivable_displayed_total_authorisation_pence: 780,
    },
  });
  assertEquals(d.allow_fold, true);
  if (d.allow_fold) {
    assertEquals(d.reason, "consent_matched");
    assertEquals(d.displayed_outstanding_pence, 36);
    assertEquals(d.displayed_total_authorisation_pence, 780);
  }
});

Deno.test("6. allowlist excludes other customers", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-other",
    server_outstanding_pence: 36,
    gate: { enabled: true, allowlist: new Set(["cust-allowed"]) },
    consent: {
      customer_receivable_consent_version: 1,
      customer_receivable_displayed_outstanding_pence: 36,
    },
  });
  assertEquals(d.allow_fold, false);
  assertEquals(d.reason, "not_on_allowlist");
});

Deno.test("7. zero outstanding + consent version → allow (no-op fold)", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 0,
    gate: { enabled: true, allowlist: new Set() },
    consent: {
      customer_receivable_consent_version: 1,
      customer_receivable_displayed_outstanding_pence: 0,
    },
  });
  assertEquals(d.allow_fold, true);
});

Deno.test("8. revolutPreauth wires consent planner before reserve", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../supabase/functions/_shared/revolutPreauth.ts",
      import.meta.url,
    ),
  );
  assertEquals(src.includes("planCustomerReceivableFoldConsent"), true);
  assertEquals(src.includes("RECEIVABLE_CONSENT_REFRESH_REQUIRED"), true);
  assertEquals(src.includes("sumOpenReceivableOutstandingForCustomer"), true);
  assertEquals(src.includes("planReceivableReservedTotalMatchesConsent"), true);
  const consentIdx = src.indexOf("planCustomerReceivableFoldConsent");
  const reserveIdx = src.indexOf("reserveReceivablesBeforeProviderCall(supabase");
  assertEquals(consentIdx > 0 && reserveIdx > consentIdx, true);
});

Deno.test("9. changed quote version → refresh required", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    gate: { enabled: true, allowlist: new Set() },
    consent: {
      customer_receivable_consent_version: 1,
      customer_receivable_displayed_outstanding_pence: 36,
      customer_receivable_quote_version: "outstanding:30:v1",
    },
  });
  assertEquals(d.allow_fold, false);
  assertEquals("fail_closed" in d && d.fail_closed, true);
  assertEquals(d.reason, RECEIVABLE_CONSENT_REFRESH_REQUIRED);
  assertEquals(
    (d as { telemetry: { note?: string } }).telemetry.note,
    "quote_version_mismatch",
  );
});

Deno.test("10. displayed total authorisation mismatch → refresh required", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    server_ride_fare_pence: 744,
    server_buffer_pence: 0,
    gate: { enabled: true, allowlist: new Set() },
    consent: {
      customer_receivable_consent_version: 1,
      customer_receivable_displayed_outstanding_pence: 36,
      customer_receivable_quote_version: buildServerReceivableQuoteVersion(36),
      customer_receivable_displayed_trip_fare_pence: 744,
      customer_receivable_displayed_total_authorisation_pence: 744, // wrong — missing 36
    },
  });
  assertEquals(d.allow_fold, false);
  assertEquals("fail_closed" in d && d.fail_closed, true);
  assertEquals(
    (d as { telemetry: { note?: string } }).telemetry.note,
    "displayed_total_authorisation_mismatch",
  );
});

Deno.test("11. reserved total mismatch after reserve → fail closed", () => {
  const ok = planReceivableReservedTotalMatchesConsent({
    reserved_authorised_amount_pence: 780,
    displayed_total_authorisation_pence: 780,
  });
  assertEquals(ok.ok, true);
  const bad = planReceivableReservedTotalMatchesConsent({
    reserved_authorised_amount_pence: 800,
    displayed_total_authorisation_pence: 780,
  });
  assertEquals(bad.ok, false);
  if (!bad.ok) {
    assertEquals(bad.reason, RECEIVABLE_CONSENT_REFRESH_REQUIRED);
  }
});
