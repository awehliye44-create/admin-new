/**
 * Lock: setup-revolut-card is the merchant-vault Add Card Edge.
 * Book / create-preauth ALWAYS uses initiator=customer (CIT).
 * saved_for=merchant must NEVER flip Book to MIT.
 *
 * Run: deno test --allow-read supabase/tests/_shared/setupRevolutCardMerchantVaultLock.test.ts
 * NO_PROVIDER_CALL_DURING_TESTS — source + pure draft helpers only.
 */
import {
  resolveSavedCardChargeInitiator,
  mustPresentAcsWhenRevolutRequires,
} from "../../functions/_shared/revolutSavedCardMitMandate.draft.ts";

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

Deno.test("1+2: Book saved-card path ALWAYS CIT — customer-saved and merchant-vault", async () => {
  const PREAUTH_SRC = await readFn("../../functions/_shared/revolutPreauth.ts");
  if (!PREAUTH_SRC.includes('const initiator = "customer"')) {
    throw new Error("attemptRevolutSavedCardCharge must hardcode CIT initiator=customer");
  }
  // Must not select MIT from Revolut saved_for on Book
  if (PREAUTH_SRC.includes('initiator = "merchant"') || PREAUTH_SRC.includes("initiator = 'merchant'")) {
    throw new Error("Book path must never assign initiator=merchant");
  }
  if (PREAUTH_SRC.includes('saved_for') && PREAUTH_SRC.includes('initiator = "merchant"')) {
    throw new Error("saved_for must not drive Book initiator");
  }
  // No list-and-flip based on saved_for in attemptRevolutSavedCardCharge
  const attemptIdx = PREAUTH_SRC.indexOf("async function attemptRevolutSavedCardCharge");
  if (attemptIdx < 0) throw new Error("attemptRevolutSavedCardCharge missing");
  const attemptBody = PREAUTH_SRC.slice(attemptIdx, attemptIdx + 4500);
  if (attemptBody.includes("listRevolutCustomerPaymentMethods")) {
    throw new Error("Book must not list payment methods to choose MIT initiator");
  }
  if (attemptBody.includes('saved_for') && /initiator\s*=\s*["']merchant["']/.test(attemptBody)) {
    throw new Error("saved_for=merchant must not change Book initiator");
  }
});

Deno.test("5+6: Book call graph has NO MIT selection; saved_for cannot change initiator", async () => {
  const PREAUTH_SRC = await readFn("../../functions/_shared/revolutPreauth.ts");
  const ORDERS_SRC = await readFn("../../functions/_shared/revolutOrders.ts");
  if (PREAUTH_SRC.includes("resolveSavedCardChargeInitiator")) {
    throw new Error("Book must not import draft MIT helper");
  }
  if (!ORDERS_SRC.includes('initiator: "customer" | "merchant" = "customer"')) {
    throw new Error("payRevolutOrderWithSavedCard must default initiator to customer");
  }
  // Hard lock: attempt passes const initiator = "customer"
  if (!PREAUTH_SRC.includes("payRevolutOrderWithSavedCard") || !PREAUTH_SRC.includes('const initiator = "customer"')) {
    throw new Error("Book call graph must pass hardcoded customer initiator");
  }
});

Deno.test("3+4: challenge → CUSTOMER_ACTION_REQUIRED; merchant-vault does not guarantee challenge-free", async () => {
  const PREAUTH_SRC = await readFn("../../functions/_shared/revolutPreauth.ts");
  if (!PREAUTH_SRC.includes('kind === "requires_3ds"')) {
    throw new Error("saved-card Book must surface requires_3ds");
  }
  if (!PREAUTH_SRC.includes("authentication_acs_url") || !PREAUTH_SRC.includes("requires_3ds: true")) {
    throw new Error("challenge must return ACS fields for CUSTOMER_ACTION_REQUIRED");
  }
  // No maySkip3ds / skip-3ds on Book path
  if (PREAUTH_SRC.includes("maySkip3ds") || PREAUTH_SRC.includes("skip_3ds") || PREAUTH_SRC.includes("skip3ds")) {
    throw new Error("Book must never skip issuer 3DS");
  }
  if (!mustPresentAcsWhenRevolutRequires("https://acs.example/challenge")) {
    throw new Error("ACS URL must still be presented for merchant-vault credentials");
  }
});

Deno.test("7: Add Card setup has no trip", async () => {
  const SETUP_SRC = await readFn("../../functions/setup-revolut-card/index.ts");
  if (SETUP_SRC.includes("trip_id") || SETUP_SRC.includes("tripId")) {
    throw new Error("Add Card must not attach trip");
  }
});

Deno.test("11: genuine MIT helper stays draft-only / unwired from Book", async () => {
  const PREAUTH_SRC = await readFn("../../functions/_shared/revolutPreauth.ts");
  const DRAFT_SRC = await readFn("../../functions/_shared/revolutSavedCardMitMandate.draft.ts");
  if (/from\s+["'].*revolutSavedCardMitMandate/.test(PREAUTH_SRC) || PREAUTH_SRC.includes("resolveSavedCardChargeInitiator")) {
    throw new Error("MIT draft must not be imported by revolutPreauth");
  }
  if (!DRAFT_SRC.includes("NOT wired into Book") && !DRAFT_SRC.includes("NOT wired into Book / create-preauth")) {
    throw new Error("draft helper must document Book exclusion");
  }
  // Draft still models off-session MIT, but customerPresent locks CIT for Book semantics
  const bookLike = resolveSavedCardChargeInitiator({
    methodSavedFor: "merchant",
    merchantMandateApproved: true,
    customerPresent: true,
  });
  if (bookLike.initiator !== "customer" || bookLike.maySkip3ds) {
    throw new Error(`customerPresent Book semantics must stay CIT, got ${JSON.stringify(bookLike)}`);
  }
  const offSession = resolveSavedCardChargeInitiator({
    methodSavedFor: "merchant",
    merchantMandateApproved: true,
    customerPresent: false,
  });
  if (offSession.initiator !== "merchant") {
    throw new Error("genuine off-session draft path may still resolve MIT (unwired)");
  }
});

Deno.test("typed draft: customer-saved stays CIT; merchant mandate MIT only off-session", () => {
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
    throw new Error(`expected MIT for genuine off-session merchant mandate, got ${JSON.stringify(merchant)}`);
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
    "SAVED_CARD_ALREADY_SAVED",
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

Deno.test("cross-customer complete rejected via ORDER_NOT_FOUND ownership lock", async () => {
  const SETUP_SRC = await readFn("../../functions/setup-revolut-card/index.ts");
  if (!SETUP_SRC.includes("assertSaveCardOwnership") && !SETUP_SRC.includes("metadata.customer_user_id !== user.id")) {
    throw new Error("complete must reject cross-customer order ownership");
  }
  if (!SETUP_SRC.includes('code: "ORDER_NOT_FOUND"')) {
    throw new Error("cross-customer reject must surface ORDER_NOT_FOUND");
  }
  if (!SETUP_SRC.includes('purpose === "save_card"') && !SETUP_SRC.includes("purpose === \"save_card\"")) {
    throw new Error("ownership must require purpose save_card");
  }
});

Deno.test("£1 never captured — manual capture_mode + cancel/void release only", async () => {
  const VAULT_SRC = await readFn("../../functions/_shared/revolutSavedCardVault.ts");
  const SETUP_SRC = await readFn("../../functions/setup-revolut-card/index.ts");
  if (!VAULT_SRC.includes('capture_mode: "manual"')) {
    throw new Error("save-card order must use capture_mode=manual");
  }
  if (!VAULT_SRC.includes("REVOLUT_SAVE_CARD_VERIFICATION_MINOR = 100")) {
    throw new Error("verification amount must be £1 (100 minor)");
  }
  if (!VAULT_SRC.includes('never_capture: "true"')) {
    throw new Error("setup order metadata must mark never_capture");
  }
  if (/\bcaptureRevolutOrder\s*\(/.test(VAULT_SRC) || /\bcaptureRevolutOrder\s*\(/.test(SETUP_SRC)) {
    throw new Error("setup path must never call captureRevolutOrder");
  }
  if (/from\s+["']\.\/revolutOrders\.ts["']/.test(VAULT_SRC) && /captureRevolutOrder/.test(VAULT_SRC.split("from")[0] ?? "")) {
    // import of capture is also forbidden
  }
  if (/import\s*\{[^}]*captureRevolutOrder/.test(VAULT_SRC) || /import\s*\{[^}]*captureRevolutOrder/.test(SETUP_SRC)) {
    throw new Error("setup path must never import captureRevolutOrder");
  }
  if (!VAULT_SRC.includes("cancelRevolutOrder")) {
    throw new Error("release must cancel/void AUTHORISED setup orders");
  }
  if (!SETUP_SRC.includes('action === "cancel"')) {
    throw new Error("setup-revolut-card must support action=cancel to void £1 on fail/timeout");
  }
  if (!SETUP_SRC.includes("releaseSaveCardVerificationOrder")) {
    throw new Error("complete/cancel must release verification hold");
  }
  // COMPLETED must not be accepted as happy-path complete (COMPLETED = captured)
  const completeIdx = SETUP_SRC.indexOf('action === "complete"');
  const readySlice = SETUP_SRC.slice(completeIdx, completeIdx + 4000);
  if (/\[\s*"AUTHORISED"[\s\S]*?"COMPLETED"/.test(readySlice) || readySlice.includes('["AUTHORISED", "COMPLETED"')) {
    throw new Error("complete must not treat COMPLETED (captured) as ready");
  }
});

Deno.test("setup order voided on cancel; resume reuses one setup session", async () => {
  const SETUP_SRC = await readFn("../../functions/setup-revolut-card/index.ts");
  const VAULT_SRC = await readFn("../../functions/_shared/revolutSavedCardVault.ts");
  if (!SETUP_SRC.includes("resume_provider_order_id")) {
    throw new Error("start must accept resume_provider_order_id for app-kill reuse");
  }
  if (!SETUP_SRC.includes("reused: true") && !SETUP_SRC.includes("reused:true")) {
    throw new Error("resume path must return reused:true");
  }
  if (!VAULT_SRC.includes("isReusableSaveCardSetupState")) {
    throw new Error("vault must expose reusable setup state helper");
  }
  if (!SETUP_SRC.includes("voided: true")) {
    throw new Error("cancel must return voided:true");
  }
});

Deno.test("no trip / payment-session booking contamination on setup", async () => {
  const SETUP_SRC = await readFn("../../functions/setup-revolut-card/index.ts");
  if (SETUP_SRC.includes("trip_id") || SETUP_SRC.includes("tripId")) {
    throw new Error("setup must not attach trip");
  }
  if (SETUP_SRC.includes("create-preauth") || SETUP_SRC.includes("payment_sessions")) {
    throw new Error("setup must not create booking payment_sessions / preauth");
  }
  if (SETUP_SRC.includes("wallet") && SETUP_SRC.includes("credit")) {
    throw new Error("setup must not credit wallet");
  }
});

Deno.test("duplicate provider token → no duplicate insert (idempotent already_saved)", async () => {
  const SETUP_SRC = await readFn("../../functions/setup-revolut-card/index.ts");
  if (!SETUP_SRC.includes("SAVED_CARD_ALREADY_SAVED")) {
    throw new Error("duplicate provider PM must return SAVED_CARD_ALREADY_SAVED");
  }
  if (!SETUP_SRC.includes("already_saved: true")) {
    throw new Error("idempotent complete must set already_saved");
  }
  if (!SETUP_SRC.includes("23505") && !SETUP_SRC.includes("isUnique")) {
    throw new Error("insert race must handle unique violation");
  }
});

Deno.test("create-preauth Book path is CIT-hardcoded (no MIT from saved_for)", async () => {
  const PREAUTH_SRC = await readFn("../../functions/_shared/revolutPreauth.ts");
  if (!PREAUTH_SRC.includes('const initiator = "customer"')) {
    throw new Error("create-preauth Book saved-card path must hardcode CIT");
  }
  const SETUP_SRC = await readFn("../../functions/setup-revolut-card/index.ts");
  if (SETUP_SRC.includes("create-preauth") || SETUP_SRC.includes("createPreauth")) {
    throw new Error("setup-revolut-card must not call create-preauth");
  }
});

Deno.test("12: no PAN/CVV in Book saved-card or setup Edge payloads", async () => {
  const PREAUTH_SRC = await readFn("../../functions/_shared/revolutPreauth.ts");
  const SETUP_SRC = await readFn("../../functions/setup-revolut-card/index.ts");
  const payIdx = PREAUTH_SRC.indexOf("payRevolutOrderWithSavedCard");
  const paySlice = payIdx >= 0 ? PREAUTH_SRC.slice(payIdx, payIdx + 800) : "";
  if (/card_number|cvv|cvc|pan\b/i.test(paySlice)) {
    throw new Error("Book saved-card pay must not send PAN/CVV");
  }
  if (/card_number|"cvv"|"cvc"|"pan"/i.test(SETUP_SRC)) {
    throw new Error("setup-revolut-card must not collect PAN/CVV fields");
  }
});
