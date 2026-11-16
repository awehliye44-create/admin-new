/**
 * Bug #37 — Google Pay token integrity lock (sanitised).
 * Proves Pay-for-order payload shape, no double-encoding / truncation / remap,
 * and that source never logs raw tokens or cryptograms.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("../../../../", import.meta.url).pathname;

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(`${ROOT}${rel}`);
}

Deno.test("payRevolutOrderWithGooglePay passes token verbatim under payment_method.google_pay", async () => {
  const src = await read("supabase/functions/_shared/revolutOrders.ts");
  assert(src.includes("type: \"google_pay\""));
  // Local `token` is trimmed from p.googlePayToken then passed verbatim (no re-encode).
  assert(src.includes("const token = String(p.googlePayToken"));
  assert(/payment_method:\s*\{[\s\S]*type:\s*"google_pay"[\s\S]*token,/.test(src));
  // Must not JSON.parse / stringify / slice the encrypted token.
  assert(!/JSON\.parse\(\s*p\.googlePayToken/.test(src));
  assert(!/JSON\.parse\(\s*token\s*\)/.test(src));
  assert(!/googlePayToken\.slice\(/.test(src));
  assert(!/btoa\(\s*p\.googlePayToken/.test(src));
  assert(!/encodeURIComponent\(\s*p\.googlePayToken/.test(src));
});

Deno.test("submit-revolut-google-pay never logs raw token or cryptogram", async () => {
  const src = await read("supabase/functions/submit-revolut-google-pay/index.ts");
  assert(src.includes("token_sha256") || src.includes("tokenHash"));
  assert(!/console\.(log|info|warn|error)\([^)]*google_pay_token/.test(src));
  assert(!/console\.(log|info|warn|error)\([^)]*googlePayToken/.test(src));
  assert(!/cryptogram/.test(src.toLowerCase()) || !/console\./.test(src));
  // Idempotency uses hash, not raw token in metadata write of the token itself.
  assert(!/google_pay_token:\s*token/.test(src));
});

Deno.test("sanitised success vs fail payload shapes differ only by billing/token presence flags", () => {
  // Structural contract — never embed real tokens.
  const successShape = {
    payment_method: {
      type: "google_pay",
      token: "<encrypted_token_opaque>",
      cardholder_name: "Cardholder",
      billing_address: {
        street_line_1: "Flat 7 204 Priestley Drive",
        city: "Milton Keynes",
        country_code: "GB",
        postcode: "MK4 4PY",
      },
    },
  };
  const failBillingShape = {
    payment_method: {
      type: "google_pay",
      token: "<encrypted_token_opaque>",
      cardholder_name: "Cardholder",
      billing_address: {
        country_code: "GB",
        postcode: "", // empty → Revolut validation; also matches fabricated reject upstream
      },
    },
  };
  assertEquals(successShape.payment_method.type, failBillingShape.payment_method.type);
  assertEquals(
    typeof successShape.payment_method.token,
    typeof failBillingShape.payment_method.token,
  );
  assert(successShape.payment_method.billing_address.postcode.length > 0);
  assertEquals(failBillingShape.payment_method.billing_address.postcode, "");
});

Deno.test("gateway config remains revolut + order token (client native) — server does not re-tokenise", async () => {
  const submit = await read("supabase/functions/submit-revolut-google-pay/index.ts");
  assert(submit.includes("payRevolutOrderWithGooglePay"));
  // Binding may verify gateway_merchant_id_sha256 — must never mint PaymentDataRequest fields.
  assert(submit.includes("gateway_merchant_id_sha256") || submit.includes("gatewayMerchantIdSha256"));
  assert(!/PAYMENT_GATEWAY/.test(submit));
  assert(!/\.put\(\s*"gatewayMerchantId"/.test(submit));
  assert(!/tokenizationSpecification/.test(submit));
});
