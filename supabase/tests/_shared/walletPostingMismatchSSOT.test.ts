import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recordWalletPostingFailureMetadata } from "./walletPostingMismatchSSOT.ts";

Deno.test("WALLET_MISMATCH breadcrumb is audit-only and never writes money", async () => {
  const ops: Array<{ table: string; op: string; payload: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      return {
        upsert(payload: Record<string, unknown>) {
          ops.push({ table, op: "upsert", payload });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  await recordWalletPostingFailureMetadata(client as never, {
    tripId: "3a575bad-ce3d-491e-998a-cd83fa5256ea",
    tripCode: "MK-260818-002",
    driverId: "driver-1",
    paymentSessionId: "f999ad09-ef8b-4b11-b69f-84f1735abfdc",
    providerCaptureId: "6a84392c-80fb-ac3c-9a46-3a335dcb16c9",
    expectedDriverCreditPence: 425,
    postedDriverCreditPence: 0,
    failureStage: "settlement_persist",
    errorCode: "PGRST204",
    errorMessage: "Could not find the 'provider_fee_amount' column of 'trips' in the schema cache",
  });
  assertEquals(ops.length, 1);
  assertEquals(ops[0].table, "financial_ssot_mismatches");
  assertEquals(ops[0].payload.field_name, "WALLET_MISMATCH");
  assertEquals(ops[0].payload.expected_pence, 425);
  assertEquals(ops[0].payload.actual_pence, 0);
  const details = ops[0].payload.details as Record<string, unknown>;
  assertEquals(details.status, "WALLET_MISMATCH");
  assertEquals(details.failure_stage, "settlement_persist");
  assertEquals(details.driver_id, "driver-1");
  assertEquals(details.payment_session_id, "f999ad09-ef8b-4b11-b69f-84f1735abfdc");
  assertEquals(details.provider_capture_id, "6a84392c-80fb-ac3c-9a46-3a335dcb16c9");
  assertEquals(typeof details.error, "string");
  assertEquals(ops.some((o) => o.table === "driver_wallet_ledger"), false);
  assertEquals(ops.some((o) => o.table === "payment_sessions"), false);
});
