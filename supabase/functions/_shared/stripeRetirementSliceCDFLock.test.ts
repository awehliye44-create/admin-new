/**
 * Slice C/D/F lock — orphan Stripe Connect / wallet / probe Edges undeployed.
 *
 * UNDEPLOYED:
 *   Slice C: driver-wallet-summary, driver-change-payout-destination
 *   Slice D: admin-connect-payout-status, admin-connect-payout-lockdown,
 *            admin-driver-connect-payout (+ orphan admin-driver-payout)
 *   Slice F: phase-3d3a-future-payout-probe, admin-monday-payout-diagnostics,
 *            admin-live-payout-v2-validation
 *
 * SKIP (still ACTIVE — do not force):
 *   driver-early-cashout (CRITICAL Stripe Connect cashout)
 *   update-driver-payout-destination (live UK-bank path)
 *   driver-payout-settings (live Driver GET; Stripe UI branch strip deferred —
 *     needs recovered local source + Driver smoke)
 *   Slice E recovery/reconcile edges (cron and/or ops-critical)
 *
 * Baselines: MK-260813-003, MK-260813-004 — do not mutate.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("..", import.meta.url).pathname;

const UNDEPLOYED = [
  "driver-wallet-summary",
  "driver-change-payout-destination",
  "admin-connect-payout-status",
  "admin-connect-payout-lockdown",
  "admin-driver-connect-payout",
  "admin-driver-payout",
  "phase-3d3a-future-payout-probe",
  "admin-monday-payout-diagnostics",
  "admin-live-payout-v2-validation",
] as const;

Deno.test("Slice C/D/F: undeployed orphan Edges have no local sources to rewrite", () => {
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

Deno.test("config.toml no longer declares undeployed Connect/probe Edges", () => {
  const config = Deno.readTextFileSync(`${ROOT}/../config.toml`);
  for (const slug of [
    "admin-connect-payout-status",
    "admin-connect-payout-lockdown",
    "admin-driver-connect-payout",
    "admin-monday-payout-diagnostics",
    "admin-driver-payout",
    "stripe-onboard-driver",
  ]) {
    assertEquals(
      config.includes(`[functions.${slug}]`),
      false,
      `config.toml must not declare [functions.${slug}]`,
    );
  }
});
