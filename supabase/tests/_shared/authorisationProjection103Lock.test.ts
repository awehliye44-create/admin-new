/**
 * #93A / #103 — Authorisation projection semantic lock.
 *
 * Run:
 *   deno test -A supabase/tests/_shared/authorisationProjection103Lock.test.ts
 */
import {
  assertEquals,
  assertFalse,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAuthorisationMirrorPatch,
  classifyAuthorisationProjection,
  expectedResidualFromCoveragePence,
  mayWriteOriginalAuthorisedAmount,
  resolveInitialAuthorisedHoldPence,
  resolveLocalConfirmedCoveragePence,
  resolveSessionAuthorisedCoveragePence,
} from "./offline/authorisationProjectionSSOT.ts";
import {
  expectedResidualReleasePenceForRow,
  sumExpectedResidualReleasePence,
} from "../../../shared/edgePresentation/paymentSessionsDisplaySSOT.ts";

Deno.test("#103 MK-009 shape: original 700 / total 800 / capture 800", () => {
  const row = {
    authorised_amount_pence: 700,
    original_authorised_pence: 700,
    total_authorised_amount_pence: 800,
  };
  assertEquals(resolveInitialAuthorisedHoldPence(row), 700);
  assertEquals(resolveLocalConfirmedCoveragePence(row), 800);
  assertEquals(
    resolveSessionAuthorisedCoveragePence({
      ...row,
      providerConfirmedAuthorisedPence: 800,
      providerAuthKnown: true,
    }).coveragePence,
    800,
  );
  assertEquals(
    expectedResidualFromCoveragePence({ coveragePence: 800, capturedPence: 800 }),
    null,
  );
  assertEquals(
    expectedResidualReleasePenceForRow({
      ...row,
      captured_amount_pence: 800,
    }),
    null,
  );
  assertEquals(
    classifyAuthorisationProjection({
      ...row,
      psaConfirmedTotalPence: 800,
      confirmedIncrementCount: 1,
    }),
    "original_intact",
  );
});

Deno.test("#103 residual uses total not original when capture between them", () => {
  const row = {
    authorised_amount_pence: 700,
    total_authorised_amount_pence: 800,
    captured_amount_pence: 750,
    provider_state: "COMPLETED",
  };
  // Old bug: authorised-only residual would be null (700 <= 750).
  assertEquals(expectedResidualReleasePenceForRow(row), 50);
  assertEquals(
    sumExpectedResidualReleasePence([row]),
    50,
  );
});

Deno.test("#103 sequential increments: original intact, coverage advances", () => {
  const afterFirst = {
    authorised_amount_pence: 500,
    original_authorised_pence: 500,
    total_authorised_amount_pence: 570,
  };
  assertEquals(resolveInitialAuthorisedHoldPence(afterFirst), 500);
  assertEquals(resolveLocalConfirmedCoveragePence(afterFirst), 570);

  const afterSecond = {
    ...afterFirst,
    total_authorised_amount_pence: 1482,
  };
  assertEquals(resolveInitialAuthorisedHoldPence(afterSecond), 500);
  assertEquals(resolveLocalConfirmedCoveragePence(afterSecond), 1482);
  assertEquals(
    classifyAuthorisationProjection({
      ...afterSecond,
      psaConfirmedTotalPence: 1482,
      confirmedIncrementCount: 2,
    }),
    "original_intact",
  );
});

Deno.test("#103 promoted historical class reported, not repaired", () => {
  assertEquals(
    classifyAuthorisationProjection({
      authorised_amount_pence: 1482,
      original_authorised_pence: 1482,
      total_authorised_amount_pence: 1482,
      psaConfirmedTotalPence: 1482,
      confirmedIncrementCount: 2,
    }),
    "authorised_promoted",
  );
});

Deno.test("#103 mirror patch never overwrites existing original", () => {
  const patch = buildAuthorisationMirrorPatch({
    existingAuthorisedPence: 700,
    existingTotalAuthorisedPence: 700,
    confirmedCoveragePence: 800,
    seedOriginalIfMissing: true,
  });
  assertEquals(patch.total_authorised_amount_pence, 800);
  assertFalse("authorised_amount_pence" in patch);

  const seed = buildAuthorisationMirrorPatch({
    existingAuthorisedPence: 0,
    existingTotalAuthorisedPence: 0,
    confirmedCoveragePence: 700,
    seedOriginalIfMissing: true,
  });
  assertEquals(seed.authorised_amount_pence, 700);
  assertEquals(seed.total_authorised_amount_pence, 700);
});

Deno.test("#103 mirror patch never regresses total", () => {
  const patch = buildAuthorisationMirrorPatch({
    existingAuthorisedPence: 700,
    existingTotalAuthorisedPence: 800,
    confirmedCoveragePence: 750,
    seedOriginalIfMissing: false,
  });
  assertEquals(patch.total_authorised_amount_pence, 800);
});

Deno.test("#103 mayWriteOriginalAuthorisedAmount gates", () => {
  assertEquals(mayWriteOriginalAuthorisedAmount({
    existingAuthorisedPence: null,
    nextAuthorisedPence: 700,
  }), true);
  assertEquals(mayWriteOriginalAuthorisedAmount({
    existingAuthorisedPence: 700,
    nextAuthorisedPence: 700,
  }), true);
  assertEquals(mayWriteOriginalAuthorisedAmount({
    existingAuthorisedPence: 700,
    nextAuthorisedPence: 800,
  }), false);
});

Deno.test("#103 declined increment does not change original hold semantics", () => {
  const row = {
    authorised_amount_pence: 700,
    total_authorised_amount_pence: 700,
  };
  assertEquals(resolveInitialAuthorisedHoldPence(row), 700);
  assertEquals(resolveLocalConfirmedCoveragePence(row), 700);
  assertEquals(
    classifyAuthorisationProjection({
      ...row,
      confirmedIncrementCount: 0,
    }),
    "both_equal_initial",
  );
});

Deno.test("#103 provider-first coverage preferred over local", () => {
  const resolved = resolveSessionAuthorisedCoveragePence({
    authorised_amount_pence: 700,
    total_authorised_amount_pence: 750,
    providerConfirmedAuthorisedPence: 800,
    providerAuthKnown: true,
  });
  assertEquals(resolved.source, "provider");
  assertEquals(resolved.coveragePence, 800);
});

Deno.test("#103 source files lock writers/readers", async () => {
  const reconcile = await Deno.readTextFile(
    new URL("../../functions/_shared/reconcilePendingIncrementAuthorisationSSOT.ts", import.meta.url),
  );
  assertFalse(
    /authorised_amount_pence:\s*Math\.max\(/.test(reconcile),
    "reconcile must not promote authorised via Math.max",
  );
  assertExists(reconcile.includes("total_authorised_amount_pence"));

  const webhook = await Deno.readTextFile(
    new URL("../../functions/revolut-webhook/index.ts", import.meta.url),
  );
  assertExists(webhook.includes("buildAuthorisationMirrorPatch"));
  assertFalse(
    /statusAdvanceExtras\.authorised_amount_pence\s*=\s*authorisedAmount/.test(webhook),
  );

  const display = await Deno.readTextFile(
    new URL("../../functions/_shared/paymentSessionsDisplaySSOT.ts", import.meta.url),
  );
  assertExists(display.includes("resolveLocalConfirmedCoveragePence"));

  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20270301170000_authorisation_projection_103_immutable.sql",
      import.meta.url,
    ),
  );
  assertExists(mig.includes("payment_sessions_authorisation_projection_guard"));
  assertExists(mig.includes("COMMENT ON COLUMN public.payment_sessions.authorised_amount_pence"));
});
