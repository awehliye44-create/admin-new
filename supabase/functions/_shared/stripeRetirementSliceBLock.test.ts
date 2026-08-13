/**
 * Slice B lock — legacy Stripe saved-card Edges undeployed.
 *
 * UNDEPLOYED (no Customer/Driver/admin invoke callers; Revolut replacements live):
 *   setup-card
 *   list-saved-cards
 *   delete-saved-card
 *
 * KEEP (do not touch):
 *   setup-revolut-card
 *   list-revolut-saved-cards
 *   delete-revolut-saved-card
 *
 * SKIP (not dead Stripe):
 *   create-payment-intent — already Revolut-rewritten; Customer uses create-preauth-payment-intent
 *
 * Baseline: MK-260813-004 post-P0 Revolut smoke (do not mutate).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("..", import.meta.url).pathname;

const UNDEPLOYED_STRIPE_SAVED_CARD = [
  "setup-card",
  "list-saved-cards",
  "delete-saved-card",
] as const;

const REVOLUT_SAVED_CARD_REPLACEMENTS = [
  "setup-revolut-card",
  "list-revolut-saved-cards",
  "delete-revolut-saved-card",
] as const;

Deno.test("Slice B: no local Stripe saved-card Edge sources remain to rewrite", () => {
  for (const slug of UNDEPLOYED_STRIPE_SAVED_CARD) {
    let exists = false;
    try {
      Deno.statSync(`${ROOT}/${slug}/index.ts`);
      exists = true;
    } catch {
      exists = false;
    }
    assertEquals(
      exists,
      false,
      `${slug} must stay undeployed/absent — do not rewrite Stripe into Revolut`,
    );
  }
});

Deno.test("Slice B: Revolut saved-card Edge sources remain present", () => {
  // setup-revolut-card lives in admin-new; list/delete may be Customer-repo only.
  const setup = Deno.readTextFileSync(`${ROOT}/setup-revolut-card/index.ts`);
  assertEquals(setup.length > 0, true);
  assertEquals(setup.includes("STRIPE_SECRET_KEY"), false);
  assertEquals(setup.includes("new Stripe"), false);
});

Deno.test("Slice B inventory documents undeployed + kept names", () => {
  assertEquals(UNDEPLOYED_STRIPE_SAVED_CARD.length, 3);
  assertEquals(REVOLUT_SAVED_CARD_REPLACEMENTS.includes("setup-revolut-card"), true);
});
