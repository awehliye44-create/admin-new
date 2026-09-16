/**
 * Import-graph lock: perDriverFinancialReconciliation must locally bind
 * computeNextWeeklyPayoutRun (not only re-export) so FR driver_id path boots.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("F3 import-graph lock — local import of computeNextWeeklyPayoutRun", async () => {
  const src = await Deno.readTextFile(
    new URL("./perDriverFinancialReconciliation.ts", import.meta.url),
  );
  assertStringIncludes(src, 'from "./payoutScheduleSSOT.ts"');
  assertStringIncludes(src, "computeNextWeeklyPayoutRun");
  const hasLocalImport = /import\s*\{[\s\S]*?computeNextWeeklyPayoutRun[\s\S]*?\}\s*from\s*"\.\/payoutScheduleSSOT\.ts"/.test(
    src,
  );
  assertEquals(hasLocalImport, true);

  const settlement = await Deno.readTextFile(
    new URL("./financeSettlementSummary.ts", import.meta.url),
  );
  assertStringIncludes(settlement, "Component basis only");
  // classifyDriverCreditHealth must receive fare-net component, not entitlement aggregate.
  const start = settlement.indexOf("classifyDriverCreditHealth({");
  assertEquals(start >= 0, true);
  const classifyBlock = settlement.slice(start, start + 900);
  assertEquals(/driver_net_pence:\s*expectedDriverNet/.test(classifyBlock), false);
  assertStringIncludes(classifyBlock, "row.driver_net_pence");
});
