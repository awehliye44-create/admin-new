/**
 * MK-260925-003 release lock: capture composition local application.
 *
 * Run:
 *   deno test --allow-read supabase/functions/_shared/captureCompositionLocalApplyLock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildProviderSettleEvidenceFromGet,
  commissionFromTripFareComponent,
  COMPONENT_OWNERSHIP,
  LOCAL_APPLICATION_INCOMPLETE,
  markLocalApplicationIncomplete,
  planLocalApplicationForProviderState,
  providerCaptureMustNotBecomeTripFare,
  readCaptureCompositionComponents,
  tripFareForEconomicStamps,
} from "./captureCompositionLocalApplySSOT.ts";
import {
  planReceivableSettlementFromCaptureComposition,
} from "./captureCompositionSSOT.ts";
import {
  resolveCapturedTripEarningNetPence,
  resolveSettlementFinalFarePence,
  tripSettlementDbColumns,
  calculateTripSettlementFromTripRow,
} from "./tripSettlement.ts";

const MK003 = {
  fare: 704,
  tip: 0,
  recv: 36,
  buffer: 0,
  captured: 740,
  commission_pct: 15,
  commission: 106,
  ten: 598,
} as const;

const mk003Composition = () =>
  readCaptureCompositionComponents({
    trip_fare_component_pence: MK003.fare,
    tip_component_pence: MK003.tip,
    receivable_component_pence: MK003.recv,
    buffer_pence: MK003.buffer,
    provider_capture_target_pence: MK003.captured,
  });

Deno.test("1. GET COMPLETED 740 + composition 704/0/36/0 → stamps 704, commission 106, total 598, settle 36", () => {
  const composition = mk003Composition();
  assertEquals(composition?.trip_fare_component_pence, 704);
  assertEquals(composition?.receivable_component_pence, 36);
  assertEquals(providerCaptureMustNotBecomeTripFare(composition), true);

  const fare = tripFareForEconomicStamps({
    composition,
    provider_captured_pence: 740,
    fallback_final_fare_pence: 740,
  });
  assertEquals(fare, 704);

  const settlement = calculateTripSettlementFromTripRow({
    trip_fare_component_pence: 704,
    capture_amount_pence: 740,
    final_fare_pence: 740,
    tip_pence: 0,
    accepted_commission_percent: 15,
  });
  assertEquals(settlement?.commissionable_fare_pence, 704);
  assertEquals(settlement?.commission_pence, 106);
  assertEquals(settlement?.driver_total_earnings_pence, 598);
  const cols = tripSettlementDbColumns(settlement!);
  assertEquals(cols.gross_fare_pence, 704);
  assertEquals(cols.final_fare_pence, 704);

  const settlePlan = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 740,
    reserved_allocation_total_pence: 36,
    trip_fare_component_pence: 704,
    amount_from_provider_get: true,
  });
  assertEquals(settlePlan.settle_pence, 36);
});

Deno.test("2. providerEvidence omitted with receivable → fail closed before local success", async () => {
  const paymentSrc = await Deno.readTextFile(
    new URL("./paymentSessionSSOT.ts", import.meta.url),
  );
  assertStringIncludes(
    paymentSrc,
    "LOCAL_APPLICATION_INCOMPLETE:missing_provider_evidence_with_receivable",
  );
  const policy = planLocalApplicationForProviderState({
    provider_state: "COMPLETED",
    composition: mk003Composition(),
    provider_evidence_from_get: false,
    reserved_allocation_total_pence: 36,
    existing_ten_count: 1,
    trip_stamps_match_fare_component: false,
    receivables_already_settled: false,
  });
  assertEquals(policy.may_settle_receivables, false);
  assertEquals(policy.mark_incomplete, true);
  assertEquals(policy.allow_capture_post, false);
  assertEquals(policy.require_get_first, true);
});

Deno.test("3. provider captured and settlement throws → MANUAL_REVIEW, no second POST", async () => {
  const outcome = markLocalApplicationIncomplete("receivable_settle_rpc_failed");
  assertEquals(outcome.provider_capture_persisted, true);
  assertEquals(outcome.manual_review, true);
  assertEquals(outcome.incomplete, true);

  const captureSrc = await Deno.readTextFile(
    new URL("./revolutCompletionCapture.ts", import.meta.url),
  );
  assertStringIncludes(captureSrc, LOCAL_APPLICATION_INCOMPLETE);
  assertStringIncludes(captureSrc, "manual_review: true");
  assertEquals(captureSrc.includes("allow_capture_post"), false);
  // Incomplete path must not call captureOrder again after the error marker.
  const idx = captureSrc.indexOf("LOCAL_APPLICATION_INCOMPLETE");
  assertEquals(idx > 0, true);
  const after = captureSrc.slice(idx, idx + 800);
  assertEquals(/captureOrder\s*\(/.test(after), false);
});

Deno.test("4. retry after settlement failure → GET first, settle once", () => {
  const retry = planLocalApplicationForProviderState({
    provider_state: "LOCAL_APPLICATION_INCOMPLETE",
    composition: mk003Composition(),
    provider_evidence_from_get: true,
    reserved_allocation_total_pence: 36,
    existing_ten_count: 1,
    trip_stamps_match_fare_component: false,
    receivables_already_settled: false,
  });
  assertEquals(retry.require_get_first, true);
  assertEquals(retry.allow_capture_post, false);
  assertEquals(retry.may_settle_receivables, true);
  assertEquals(retry.may_post_ten, false); // TEN already exists
});

Deno.test("5. stamps applied then settlement fails → retry does not duplicate TEN", () => {
  const retry = planLocalApplicationForProviderState({
    provider_state: "LOCAL_APPLICATION_INCOMPLETE",
    composition: mk003Composition(),
    provider_evidence_from_get: true,
    reserved_allocation_total_pence: 36,
    existing_ten_count: 1,
    trip_stamps_match_fare_component: true,
    receivables_already_settled: false,
  });
  assertEquals(retry.may_stamp_trip, false);
  assertEquals(retry.may_post_ten, false);
  assertEquals(retry.may_settle_receivables, true);
  // TEN identity unchanged
  assertEquals(commissionFromTripFareComponent(704, 15).driver_net_pence, 598);
});

Deno.test("6. settlement succeeds then stamp write fails → retry does not duplicate SETTLED", () => {
  const retry = planLocalApplicationForProviderState({
    provider_state: "LOCAL_APPLICATION_INCOMPLETE",
    composition: mk003Composition(),
    provider_evidence_from_get: true,
    reserved_allocation_total_pence: 0, // already settled
    existing_ten_count: 1,
    trip_stamps_match_fare_component: false,
    receivables_already_settled: true,
  });
  assertEquals(retry.may_settle_receivables, false);
  assertEquals(retry.may_stamp_trip, true);
  assertEquals(retry.may_post_ten, false);

  const again = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 740,
    reserved_allocation_total_pence: 0,
    trip_fare_component_pence: 704,
    amount_from_provider_get: true,
  });
  assertEquals(again.settle_pence, 0);
});

Deno.test("7. webhook/finalize concurrency → one local application owner", async () => {
  const captureSrc = await Deno.readTextFile(
    new URL("./revolutCompletionCapture.ts", import.meta.url),
  );
  assertStringIncludes(captureSrc, "releasePaymentSessionFinancialLock");
  assertStringIncludes(captureSrc, "buildProviderSettleEvidenceFromGet");
  const evidenceCount = (captureSrc.match(/providerEvidence:/g) ?? []).length;
  assertEquals(evidenceCount >= 4, true);

  const adminSrc = await Deno.readTextFile(
    new URL("./adminCaptureTripPaymentSSOT.ts", import.meta.url),
  );
  assertStringIncludes(adminSrc, "acquireLock");
  assertStringIncludes(adminSrc, "tripFareComponentPence");
});

Deno.test("8. historical capture receivable=0 → compatible", () => {
  const plan = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 0,
    provider_confirmed_captured_pence: 704,
    reserved_allocation_total_pence: 0,
    trip_fare_component_pence: 704,
    amount_from_provider_get: true,
  });
  assertEquals(plan.settle_pence, 0);
  assertEquals(plan.release_remainder, false);

  const policy = planLocalApplicationForProviderState({
    provider_state: "COMPLETED",
    composition: readCaptureCompositionComponents({
      trip_fare_component_pence: 704,
      tip_component_pence: 0,
      receivable_component_pence: 0,
      buffer_pence: 0,
      provider_capture_target_pence: 704,
    }),
    provider_evidence_from_get: true,
    reserved_allocation_total_pence: 0,
    existing_ten_count: 0,
    trip_stamps_match_fare_component: false,
    receivables_already_settled: true,
  });
  assertEquals(policy.may_settle_receivables, false);
  assertEquals(policy.may_stamp_trip, true);
  assertEquals(providerCaptureMustNotBecomeTripFare(
    readCaptureCompositionComponents({
      trip_fare_component_pence: 704,
      tip_component_pence: 0,
      receivable_component_pence: 0,
      buffer_pence: 0,
      provider_capture_target_pence: 704,
    }),
  ), false);
});

Deno.test("9. tip component excluded from fare/commission", () => {
  const composition = readCaptureCompositionComponents({
    trip_fare_component_pence: 704,
    tip_component_pence: 100,
    receivable_component_pence: 0,
    buffer_pence: 0,
    provider_capture_target_pence: 804,
  });
  assertEquals(tripFareForEconomicStamps({ composition }), 704);
  assertEquals(commissionFromTripFareComponent(704, 15).commission_pence, 106);
  const settlement = calculateTripSettlementFromTripRow({
    trip_fare_component_pence: 704,
    capture_amount_pence: 804,
    tip_pence: 100,
    accepted_commission_percent: 15,
  });
  assertEquals(settlement?.commissionable_fare_pence, 704);
  assertEquals(settlement?.tips_pence, 100);
  assertEquals(COMPONENT_OWNERSHIP.tip_component_pence.includes("DRIVER_TIP_CREDIT"), true);
});

Deno.test("10. buffer excluded from capture/stamps", () => {
  const composition = readCaptureCompositionComponents({
    trip_fare_component_pence: 704,
    tip_component_pence: 0,
    receivable_component_pence: 36,
    buffer_pence: 50,
    provider_capture_target_pence: 740,
  });
  assertEquals(composition?.preauth_buffer_component_pence, 50);
  assertEquals(composition?.provider_capture_target_pence, 740);
  assertEquals(tripFareForEconomicStamps({ composition }), 704);
  assertEquals(
    COMPONENT_OWNERSHIP.buffer_component_pence.includes("authorisation_capacity"),
    true,
  );
});

Deno.test("11. partial capture follows frozen component plan", () => {
  const plan = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 720,
    reserved_allocation_total_pence: 36,
    trip_fare_component_pence: 704,
    amount_from_provider_get: true,
  });
  assertEquals(plan.settle_pence, 16);
  assertEquals(plan.release_remainder, true);
});

Deno.test("12. UNKNOWN retains RESERVED", () => {
  const policy = planLocalApplicationForProviderState({
    provider_state: "UNKNOWN",
    composition: mk003Composition(),
    provider_evidence_from_get: false,
    reserved_allocation_total_pence: 36,
    existing_ten_count: 0,
    trip_stamps_match_fare_component: false,
    receivables_already_settled: false,
  });
  assertEquals(policy.retain_reservations, true);
  assertEquals(policy.may_settle_receivables, false);
  assertEquals(policy.may_stamp_trip, false);
  assertEquals(policy.require_get_first, true);
  assertEquals(policy.allow_capture_post, false);

  const plan = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 0,
    reserved_allocation_total_pence: 36,
    trip_fare_component_pence: 704,
    amount_from_provider_get: false,
  });
  assertEquals(plan.settle_pence, 0);
  assertEquals(plan.release_remainder, false);
});

Deno.test("13. AUTHORISED retains RESERVED", () => {
  const policy = planLocalApplicationForProviderState({
    provider_state: "AUTHORISED",
    composition: mk003Composition(),
    provider_evidence_from_get: false,
    reserved_allocation_total_pence: 36,
    existing_ten_count: 0,
    trip_stamps_match_fare_component: false,
    receivables_already_settled: false,
  });
  assertEquals(policy.retain_reservations, true);
  assertEquals(policy.may_settle_receivables, false);
  assertEquals(policy.may_stamp_trip, false);
  assertEquals(policy.may_post_ten, false);
});

Deno.test("14. duplicate GET reconciliation is idempotent", () => {
  const a = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 740,
    reserved_allocation_total_pence: 36,
    trip_fare_component_pence: 704,
    amount_from_provider_get: true,
  });
  const b = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 740,
    reserved_allocation_total_pence: 0,
    trip_fare_component_pence: 704,
    amount_from_provider_get: true,
  });
  assertEquals(a.settle_pence, 36);
  assertEquals(b.settle_pence, 0);

  const evidence = buildProviderSettleEvidenceFromGet({
    orderId: "6ab64b28-ceb5-a857-a71e-8230ec91f010",
    terminalState: "completed",
    confirmedCapturedPence: 740,
  });
  assertEquals(evidence?.confirmedCapturedPence, 740);
});

Deno.test("15. existing correct TEN remains unchanged", () => {
  const ten = resolveCapturedTripEarningNetPence({
    trip: {
      trip_fare_component_pence: 704,
      capture_amount_pence: 740,
      final_fare_pence: 740,
      tip_pence: 0,
      accepted_commission_percent: 15,
    },
    captureAmountPence: 740,
    tripFareComponentPence: 704,
    tipPence: 0,
  });
  assertEquals(ten.driverNetPence, 598);
  // Contaminated stamps must not change TEN when fare component is supplied.
  assertEquals(
    resolveCapturedTripEarningNetPence({
      trip: {
        trip_fare_component_pence: 704,
        capture_amount_pence: 740,
        final_fare_pence: 740,
        tip_pence: 0,
        accepted_commission_percent: 15,
        driver_total_earnings_pence: 629,
      } as never,
      captureAmountPence: 740,
      tripFareComponentPence: 704,
    }).driverNetPence,
    598,
  );
});

Deno.test("16. no wallet/payout/commission-ledger side effect from receivable", () => {
  const recvOwns = COMPONENT_OWNERSHIP.receivable_component_pence as readonly string[];
  const fareOwns = COMPONENT_OWNERSHIP.trip_fare_component_pence as readonly string[];
  assertEquals(recvOwns.includes("TRIP_EARNING_NET"), false);
  assertEquals(fareOwns.includes("customer_receivable_settle"), false);
  const good = commissionFromTripFareComponent(704, 15);
  const bad = commissionFromTripFareComponent(740, 15);
  assertEquals(good.driver_net_pence, 598);
  assertEquals(bad.driver_net_pence, 629);
  // 36p never creates driver entitlement; contamination delta is commission math on 740.
  assertEquals(bad.driver_net_pence - good.driver_net_pence, 31);
});

Deno.test("17. LOCAL_APPLICATION_INCOMPLETE cannot trigger provider re-POST", async () => {
  const incomplete = planLocalApplicationForProviderState({
    provider_state: "LOCAL_APPLICATION_INCOMPLETE",
    composition: mk003Composition(),
    provider_evidence_from_get: true,
    reserved_allocation_total_pence: 36,
    existing_ten_count: 1,
    trip_stamps_match_fare_component: true,
    receivables_already_settled: false,
  });
  assertEquals(incomplete.allow_capture_post, false);
  assertEquals(incomplete.require_get_first, true);

  const paymentSrc = await Deno.readTextFile(
    new URL("./paymentSessionSSOT.ts", import.meta.url),
  );
  // Capture status is written before settle — never rolled back on settle fail.
  const markStatus = paymentSrc.indexOf('await markPaymentSessionStatus(supabase, "captured"');
  const settleCall = paymentSrc.indexOf("settleReceivablesFromProviderEvidence");
  assertEquals(markStatus > 0 && settleCall > markStatus, true);
});

Deno.test("18. customer/admin readers clear after settlement (ownership + settle plan)", () => {
  // After settle: reserved=0 → no further settle; outstanding clears via SETTLED status.
  const post = planReceivableSettlementFromCaptureComposition({
    persisted_receivable_component_pence: 36,
    provider_confirmed_captured_pence: 740,
    reserved_allocation_total_pence: 0,
    trip_fare_component_pence: 704,
    amount_from_provider_get: true,
  });
  assertEquals(post.settle_pence, 0);
  assertEquals(
    COMPONENT_OWNERSHIP.receivable_component_pence[0],
    "customer_receivable_settle",
  );
  // Trip fare display ownership remains fare component (704), not capture total.
  assertEquals(
    resolveSettlementFinalFarePence({
      trip_fare_component_pence: 704,
      capture_amount_pence: 740,
      final_fare_pence: 740,
    }),
    704,
  );
});

Deno.test("source: tripSettlement prefers trip_fare_component over capture total", async () => {
  const src = await Deno.readTextFile(
    new URL("./tripSettlement.ts", import.meta.url),
  );
  assertStringIncludes(src, "trip_fare_component_pence");
  assertStringIncludes(
    src,
    "provider capture total may include receivable recovery",
  );
  const applySrc = await Deno.readTextFile(
    new URL("./applyCanonicalSettlementAfterCapture.ts", import.meta.url),
  );
  assertStringIncludes(applySrc, "tripFareComponentPence");
});

Deno.test("COMPLETED/CAPTURED evidence builder accepts terminal GET only", () => {
  assertEquals(
    buildProviderSettleEvidenceFromGet({
      orderId: "6ab64b28-ceb5-a857-a71e-8230ec91f010",
      terminalState: "AUTHORISED",
      confirmedCapturedPence: 740,
    }),
    null,
  );
  assertEquals(
    buildProviderSettleEvidenceFromGet({
      orderId: "6ab64b28-ceb5-a857-a71e-8230ec91f010",
      terminalState: "CAPTURED",
      confirmedCapturedPence: 740,
    })?.terminalState,
    "CAPTURED",
  );
});
