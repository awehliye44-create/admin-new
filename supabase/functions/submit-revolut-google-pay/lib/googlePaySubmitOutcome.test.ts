import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyGooglePaySubmitFailure,
  readRevolutApiThrow,
} from "./googlePaySubmitOutcome.ts";
import {
  isPlaceholderGooglePayPostcode,
  resolveGooglePayBillingContract,
} from "./googlePayBillingContract.ts";
import {
  buildGooglePayOpsAlertRow,
  googlePayFailureFingerprint,
} from "./googlePayOpsAlertSSOT.ts";

Deno.test("readRevolutApiThrow extracts plain Merchant API throws with body code", () => {
  assertEquals(
    readRevolutApiThrow({
      message: "postcode is empty",
      status: 400,
      body: { code: "validation", message: "postcode is empty" },
    }),
    {
      message: "postcode is empty",
      status: 400,
      revolut_error_code: "validation",
      body: { code: "validation", message: "postcode is empty" },
    },
  );
});

Deno.test("classifyGooglePaySubmitFailure maps Revolut 4xx to definitive validation", () => {
  const out = classifyGooglePaySubmitFailure({
    declineReason: null,
    providerRejected: false,
    revolutHttpStatus: 400,
    revolutMessage: "postcode is empty",
    revolutErrorCode: "validation",
  });
  assertEquals(out.code, "GOOGLE_PAY_SUBMIT_FAILED");
  assertEquals(out.status, 400);
  assertEquals(out.category, "validation");
  assertEquals(out.ambiguous, false);
  assertEquals(out.revolut_error_code, "validation");
});

Deno.test("classifyGooglePaySubmitFailure keeps 502 ambiguous without order evidence", () => {
  const out = classifyGooglePaySubmitFailure({
    declineReason: null,
    providerRejected: false,
    revolutHttpStatus: 502,
  });
  assertEquals(out.code, "GOOGLE_PAY_SUBMIT_FAILED");
  assertEquals(out.status, 502);
  assertEquals(out.category, "provider_failure");
  assertEquals(out.ambiguous, true);
});

Deno.test("classifyGooglePaySubmitFailure maps issuer decline reasons to bank copy", () => {
  const out = classifyGooglePaySubmitFailure({
    declineReason: "insufficient_funds",
    providerRejected: true,
  });
  assertEquals(out.code, "PAYMENT_DECLINED_BY_BANK");
  assertEquals(out.bank_declined, true);
  assertEquals(out.category, "issuer_decline");
  assertEquals(out.ambiguous, false);
});

Deno.test("classifyGooglePaySubmitFailure treats 429 as ambiguous rate limit", () => {
  const out = classifyGooglePaySubmitFailure({
    declineReason: null,
    providerRejected: false,
    revolutHttpStatus: 429,
  });
  assertEquals(out.code, "PAYMENT_RATE_LIMITED");
  assertEquals(out.ambiguous, true);
  assertEquals(out.category, "rate_limited");
});

Deno.test("billing contract accepts genuine Wallet address (yesterday success shape)", () => {
  const out = resolveGooglePayBillingContract({
    street_line_1: "Flat 7 204 Priestley Drive",
    city: "Milton Keynes",
    postcode: "MK4 4PY",
    country_code: "GB",
  });
  assertEquals(out.ok, true);
  if (out.ok) {
    assertEquals(out.billing.postcode, "MK4 4PY");
    assertEquals(out.billing.country_code, "GB");
  }
});

Deno.test("billing contract accepts Google Pay key aliases and international country", () => {
  const out = resolveGooglePayBillingContract({
    address1: "221B Baker Street",
    locality: "London",
    postalCode: "NW1 6XE",
    countryCode: "gb",
  });
  assertEquals(out.ok, true);
  if (out.ok) {
    assertEquals(out.billing.country_code, "GB");
    assertEquals(out.billing.postcode, "NW1 6XE");
  }

  const us = resolveGooglePayBillingContract({
    address1: "1 Infinite Loop",
    locality: "Cupertino",
    postalCode: "95014",
    countryCode: "US",
  });
  assertEquals(us.ok, true);
  if (us.ok) assertEquals(us.billing.country_code, "US");
});

Deno.test("billing contract rejects missing and placeholder postcodes", () => {
  assertEquals(resolveGooglePayBillingContract({ countryCode: "GB" }).ok, false);
  assertEquals(
    resolveGooglePayBillingContract({ postcode: "000000", country_code: "GB" }).ok,
    false,
  );
  assertEquals(
    resolveGooglePayBillingContract({ postcode: "SW1A 1AA", country_code: "GB" }).ok,
    false,
  );
  assertEquals(isPlaceholderGooglePayPostcode("000000"), true);
  assertEquals(isPlaceholderGooglePayPostcode("MK4 4PY"), false);
});

Deno.test("ops alert row includes required NOT NULL columns", () => {
  const row = buildGooglePayOpsAlertRow({
    fingerprint: googlePayFailureFingerprint({
      customer_code: "GOOGLE_PAY_SUBMIT_FAILED",
      revolut_error_code: "validation",
    }),
    title: "Google Pay submit validation",
    related_payment_session_id: "00000000-0000-4000-8000-000000000001",
  });
  assertEquals(row.category, "payments_google_pay");
  assertEquals(row.severity, "warning");
  assertEquals(row.source, "edge_function");
  assertEquals(row.status, "open");
  assertEquals(typeof row.fingerprint, "string");
});
