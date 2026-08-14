/**
 * Safe Stripe-retirement batches 1–3 lock — dead / ghost / cron Edges undeployed.
 *
 * BATCH 1 undeployed (no live callers; no Revolut rewrite):
 *   initiate-mobile-wallet-booking, quote-ride, setup-revolut-save-card,
 *   create-wallet-topup, finance-reconciliation-driver, payment-reconcile,
 *   ops-backfill-trip-settlement, recover-orphan-payment,
 *   switch-trip-payment-method, admin-edit-trip-fare
 *
 * BATCH 2 ghosts undeployed (ACTIVE metadata, body store 404, no callers):
 *   create-trip-after-wallet, customer-complete-registration, get-maps-key,
 *   handle-cash-trip-commission, payment-client-config
 *
 * BATCH 3 cron + Edge undeployed (after ZERO deferred Stripe rows):
 *   sweep-stale-payment-intents (+ cron sweep-stale-payment-intents-every-5min)
 *   scheduled-payment-reauth (+ cron scheduled-payment-reauth-every-30min)
 * Revolut replacement cron kept: sweep-revolut-stale-holds-every-5min
 *
 * Baselines: MK-260813-003, MK-260813-004 — do not mutate.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("..", import.meta.url).pathname;

const UNDEPLOYED = [
  "initiate-mobile-wallet-booking",
  "quote-ride",
  "setup-revolut-save-card",
  "create-wallet-topup",
  "finance-reconciliation-driver",
  "payment-reconcile",
  "ops-backfill-trip-settlement",
  "recover-orphan-payment",
  "switch-trip-payment-method",
  "admin-edit-trip-fare",
  "create-trip-after-wallet",
  "customer-complete-registration",
  "get-maps-key",
  "handle-cash-trip-commission",
  "payment-client-config",
  "sweep-stale-payment-intents",
  "scheduled-payment-reauth",
  "confirm-trip-payment",
] as const;

Deno.test("Batches 1–3: undeployed Stripe-legacy Edges have no local sources to rewrite", () => {
  for (const slug of UNDEPLOYED) {
    let exists = false;
    try {
      Deno.statSync(`${ROOT}/${slug}/index.ts`);
      exists = true;
    } catch {
      exists = false;
    }
    assertEquals(exists, false, `${slug} must stay undeployed/absent`);
  }
});

Deno.test("Batch 3: Stripe cron Edge names stay absent locally (Revolut cron is DB-only)", () => {
  for (const slug of ["sweep-stale-payment-intents", "scheduled-payment-reauth"] as const) {
    let exists = false;
    try {
      Deno.statSync(`${ROOT}/${slug}/index.ts`);
      exists = true;
    } catch {
      exists = false;
    }
    assertEquals(exists, false, `${slug} must remain undeployed`);
  }
});
