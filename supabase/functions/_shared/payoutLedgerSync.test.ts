import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ledgerTypeForBatchKind,
  payoutDescriptionForType,
} from "./payoutLedgerSync.ts";

Deno.test("ledgerTypeForBatchKind maps weekly and manual", () => {
  assertEquals(ledgerTypeForBatchKind("WEEKLY_MONDAY"), "WEEKLY_PAYOUT");
  assertEquals(ledgerTypeForBatchKind("MANUAL_ADMIN"), "MANUAL_PAYOUT");
  assertEquals(ledgerTypeForBatchKind("EARLY_CASHOUT"), "EARLY_CASHOUT");
});

Deno.test("weekly payout description", () => {
  assertEquals(payoutDescriptionForType("WEEKLY_PAYOUT"), "Weekly payout to bank");
});
