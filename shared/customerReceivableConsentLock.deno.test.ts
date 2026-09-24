/**
 * Lock: RECEIVABLE_EXPECTED fail-closed admission (MK-260924-002).
 * Gate default OFF; old apps fare-only; consented 536 never silently becomes 500.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CUSTOMER_RECEIVABLE_CONSENT_VERSION,
  RECEIVABLE_CONSENT_REFRESH_REQUIRED,
  RECEIVABLE_FOLD_GATE_OFF,
  RECEIVABLE_FOLD_SKIPPED_COMPAT,
  RECEIVABLE_FOLD_UNAVAILABLE,
  buildServerReceivableQuoteVersion,
  classifyReceivableExpectedRequest,
  planCustomerReceivableFoldConsent,
  planCustomerReceivableFoldEligibilityQuote,
  planReceivableReservedTotalMatchesConsent,
  readCustomerReceivableFoldGate,
} from "../supabase/functions/_shared/customerReceivableConsentSSOT.ts";

Deno.test("1. fold gate defaults OFF", () => {
  const g = readCustomerReceivableFoldGate({
    CUSTOMER_RECEIVABLE_FOLD_ENABLED: undefined,
  });
  assertEquals(g.enabled, false);
});

Deno.test("2. RECEIVABLE_EXPECTED + gate OFF → fail-closed UNAVAILABLE (no fare-only)", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    server_ride_fare_pence: 500,
    server_buffer_pence: 0,
    gate: { enabled: false, allowlist: new Set() },
    consent: {
      customer_receivable_consent_version: CUSTOMER_RECEIVABLE_CONSENT_VERSION,
      customer_receivable_displayed_outstanding_pence: 36,
      customer_receivable_quote_version: "outstanding:36:v1",
      customer_receivable_displayed_trip_fare_pence: 500,
      customer_receivable_displayed_total_authorisation_pence: 536,
    },
  });
  assertEquals(d.allow_fold, false);
  assertEquals("fail_closed" in d && d.fail_closed, true);
  assertEquals(d.reason, RECEIVABLE_FOLD_UNAVAILABLE);
  assertEquals(d.receivable_expected, true);
});

Deno.test("3. old app missing consent version → NO fold (compat fare-only)", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    gate: { enabled: true, allowlist: new Set() },
    consent: {},
  });
  assertEquals(d.allow_fold, false);
  assertEquals(d.reason, RECEIVABLE_FOLD_SKIPPED_COMPAT);
  assertEquals(d.receivable_expected, false);
  assertEquals("fail_closed" in d && d.fail_closed, false);
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

Deno.test("5. matching consent + gate ON → allow fold (admission frozen)", () => {
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
    assertEquals(d.admission_frozen, true);
    assertEquals(d.gate_enabled_at_admission, true);
    assertEquals(d.displayed_outstanding_pence, 36);
    assertEquals(d.displayed_total_authorisation_pence, 780);
  }
});

Deno.test("6. RECEIVABLE_EXPECTED + not allowlisted → fail-closed UNAVAILABLE", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-other",
    server_outstanding_pence: 36,
    server_ride_fare_pence: 500,
    gate: { enabled: true, allowlist: new Set(["cust-allowed"]) },
    consent: {
      customer_receivable_consent_version: 1,
      customer_receivable_displayed_outstanding_pence: 36,
      customer_receivable_displayed_trip_fare_pence: 500,
      customer_receivable_displayed_total_authorisation_pence: 536,
    },
  });
  assertEquals(d.allow_fold, false);
  assertEquals("fail_closed" in d && d.fail_closed, true);
  assertEquals(d.reason, RECEIVABLE_FOLD_UNAVAILABLE);
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

Deno.test("8. revolutPreauth wires fail-closed UNAVAILABLE before provider", async () => {
  const src = await Deno.readTextFile(
    new URL(
      "../supabase/functions/_shared/revolutPreauth.ts",
      import.meta.url,
    ),
  );
  assertEquals(src.includes("planCustomerReceivableFoldConsent"), true);
  assertEquals(src.includes("RECEIVABLE_FOLD_UNAVAILABLE"), true);
  assertEquals(src.includes("fold_disabled_receivable_expected") || src.includes("RECEIVABLE_FOLD_UNAVAILABLE"), true);
  assertEquals(src.includes("receivables_remain_OPEN_fare_only_preauth"), false);
  assertEquals(src.includes("old_client_or_no_debt_consent_fare_only"), true);
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

Deno.test("12. classify RECEIVABLE_EXPECTED from consent / total / quote", () => {
  assertEquals(
    classifyReceivableExpectedRequest({
      customer_receivable_displayed_outstanding_pence: 36,
    }).receivable_expected,
    true,
  );
  assertEquals(
    classifyReceivableExpectedRequest({
      customer_receivable_displayed_trip_fare_pence: 500,
      customer_receivable_displayed_total_authorisation_pence: 536,
    }).reason,
    "displayed_total_exceeds_trip_fare",
  );
  assertEquals(
    classifyReceivableExpectedRequest({
      customer_receivable_quote_version: "outstanding:36:v1",
    }).receivable_expected,
    true,
  );
  assertEquals(
    classifyReceivableExpectedRequest({}).receivable_expected,
    false,
  );
});

Deno.test("13. eligibility quote: gate OFF → fold_eligible false, CTA = fare only", () => {
  const q = planCustomerReceivableFoldEligibilityQuote({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    trip_fare_pence: 500,
    buffer_pence: 0,
    gate: { enabled: false, allowlist: new Set() },
  });
  assertEquals(q.fold_eligible, false);
  assertEquals(q.outstanding_pence, 36);
  assertEquals(q.total_authorisation_pence, 500);
  assertEquals(q.quote_version, "outstanding:36:v1");
});

Deno.test("14. eligibility quote: gate ON → fold_eligible true, CTA = 536", () => {
  const q = planCustomerReceivableFoldEligibilityQuote({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    trip_fare_pence: 500,
    buffer_pence: 0,
    gate: { enabled: true, allowlist: new Set() },
  });
  assertEquals(q.fold_eligible, true);
  assertEquals(q.total_authorisation_pence, 536);
});

Deno.test("15. gate OFF without RECEIVABLE_EXPECTED → soft GATE_OFF compat", () => {
  const d = planCustomerReceivableFoldConsent({
    customer_id: "cust-1",
    server_outstanding_pence: 36,
    gate: { enabled: false, allowlist: new Set() },
    consent: {},
  });
  assertEquals(d.allow_fold, false);
  assertEquals(d.reason, RECEIVABLE_FOLD_GATE_OFF);
  assertEquals("fail_closed" in d && d.fail_closed, false);
});
