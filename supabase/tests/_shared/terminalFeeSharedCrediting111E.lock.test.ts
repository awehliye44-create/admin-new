/**
 * #111E LOCK — terminal-fee TEN persistence reuses creditCapturedCardTripLedger
 * (canonical normal-trip writer). Eligibility/formula/category remain terminal-specific.
 */
import { assertStringIncludes } from "jsr:@std/assert@1";

const ROOT = new URL("../../", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, ROOT));
}

Deno.test("#111E terminal entitlement posts via creditCapturedCardTripLedger", async () => {
  const entitlement = await read("functions/_shared/terminalOutcomeEntitlementSSOT.ts");
  assertStringIncludes(entitlement, 'from "./onecabFinanceLedger.ts"');
  assertStringIncludes(entitlement, "creditCapturedCardTripLedger");
  assertStringIncludes(entitlement, "skipTipAndDebtRecovery: true");
  assertStringIncludes(entitlement, "buildTerminalFeeLedgerMetadata");
  // Must not keep a parallel raw insert path for TEN.
  const insertIdx = entitlement.indexOf("postTerminalEntitlementFromSettlement");
  const fnBody = entitlement.slice(insertIdx);
  const rawInsert = fnBody.includes('from("driver_wallet_ledger").insert');
  if (rawInsert) {
    throw new Error(
      "postTerminalEntitlementFromSettlement must not raw-insert TRIP_EARNING_NET",
    );
  }
});

Deno.test("#111E canonical ledger writer accepts terminal description/metadata", async () => {
  const ledger = await read("functions/_shared/onecabFinanceLedger.ts");
  assertStringIncludes(ledger, "skipTipAndDebtRecovery");
  assertStringIncludes(ledger, "description?: string | null");
  assertStringIncludes(ledger, "metadata?: Record<string, unknown> | null");
});
