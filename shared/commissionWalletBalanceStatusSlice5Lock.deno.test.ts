/**
 * Slice 5 — Commission Wallet admin overview balance_status labels.
 * Run: deno test --allow-read --no-check shared/commissionWalletBalanceStatusSlice5Lock.deno.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveCommissionWalletBalanceStatus } from "./commissionWalletSSOT.ts";

Deno.test("Slice5: minimum>0 → insufficient / low / sufficient bands", () => {
  assertEquals(
    resolveCommissionWalletBalanceStatus({ balanceMinor: 999, minimumBalanceMinor: 1000 }),
    "insufficient",
  );
  assertEquals(
    resolveCommissionWalletBalanceStatus({ balanceMinor: 1000, minimumBalanceMinor: 1000 }),
    "low",
  );
  assertEquals(
    resolveCommissionWalletBalanceStatus({ balanceMinor: 1999, minimumBalanceMinor: 1000 }),
    "low",
  );
  assertEquals(
    resolveCommissionWalletBalanceStatus({ balanceMinor: 2000, minimumBalanceMinor: 1000 }),
    "sufficient",
  );
});

Deno.test("Slice5: minimum=0 → <=0 insufficient; <500 low; else sufficient", () => {
  assertEquals(
    resolveCommissionWalletBalanceStatus({ balanceMinor: 0, minimumBalanceMinor: 0 }),
    "insufficient",
  );
  assertEquals(
    resolveCommissionWalletBalanceStatus({ balanceMinor: 499, minimumBalanceMinor: 0 }),
    "low",
  );
  assertEquals(
    resolveCommissionWalletBalanceStatus({ balanceMinor: 500, minimumBalanceMinor: 0 }),
    "sufficient",
  );
});

Deno.test("Slice5 lock: overview + UI wire balance_status; shared re-exports _shared", () => {
  const overview = Deno.readTextFileSync(
    new URL("../supabase/functions/admin-commission-wallet-overview/index.ts", import.meta.url),
  );
  const ui = Deno.readTextFileSync(
    new URL("../src/pages/CommissionWallet.tsx", import.meta.url),
  );
  const front = Deno.readTextFileSync(new URL("./commissionWalletSSOT.ts", import.meta.url));
  const shared = Deno.readTextFileSync(
    new URL("../supabase/functions/_shared/commissionWalletSSOT.ts", import.meta.url),
  );
  assertEquals(overview.includes("resolveCommissionWalletBalanceStatus"), true);
  assertEquals(overview.includes("balance_status"), true);
  assertEquals(ui.includes("resolveCommissionWalletBalanceStatus"), true);
  assertEquals(ui.includes("Sufficient balance"), true);
  assertEquals(front.includes('export * from "../supabase/functions/_shared/commissionWalletSSOT.ts"'), true);
  assertEquals(shared.includes("export function resolveCommissionWalletBalanceStatus"), true);
  // Dual-SSOT body must not replace the frontend re-export.
  assertEquals(front.includes("P0 — Africa Driver Commission Wallet SSOT"), false);
});
