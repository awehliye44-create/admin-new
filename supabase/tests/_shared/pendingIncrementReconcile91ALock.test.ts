/**
 * #91A — PENDING PSA must reconcile from provider evidence without new money moves.
 * MK-261125-002: completion increment left ADDITIONAL_AUTHORISATION_PENDING while
 * Revolut later authorised + captured 935p.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decidePendingIncrementReconcile } from "../../functions/_shared/reconcilePendingIncrementAuthorisationSSOT.ts";

Deno.test("#91A confirmed authorised increment flips PENDING → confirmed", () => {
  const d = decidePendingIncrementReconcile({
    rowStatus: "ADDITIONAL_AUTHORISATION_PENDING",
    requestedTargetTotalPence: 935,
    order: {
      id: "ord",
      state: "AUTHORISED",
      incremental_authorisations: [
        { state: "authorised", new_amount: 903 },
        { state: "authorised", new_amount: 935 },
      ],
      payments: [{ state: "AUTHORISED", authorised_amount: 935, amount: 935 }],
    } as any,
  });
  assertEquals(d.action, "confirmed");
  assertEquals(d.confirmedTotalPence >= 935, true);
});

Deno.test("#91A COMPLETED capture covering target confirms even if increment was processing", () => {
  const d = decidePendingIncrementReconcile({
    rowStatus: "ADDITIONAL_AUTHORISATION_PENDING",
    requestedTargetTotalPence: 935,
    order: {
      id: "ord",
      state: "COMPLETED",
      amount: 935,
      incremental_authorisations: [
        { state: "authorised", new_amount: 903 },
        { state: "authorised", new_amount: 935 },
      ],
      payments: [{
        state: "captured",
        amount: 935,
        authorised_amount: 935,
      }],
    } as any,
  });
  assertEquals(d.action, "confirmed");
});

Deno.test("#91A declined provider increment marks declined — never confirmed", () => {
  const d = decidePendingIncrementReconcile({
    rowStatus: "ADDITIONAL_AUTHORISATION_PENDING",
    requestedTargetTotalPence: 1448,
    order: {
      id: "ord",
      state: "CANCELLED",
      incremental_authorisations: [{ state: "declined", new_amount: 1448 }],
      payments: [{ state: "cancelled", authorised_amount: 680, amount: 680 }],
    } as any,
  });
  assertEquals(d.action, "declined");
});

Deno.test("#91A failed provider increment marks failed_terminal", () => {
  const d = decidePendingIncrementReconcile({
    rowStatus: "ADDITIONAL_AUTHORISATION_PENDING",
    requestedTargetTotalPence: 1546,
    order: {
      id: "ord",
      state: "AUTHORISED",
      incremental_authorisations: [{ state: "failed", new_amount: 1546 }],
      payments: [{ state: "AUTHORISED", authorised_amount: 728, amount: 728 }],
    } as any,
  });
  assertEquals(d.action, "failed_terminal");
});

Deno.test("#91A still-processing leaves pending", () => {
  const d = decidePendingIncrementReconcile({
    rowStatus: "ADDITIONAL_AUTHORISATION_PENDING",
    requestedTargetTotalPence: 935,
    order: {
      id: "ord",
      state: "AUTHORISED",
      incremental_authorisations: [{ state: "processing", new_amount: 935 }],
      payments: [{ state: "AUTHORISED", authorised_amount: 903, amount: 903 }],
    } as any,
  });
  assertEquals(d.action, "left_pending");
});

Deno.test("#91A already confirmed is idempotent", () => {
  const d = decidePendingIncrementReconcile({
    rowStatus: "ADDITIONAL_AUTHORISATION_CONFIRMED",
    requestedTargetTotalPence: 935,
    order: { id: "ord", state: "COMPLETED" } as any,
  });
  assertEquals(d.action, "already_confirmed");
});

Deno.test("#91A capture below target does not invent confirmation", () => {
  const d = decidePendingIncrementReconcile({
    rowStatus: "ADDITIONAL_AUTHORISATION_PENDING",
    requestedTargetTotalPence: 674,
    order: {
      id: "ord",
      state: "COMPLETED",
      amount: 610,
      incremental_authorisations: [{ state: "failed", new_amount: 674 }],
      payments: [{ state: "captured", amount: 610, authorised_amount: 610 }],
    } as any,
  });
  assertEquals(d.action === "confirmed", false);
});

Deno.test("#91A sources wired: completion + sweep, no increment POST change", async () => {
  const completion = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertStringIncludes(completion, "reconcilePendingIncrementAuthorisationsFromProvider");
  assertStringIncludes(completion, "pending_increment_reconcile");

  const sweep = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assertStringIncludes(sweep, "reconcilePendingIncrementAuthorisationsFromProvider");
  assertStringIncludes(sweep, "pending_increment_reconcile");
  assertStringIncludes(sweep, "reconcileAuthorisationProjectionsBatch");
  assertStringIncludes(sweep, "auth_projection_reconcile_103");

  // #103: reconcile must not promote live total into original hold.
  const reconcileSrc = await Deno.readTextFile(
    new URL("../../functions/_shared/reconcilePendingIncrementAuthorisationSSOT.ts", import.meta.url),
  );
  assertEquals(/authorised_amount_pence:\s*Math\.max\(/.test(reconcileSrc), false);

  const orders = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutOrders.ts", import.meta.url),
  );
  assertStringIncludes(orders, "const body: Record<string, unknown> = { amount: target };");
  assertEquals(orders.includes("amount: target - previous"), false);
});

Deno.test("#91A preserve #89/#90/#91 capture + increment safeguards", async () => {
  const completion = await Deno.readTextFile(
    new URL("../../functions/_shared/revolutCompletionCapture.ts", import.meta.url),
  );
  assertStringIncludes(completion, "resolveProviderConfirmedCapturePence");
  assertStringIncludes(completion, "preferSameOrderIncrement: true");
  assertStringIncludes(completion, "reclaimExpiredPaymentSessionFinancialLock");

  const lock91 = await Deno.readTextFile(
    new URL("./successfulIncrementalAuthorisation91Lock.test.ts", import.meta.url),
  );
  assertStringIncludes(lock91, "REVOLUT_INCREMENT_API_VERSION");
});
