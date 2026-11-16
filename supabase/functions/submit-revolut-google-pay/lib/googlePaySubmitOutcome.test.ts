import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyGooglePaySubmitFailure,
  readRevolutApiThrow,
} from "./googlePaySubmitOutcome.ts";

Deno.test("readRevolutApiThrow extracts plain Merchant API throws", () => {
  assertEquals(
    readRevolutApiThrow({ message: "postcode is empty", status: 400 }),
    { message: "postcode is empty", status: 400 },
  );
  assertEquals(readRevolutApiThrow(new Error("boom")).message, "boom");
  assertEquals(readRevolutApiThrow("x"), { message: "pay_failed", status: null });
});

Deno.test("classifyGooglePaySubmitFailure maps Revolut 4xx to definitive 400", () => {
  const out = classifyGooglePaySubmitFailure({
    declineReason: null,
    providerRejected: false,
    revolutHttpStatus: 400,
  });
  assertEquals(out.status, 400);
  assertEquals(out.code, "GOOGLE_PAY_SUBMIT_FAILED");
});

Deno.test("classifyGooglePaySubmitFailure keeps 502 for unknown transport failures", () => {
  const out = classifyGooglePaySubmitFailure({
    declineReason: null,
    providerRejected: false,
    revolutHttpStatus: null,
  });
  assertEquals(out.status, 502);
  assertEquals(out.code, "GOOGLE_PAY_SUBMIT_FAILED");
});
