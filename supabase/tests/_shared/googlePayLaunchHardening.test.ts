/**
 * Google Pay Android launch hardening (P1 / P4 / P5).
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  isDriverCollectedPlatformMethodViolation,
  isPlatformCollectedOnlyPaymentMethod,
  shouldSkipPlatformPreauthForCommissionWallet,
} from "../../functions/_shared/commissionWalletSSOT.ts";
import { isPendingOrderWithoutProviderPayment } from "../../functions/_shared/holdReleasePure.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

// ── P1: driver-collected area cannot create a card / Apple Pay / Google Pay trip ──

Deno.test("P1: platform card/wallet methods are platform-collected only (any casing)", () => {
  for (const m of ["card", "CARD", "saved_card", "new_card", "apple_pay", "APPLE_PAY", "google_pay", "GOOGLE_PAY", " Google_Pay "]) {
    assert(isPlatformCollectedOnlyPaymentMethod(m), `${m} must be platform-collected only`);
  }
  for (const m of ["cash", "CASH", "driver_collects_upfront", "corporate_account", "", null, undefined]) {
    assertEquals(isPlatformCollectedOnlyPaymentMethod(m), false, `${m} is not a platform card/wallet method`);
  }
});

Deno.test("P1: driver-collected area + card/apple_pay/google_pay is a violation; cash is not", () => {
  const driverCollected = shouldSkipPlatformPreauthForCommissionWallet({
    financial_model: "DRIVER_COLLECTED_COMMISSION_WALLET",
    customer_payment_policy: "DRIVER_COLLECTS_UPFRONT",
    commission_wallet_enabled: true,
  });
  assert(driverCollected, "driver-collected area must skip platform preauth");
  assertEquals(
    shouldSkipPlatformPreauthForCommissionWallet({
      financial_model: "PLATFORM_COLLECTED",
      customer_payment_policy: "PLATFORM_PREPAID",
      commission_wallet_enabled: false,
    }),
    false,
    "platform-collected area keeps the Payment Session",
  );

  for (const m of ["card", "apple_pay", "google_pay", "GOOGLE_PAY"]) {
    assert(isDriverCollectedPlatformMethodViolation({ skipPlatformPreauth: true, paymentMethod: m }));
  }
  for (const m of ["cash", "CASH", "driver_collects_upfront"]) {
    assertEquals(isDriverCollectedPlatformMethodViolation({ skipPlatformPreauth: true, paymentMethod: m }), false);
  }
  for (const m of ["card", "apple_pay", "google_pay"]) {
    assertEquals(
      isDriverCollectedPlatformMethodViolation({ skipPlatformPreauth: false, paymentMethod: m }),
      false,
      "platform-collected area must accept card/wallet",
    );
  }
});

Deno.test("P1: create-trip-after-payment rejects the violation with FINANCIAL_MODEL_VIOLATION before any trip write", async () => {
  const src = await read("supabase/functions/create-trip-after-payment/index.ts");
  const guard = src.indexOf("isDriverCollectedPlatformMethodViolation({ skipPlatformPreauth, paymentMethod: body.payment_method })");
  assert(guard > 0, "CTAP must call the driver-collected platform-method guard");
  const skipResolved = src.indexOf("const skipPlatformPreauth = shouldSkipPlatformPreauthForCommissionWallet(");
  assert(skipResolved > 0 && skipResolved < guard, "guard must use the stamped SA financial model");
  const firstTripsAccess = src.indexOf('.from("trips")');
  assert(firstTripsAccess > guard, "guard must reject before any trips read/insert");
  const block = src.slice(guard, guard + 800);
  assert(block.includes('error_code: "FINANCIAL_MODEL_VIOLATION"'), "must reject with FINANCIAL_MODEL_VIOLATION");
  assert(block.includes("status: 409"), "must return 409, never silently drop");
});

// ── P4: Google Pay submit uses the same merchant context as order creation ──

Deno.test("P4: submit-revolut-google-pay resolves merchant via resolveRevolutMerchantContext(live)", async () => {
  const submit = await read("supabase/functions/submit-revolut-google-pay/index.ts");
  assert(
    submit.includes('await resolveRevolutMerchantContext(supabase, "live")'),
    "submit must use vault-first resolveRevolutMerchantContext(supabase, \"live\")",
  );
  assertEquals(submit.includes("getRevolutMerchantConfig"), false, "submit must not use env-only getRevolutMerchantConfig");

  const preauth = await read("supabase/functions/_shared/revolutPreauth.ts");
  assert(preauth.includes("resolveRevolutMerchantContext("), "order creation resolves via resolveRevolutMerchantContext");
  const confirm = await read("supabase/functions/confirm-revolut-payment/index.ts");
  assert(
    confirm.includes('resolveRevolutMerchantContext(supabase, "live")'),
    "confirm of the same order uses the same live merchant context",
  );
});

// ── P5: abandoning a PENDING order with no provider payment succeeds locally ──

Deno.test("P5: pending order with no provider payment is proven hold-free", () => {
  assert(isPendingOrderWithoutProviderPayment({ state: "PENDING" }));
  assert(isPendingOrderWithoutProviderPayment({ state: "pending", payments: [] }));
  assert(isPendingOrderWithoutProviderPayment({ state: "PENDING", payments: [{ state: "DECLINED" }, { state: "failed" }] }));
  assert(isPendingOrderWithoutProviderPayment({ state: "PENDING", payments: [{ state: "SOFT_DECLINED" }, { state: "CANCELLED" }] }));
});

Deno.test("P5: anything that may hold funds is NOT locally abandoned", () => {
  assertEquals(isPendingOrderWithoutProviderPayment(null), false);
  assertEquals(isPendingOrderWithoutProviderPayment({}), false);
  for (const state of ["AUTHORISED", "PROCESSING", "COMPLETED", "CANCELLED", "FAILED", ""]) {
    assertEquals(isPendingOrderWithoutProviderPayment({ state }), false, `${state || "missing"} order state`);
  }
  for (const p of ["AUTHORISED", "AUTHENTICATION_CHALLENGE", "AUTHENTICATION_VERIFIED", "AUTHORISATION_STARTED", "CAPTURED", "PENDING", "", undefined]) {
    assertEquals(
      isPendingOrderWithoutProviderPayment({ state: "PENDING", payments: [{ state: "DECLINED" }, { state: p }] }),
      false,
      `payment state ${p ?? "missing"} may hold funds`,
    );
  }
});

Deno.test("abandon-payment-session boots: every named _shared import is exported by its module", async () => {
  const src = await read("supabase/functions/abandon-payment-session/index.ts");
  const imports = [...src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\.\/_shared\/([^"]+)"/g)];
  assert(imports.length > 0);
  for (const [, names, file] of imports) {
    const mod = await read(`supabase/functions/_shared/${file}`);
    for (const raw of names.split(",")) {
      const name = raw.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      const exported = new RegExp(
        `export\\s+(?:async\\s+)?(?:function|const|let|class|type|interface)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
      ).test(mod);
      assert(exported, `${file} must export ${name} (a missing export is a worker boot error → 503)`);
    }
  }
});

Deno.test("P5: abandon-payment-session returns 200 local abandon only after a same-order read-back", async () => {
  const src = await read("supabase/functions/abandon-payment-session/index.ts");
  const readBack = src.indexOf("async function isPendingOrderWithoutPaymentReadBack(");
  assert(readBack > 0, "read-back helper must exist");
  const helper = src.slice(readBack, readBack + 600);
  assert(helper.includes('resolveRevolutMerchantContext(supabase, "live")'), "read-back uses the same live merchant");
  assert(helper.includes("retrieveRevolutOrder("), "read-back is a GET of the same order");
  assert(helper.includes("isPendingOrderWithoutProviderPayment(order)"), "decision uses the pure helper");
  assert(helper.includes("return false;"), "read-back errors fail closed (no local abandon)");
  assertEquals(/cancelRevolutOrder|increment|capture/i.test(helper), false, "read-back must not mutate the order");

  const pendingBranch = src.indexOf("abandon_pending_");
  const localAbandon = src.indexOf("if (await isPendingOrderWithoutPaymentReadBack(supabase, orderId))");
  const genericFailure = src.indexOf('error: release.error ?? "release_failed"', localAbandon);
  assert(pendingBranch > 0 && localAbandon > pendingBranch, "local abandon lives in the pending-order branch");
  assert(genericFailure > localAbandon, "generic cancel failure still returns 500 afterwards");

  const block = src.slice(localAbandon, genericFailure);
  assert(block.includes("markPaymentSessionAbandoned("), "session is marked abandoned locally");
  assert(block.includes("success: true,"), "local abandon succeeds");
  assert(block.includes('release_status: "abandoned_local_no_provider_payment"'), "distinct release_status label");
  assert(block.includes("hold_safely_released: false"), "receivables are not released on a local abandon");
  assertEquals(block.includes(", 500)"), false, "local abandon must not return 500");
});
