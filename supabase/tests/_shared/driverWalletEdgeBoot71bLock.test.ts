/**
 * #71B — Edge boot / dependency packaging lock for Driver Wallet Ledger.
 * Circular imports that crash module init cause OPTIONS 500 and the Admin UI
 * error "Failed to send a request to the Edge Function".
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("#71B admin-driver-wallet-ssot dependency graph boots", async () => {
  const snapshot = await import("../../functions/_shared/fetchDriverWalletPayoutSnapshot.ts");
  const monitoring = await import("./offline/driverCreditMonitoringSSOT.ts");
  const fr = await import("./offline/frDriverReconciliationSSOT.ts");
  assertEquals(typeof snapshot.fetchDriverWalletPayoutSnapshot, "function");
  assertEquals(typeof monitoring.classifyDriverCreditHealth, "function");
  assertEquals(monitoring.TRIP_ENTITLEMENT_LEDGER_TYPES.has("BONUS"), false);
  assertEquals(fr.FR_TRIP_ENTITLEMENT_CREDIT_TYPES.has("BONUS"), false);
  assertEquals(
    [...monitoring.TRIP_ENTITLEMENT_LEDGER_TYPES].sort().join(","),
    [...fr.FR_TRIP_ENTITLEMENT_CREDIT_TYPES].sort().join(","),
  );
});

Deno.test("#71B monitoring must not import frDriverReconciliationSSOT (cycle)", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/_shared/driverCreditMonitoringSSOT.ts", import.meta.url),
  );
  assertEquals(/from\s+["']\.\/frDriverReconciliationSSOT\.ts["']/.test(src), false);
  assertEquals(/import\s*\{[^}]*FR_TRIP_ENTITLEMENT_CREDIT_TYPES/.test(src), false);
});
