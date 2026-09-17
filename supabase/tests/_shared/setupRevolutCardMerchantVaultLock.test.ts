/**
 * Lock: setup-revolut-card is the merchant-vault Add Card Edge.
 * Book / create-preauth must not force initiator=merchant unless Revolut
 * payment method saved_for === "merchant".
 *
 * Run: deno test --allow-read supabase/tests/_shared/setupRevolutCardMerchantVaultLock.test.ts
 * NO_PROVIDER_CALL_DURING_TESTS — source + pure draft helpers only.
 */
import { resolveSavedCardChargeInitiator } from "../../functions/_shared/revolutSavedCardMitMandate.draft.ts";

async function readFn(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, import.meta.url));
}

Deno.test("setup-revolut-card documents merchant vault (no trip)", async () => {
  const SETUP_SRC = await readFn("../../functions/setup-revolut-card/index.ts");
  if (!SETUP_SRC.includes("Merchant-vault Add Card")) {
    throw new Error("setup-revolut-card header must document merchant vault");
  }
  if (!SETUP_SRC.includes('action === "complete"')) {
    throw new Error("setup-revolut-card must support action=complete");
  }
  if (!SETUP_SRC.includes("idempotency_key") || !SETUP_SRC.includes("setupRef")) {
    throw new Error("setup-revolut-card must use dedicated idempotency / setupRef");
  }
  if (SETUP_SRC.includes("trip_id") || SETUP_SRC.includes("tripId")) {
    throw new Error("setup-revolut-card must not attach a trip");
  }
  if (!SETUP_SRC.includes("createRevolutSaveCardSetupOrder")) {
    throw new Error("setup-revolut-card must create a dedicated save-card order");
  }
});

Deno.test("save-card vault order uses merchant_order_ext_ref save-card-*", async () => {
  const VAULT_SRC = await readFn("../../functions/_shared/revolutSavedCardVault.ts");
  if (!VAULT_SRC.includes("save-card-")) {
    throw new Error("vault setup order must use save-card merchant_order_ext_ref");
  }
  if (!VAULT_SRC.includes('purpose: "save_card"')) {
    throw new Error("vault setup order must mark purpose save_card");
  }
});

Deno.test("create-preauth initiator defaults customer; merchant only when saved_for===merchant", async () => {
  const PREAUTH_SRC = await readFn("../../functions/_shared/revolutPreauth.ts");
  if (!PREAUTH_SRC.includes('let initiator: "customer" | "merchant" = "customer"')) {
    throw new Error("preauth must default initiator to customer (CIT)");
  }
  if (!PREAUTH_SRC.includes("saved_for") || !PREAUTH_SRC.includes('"merchant"')) {
    throw new Error("preauth must gate MIT on Revolut saved_for===merchant");
  }
});

Deno.test("typed draft: customer-saved stays CIT; merchant mandate is MIT-only path", () => {
  const customer = resolveSavedCardChargeInitiator({
    methodSavedFor: "customer",
    merchantMandateApproved: true,
  });
  if (customer.initiator !== "customer" || customer.maySkip3ds) {
    throw new Error(`expected CIT for customer-saved, got ${JSON.stringify(customer)}`);
  }
  const merchant = resolveSavedCardChargeInitiator({
    methodSavedFor: "merchant",
    merchantMandateApproved: true,
  });
  if (merchant.initiator !== "merchant" || !merchant.maySkip3ds) {
    throw new Error(`expected MIT for merchant-saved, got ${JSON.stringify(merchant)}`);
  }
  const noMandate = resolveSavedCardChargeInitiator({
    methodSavedFor: "merchant",
    merchantMandateApproved: false,
  });
  if (noMandate.initiator !== "customer") {
    throw new Error("without merchantMandateApproved must stay customer");
  }
});

Deno.test("setup-revolut-card returns typed error codes (ownership / cap / auth)", async () => {
  const SETUP_SRC = await readFn("../../functions/setup-revolut-card/index.ts");
  for (const code of [
    "AUTH_MISSING",
    "AUTH_INVALID",
    "ORDER_NOT_FOUND",
    "SAVED_CARD_LIMIT_REACHED",
    "SAVED_CARD_NOT_FOUND",
    "CUSTOMER_NOT_FOUND",
  ]) {
    if (!SETUP_SRC.includes(`"${code}"`)) {
      throw new Error(`setup-revolut-card missing typed code ${code}`);
    }
  }
  if (!SETUP_SRC.includes("customer_user_id") || !SETUP_SRC.includes("user.id")) {
    throw new Error("setup complete must enforce order ownership");
  }
});
