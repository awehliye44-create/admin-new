import {
  customerSafeErrorForFailureClass,
  failureClassFromGateReason,
} from "../../functions/_shared/modificationPaymentFailureTaxonomy.ts";

Deno.test("declined gate reason → ISSUER_DECLINED bank copy", () => {
  const cls = failureClassFromGateReason("declined", "PAYMENT_FAILED");
  if (cls !== "ISSUER_DECLINED") throw new Error(`expected ISSUER_DECLINED got ${cls}`);
  const msg = customerSafeErrorForFailureClass(cls);
  if (!msg.toLowerCase().includes("bank declined")) {
    throw new Error(`expected bank decline copy, got ${msg}`);
  }
});

Deno.test("generic failed gate → UNKNOWN not bank", () => {
  const cls = failureClassFromGateReason("failed", "PAYMENT_FAILED");
  if (cls !== "UNKNOWN_PROVIDER_ERROR") {
    throw new Error(`expected UNKNOWN_PROVIDER_ERROR got ${cls}`);
  }
  const msg = customerSafeErrorForFailureClass(cls);
  if (msg.toLowerCase().includes("bank")) {
    throw new Error(`must not blame bank: ${msg}`);
  }
});

Deno.test("timeout/network → NETWORK_OR_TIMEOUT", () => {
  if (failureClassFromGateReason("timeout") !== "NETWORK_OR_TIMEOUT") {
    throw new Error("timeout");
  }
  if (failureClassFromGateReason("network") !== "NETWORK_OR_TIMEOUT") {
    throw new Error("network");
  }
  const msg = customerSafeErrorForFailureClass("NETWORK_OR_TIMEOUT");
  if (!msg.includes("couldn't confirm") && !msg.includes("couldn’t confirm")) {
    // ASCII apostrophe in our string
    if (!msg.toLowerCase().includes("could not confirm") && !msg.includes("couldn't confirm")) {
      // our string uses couldn't with curly? check
      if (!/confirm the additional payment/i.test(msg)) {
        throw new Error(`unexpected network copy: ${msg}`);
      }
    }
  }
});

Deno.test("insufficient → INSUFFICIENT_FUNDS", () => {
  if (failureClassFromGateReason("insufficient") !== "INSUFFICIENT_FUNDS") {
    throw new Error("insufficient");
  }
});
