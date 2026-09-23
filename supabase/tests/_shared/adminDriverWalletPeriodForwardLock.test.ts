/**
 * Lock: Admin Driver Wallet Ledger must forward selected from/to to SSOT.
 * Silent lifetime fallback under a period label caused MK0006 false badges.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../../", import.meta.url).pathname;

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(`${root}${rel}`);
}

Deno.test("DriverWalletDriverList accepts and passes periodFrom/periodTo into useDriverWalletSsot", async () => {
  const src = await read("src/components/finance/DriverWalletDriverList.tsx");
  assert(src.includes("periodFrom"));
  assert(src.includes("periodTo"));
  assert(/useDriverWalletSsot\(\{[\s\S]*periodFrom[\s\S]*periodTo/.test(src));
});

Deno.test("DriverWalletFleetOverviewCards forwards period into useDriverWalletSsotAll", async () => {
  const src = await read("src/components/finance/DriverWalletFleetOverviewCards.tsx");
  assert(src.includes("periodFrom"));
  assert(src.includes("periodTo"));
  assert(/useDriverWalletSsotAll\(\s*regionId\s*,\s*\{\s*periodFrom\s*,\s*periodTo\s*\}/.test(src));
});

Deno.test("DriverWalletLedger wires periodBounds into list, fleet, and detail", async () => {
  const src = await read("src/pages/DriverWalletLedger.tsx");
  assert(/useDriverWalletSsotDetail\(\s*driverId\s*,\s*\{\s*periodFrom:\s*periodBounds\.from/.test(src));
  assert(src.includes("periodFrom={periodBounds.from || null}"));
  assert(src.includes("periodTo={periodBounds.to || null}"));
});

Deno.test("useDriverWalletSsot includes from/to in invoke body when period set", async () => {
  const src = await read("src/hooks/useDriverWalletSsot.ts");
  assert(src.includes("...(periodFrom ? { from: periodFrom } : {})"));
  assert(src.includes("...(periodTo ? { to: periodTo } : {})"));
  assert(src.includes("fetchAllDriverWalletSsotPages(regionId ?? null, periodFrom, periodTo)"));
});
