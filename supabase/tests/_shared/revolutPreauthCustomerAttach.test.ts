/**
 * Apple Pay / Google Pay preauth must not attach a Revolut customer.
 * Run: deno test --allow-read supabase/functions/_shared/revolutPreauthCustomerAttach.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { humanizeRevolutPreauthCustomerError } from "../../functions/_shared/revolutCustomerError.ts";
import {
  buildCreateRevolutOrderRequestBody,
  buildPreauthOrderCreateMetadata,
  customerForStaleOrderRetry,
  planStaleCachedCustomerOrderRetry,
  REVOLUT_PAYMENT_SETUP_FAILED_MESSAGE,
  shouldAttachRevolutCustomerForPreauth,
} from "../../functions/_shared/revolutPreauthCustomerAttach.ts";

const ORDER_BASE = {
  amountMinor: 500,
  currency: "GBP",
  tripId: "draft-1",
  description: "ONECAB ride pre-authorisation",
};

Deno.test("Apple Pay order body does not include customer", () => {
  assertEquals(shouldAttachRevolutCustomerForPreauth({
    paymentMethodType: "apple_pay",
    saveCardEligible: true,
    savedCardReuse: true,
  }), false);
  const metadata = buildPreauthOrderCreateMetadata({
    metadataExtra: {},
    estimatedTotalPence: 500,
    bufferPence: 0,
    paymentMethodType: "apple_pay",
    saveCardEligible: false,
    clientActionId: "action-1",
  });
  const body = buildCreateRevolutOrderRequestBody({
    ...ORDER_BASE,
    metadata,
    customer: null,
  });
  assertEquals("customer" in body, false);
  assertEquals(body.metadata, metadata);
  assertEquals((metadata as { save_card_eligible: string }).save_card_eligible, "false");
  assertEquals("platform_payment_method_id" in metadata, false);
  assertEquals("save_payment_method" in metadata, false);
});

Deno.test("Google Pay order body does not include customer", () => {
  assertEquals(shouldAttachRevolutCustomerForPreauth({
    paymentMethodType: "google_pay",
    saveCardEligible: false,
    savedCardReuse: false,
  }), false);
  const body = buildCreateRevolutOrderRequestBody({
    ...ORDER_BASE,
    metadata: { payment_method_type: "google_pay", save_card_eligible: "false" },
  });
  assertEquals("customer" in body, false);
  assertEquals(body.capture_mode, "manual");
});

Deno.test("card save opt-in attaches customer and save metadata", () => {
  assertEquals(shouldAttachRevolutCustomerForPreauth({
    paymentMethodType: "card",
    saveCardEligible: true,
    savedCardReuse: false,
  }), true);
  const metadata = buildPreauthOrderCreateMetadata({
    metadataExtra: { service_area_id: "sa-1" },
    estimatedTotalPence: 500,
    bufferPence: 0,
    paymentMethodType: "card",
    saveCardEligible: true,
    clientActionId: "action-1",
    userId: "user-1",
    platformPaymentMethodId: "onecab_pending_pm_1",
  });
  const body = buildCreateRevolutOrderRequestBody({
    ...ORDER_BASE,
    metadata,
    customer: { id: "cust-fresh", email: "rider@example.com" },
  });
  assertEquals(body.customer, { id: "cust-fresh" });
  assertEquals(metadata.save_card_eligible, "true");
  assertEquals(metadata.platform_payment_method_id, "onecab_pending_pm_1");
  assertEquals(metadata.payment_method_type, "card");
});

Deno.test("card without save does not attach customer or save metadata", () => {
  assertEquals(shouldAttachRevolutCustomerForPreauth({
    paymentMethodType: "card",
    saveCardEligible: false,
    savedCardReuse: false,
  }), false);
  const metadata = buildPreauthOrderCreateMetadata({
    metadataExtra: {},
    estimatedTotalPence: 500,
    bufferPence: 0,
    paymentMethodType: "card",
    saveCardEligible: false,
  });
  const body = buildCreateRevolutOrderRequestBody({
    ...ORDER_BASE,
    metadata,
  });
  assertEquals("customer" in body, false);
  assertEquals(metadata.save_card_eligible, "false");
  assertEquals("platform_payment_method_id" in metadata, false);
});

Deno.test("saved-card reuse still attaches customer and does not mark save eligible", () => {
  assertEquals(shouldAttachRevolutCustomerForPreauth({
    paymentMethodType: "card",
    saveCardEligible: false,
    savedCardReuse: true,
  }), true);
  const metadata = buildPreauthOrderCreateMetadata({
    metadataExtra: {},
    estimatedTotalPence: 500,
    bufferPence: 0,
    paymentMethodType: "card",
    saveCardEligible: false,
    platformPaymentMethodId: "pm-saved",
  });
  assertEquals(metadata.save_card_eligible, "false");
  assertEquals(metadata.platform_payment_method_id, "pm-saved");
});

Deno.test("stale cached customer 404 retries once, then omits a still-stale id", () => {
  const stale = { message: "The requested resource is not found", status: 404 };
  assertEquals(planStaleCachedCustomerOrderRetry({
    sentCachedCustomerId: true,
    alreadyRetried: false,
    err: stale,
  }), "refresh_and_retry");
  assertEquals(planStaleCachedCustomerOrderRetry({
    sentCachedCustomerId: true,
    alreadyRetried: true,
    err: stale,
  }), "none");
  assertEquals(planStaleCachedCustomerOrderRetry({
    sentCachedCustomerId: false,
    alreadyRetried: false,
    err: stale,
  }), "none");
  assertEquals(planStaleCachedCustomerOrderRetry({
    sentCachedCustomerId: true,
    alreadyRetried: false,
    err: { message: "declined", status: 402 },
  }), "none");
  assertEquals(customerForStaleOrderRetry({
    staleCustomerId: "stale-id",
    refreshed: { id: "fresh-id", email: "rider@example.com" },
  })?.id, "fresh-id");
  assertEquals(customerForStaleOrderRetry({
    staleCustomerId: "stale-id",
    refreshed: { id: "stale-id", email: "rider@example.com" },
  }), null);
  assertEquals(customerForStaleOrderRetry({
    staleCustomerId: "stale-id",
    refreshed: { email: "rider@example.com" },
  }), null);
});

Deno.test("raw Revolut resource-not-found is not shown to the rider", () => {
  assertEquals(
    humanizeRevolutPreauthCustomerError("The requested resource is not found"),
    REVOLUT_PAYMENT_SETUP_FAILED_MESSAGE,
  );
  assertEquals(
    REVOLUT_PAYMENT_SETUP_FAILED_MESSAGE.includes("not found"),
    false,
  );
});

Deno.test("failed order create returns before payment_session insert", () => {
  const src = Deno.readTextFileSync(new URL("../../functions/_shared/revolutPreauth.ts", import.meta.url));
  const fnStart = src.indexOf("export async function createRevolutPreauthResponse");
  const fn = src.slice(fnStart);
  const failReturn = fn.indexOf("return orderCreateFailed");
  const upsert = fn.indexOf("upsertPaymentSessionPending");
  assertEquals(failReturn > 0, true);
  assertEquals(upsert > failReturn, true);
  assertEquals(fn.includes("alreadyRetried: false"), true);
  assertEquals(fn.includes("ignoreCachedId: true"), true);
  assertEquals(fn.includes("shouldAttachRevolutCustomerForPreauth"), true);
  assertEquals(fn.includes("needsRevolutCustomer = Boolean(userId && customerEmail"), false);
});
