/**
 * deno test --allow-read supabase/tests/_shared/payoutItemProviderEvidenceSSOT.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PAYOUT_WALLET_SNAPSHOT_LABEL,
  planPayoutItemProviderFieldSync,
  resolvePayoutItemProviderEvidenceForDisplay,
} from "../../functions/_shared/payoutItemProviderEvidenceSSOT.ts";

Deno.test("display falls back to payment intent when item provider fields are empty", () => {
  const resolved = resolvePayoutItemProviderEvidenceForDisplay({
    item: {
      provider_payout_id: null,
      provider_transfer_id: null,
      provider_reference: null,
      provider_status: null,
    },
    intent: {
      provider_payment_id: "056b68d7-590f-e38e-0040-623b2678d1eb",
      provider_state: "completed",
      execution_status: "COMPLETED",
    },
  });
  assertEquals(resolved.provider_evidence_source, "payment_intent");
  assertEquals(resolved.provider_payout_id, "056b68d7-590f-e38e-0040-623b2678d1eb");
  assertEquals(resolved.provider_status, "completed");
});

Deno.test("display prefers item provider fields when present", () => {
  const resolved = resolvePayoutItemProviderEvidenceForDisplay({
    item: {
      provider_payout_id: "item-id",
      provider_status: "completed",
    },
    intent: {
      provider_payment_id: "intent-id",
      provider_state: "failed",
    },
  });
  assertEquals(resolved.provider_evidence_source, "payout_item");
  assertEquals(resolved.provider_payout_id, "item-id");
  assertEquals(resolved.provider_status, "completed");
});

Deno.test("forward sync fills empty item provider fields on successful completion", () => {
  const patch = planPayoutItemProviderFieldSync({
    item: { provider_payout_id: null, provider_status: null },
    provider_payment_id: "pay-1",
    provider_state: "completed",
  });
  assertEquals(patch, { provider_payout_id: "pay-1", provider_status: "completed" });
});

Deno.test("forward sync is idempotent when already synced", () => {
  const patch = planPayoutItemProviderFieldSync({
    item: { provider_payout_id: "pay-1", provider_status: "completed" },
    provider_payment_id: "pay-1",
    provider_state: "completed",
  });
  assertEquals(patch, null);
});

Deno.test("forward sync never overwrites a conflicting provider id", () => {
  const patch = planPayoutItemProviderFieldSync({
    item: { provider_payout_id: "other-id", provider_status: "completed" },
    provider_payment_id: "pay-1",
    provider_state: "completed",
  });
  assertEquals(patch, null);
});

Deno.test("forward sync never overwrites a terminal failure with completed", () => {
  const patch = planPayoutItemProviderFieldSync({
    item: { provider_payout_id: "pay-1", provider_status: "failed" },
    provider_payment_id: "pay-1",
    provider_state: "completed",
  });
  assertEquals(patch, null);
});

Deno.test("snapshot labels distinguish preparation from current live", () => {
  assertEquals(
    PAYOUT_WALLET_SNAPSHOT_LABEL.balance_at_preparation,
    "Balance at payout preparation",
  );
  assertEquals(
    PAYOUT_WALLET_SNAPSHOT_LABEL.current_live,
    "Current live Driver Wallet balance",
  );
});
