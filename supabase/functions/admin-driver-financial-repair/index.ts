/**
 * Admin Driver Financial Review & Repair — Finance-only Edge.
 *
 * Actions: preview | apply | recompute
 * Never: Revolut / provider mutation, payout execution, scheduler, direct unfreeze,
 *        Admin-typed stamp amounts, generic Adjustment path.
 *
 * Preview is read-only (zero persistent DB writes).
 * Apply persists audit/idempotency, then mutates, then runs real FR/wallet recompute.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  corsHeaders,
  requireFinanceExecutionAuth,
  FINANCE_EXECUTION_PAGE_SLUGS,
  type GateResult,
} from "../_shared/adminPaymentGate.ts";
import { logFinanceAuditEvent } from "../_shared/onecabFinanceLedger.ts";
import { creditCapturedCardTripLedger } from "../_shared/onecabFinanceLedger.ts";
import { fetchDriverWalletPayoutSnapshot } from "../_shared/fetchDriverWalletPayoutSnapshot.ts";
import {
  assertRepairMoneyConservation,
  assertRepairPreviewStillFresh,
  buildDriverFinancialRepairIdempotencyKey,
  buildDriverFinancialRepairPreview,
  buildWalletCorrectionProviderTransferId,
  DRIVER_FINANCIAL_REPAIR_ACTION,
  DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT,
  DRIVER_FINANCIAL_REPAIR_BLOCK,
  DRIVER_FINANCIAL_REPAIR_CALCULATION_VERSION,
  evaluateFalseFreezeClearedFromRecompute,
  formatWalletCorrectionResultCopy,
  validateDriverFinancialRepairReason,
  type DriverFinancialRepairEvidence,
} from "../_shared/driverFinancialReviewRepairSSOT.ts";

const PAGE_SLUG = FINANCE_EXECUTION_PAGE_SLUGS.DRIVER_WALLET_LEDGER;

type RepairSupabase = GateResult["supabase"];

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function newRepairToken(): string {
  return crypto.randomUUID();
}

async function assertPlatformCollectedDriver(
  supabase: RepairSupabase,
  driverId: string,
): Promise<
  | { ok: true; driver: Record<string, unknown>; financial_model: string }
  | { ok: false; response: Response }
> {
  const { data: driver, error } = await supabase
    .from("drivers")
    .select(
      "id, first_name, last_name, driver_code, service_area_id, payout_operational_paused, currency, service_areas(financial_model)",
    )
    .eq("id", driverId)
    .maybeSingle();

  if (error || !driver) {
    return { ok: false, response: json({ error: "Driver not found", error_code: "DRIVER_NOT_FOUND" }, 404) };
  }

  const sa = driver.service_areas as { financial_model?: string | null } | null;
  const model = String(sa?.financial_model ?? "").toUpperCase();
  if (model === "DRIVER_COLLECTED_COMMISSION_WALLET" || model.includes("DRIVER_COLLECTED")) {
    return {
      ok: false,
      response: json({
        error: "FINANCIAL_MODEL_VIOLATION: Review & repair forbidden on DRIVER_COLLECTED",
        error_code: "FINANCIAL_MODEL_VIOLATION",
      }, 409),
    };
  }

  return { ok: true, driver: driver as Record<string, unknown>, financial_model: model || "PLATFORM_COLLECTED" };
}

async function assertServiceAreaAccess(
  supabase: RepairSupabase,
  userId: string,
  driverServiceAreaId: string | null,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const { data: staff } = await supabase
    .from("staff_profiles")
    .select("id, role, is_owner")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  if (!staff) {
    return {
      ok: false,
      response: json({ error: "Staff profile required", error_code: "PERMISSION_DENIED" }, 403),
    };
  }

  const role = String(staff.role ?? "");
  if (role === "super_admin") return { ok: true };

  if (!driverServiceAreaId) {
    return {
      ok: false,
      response: json({ error: "Driver service area missing", error_code: "PERMISSION_DENIED" }, 403),
    };
  }

  const { data: overlap } = await supabase
    .from("staff_service_areas")
    .select("service_area_id")
    .eq("staff_id", staff.id)
    .eq("service_area_id", driverServiceAreaId)
    .maybeSingle();

  if (!overlap) {
    return {
      ok: false,
      response: json({
        error: "Service-area access required",
        error_code: DRIVER_FINANCIAL_REPAIR_BLOCK.PERMISSION_DENIED,
      }, 403),
    };
  }
  return { ok: true };
}

/**
 * Session-level advisory lock via SECURITY DEFINER RPC (fail closed).
 * Must not silently continue without the lock.
 */
async function acquireDriverFinancialRepairLock(
  supabase: RepairSupabase,
  driverId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const { data, error } = await supabase.rpc("admin_driver_financial_repair_lock", {
    p_driver_id: driverId,
    p_acquire: true,
  });
  if (error || !data || (data as { ok?: boolean }).ok !== true) {
    return {
      ok: false,
      response: json({
        error: "Financial repair lock unavailable — apply aborted",
        error_code: DRIVER_FINANCIAL_REPAIR_BLOCK.LOCK_UNAVAILABLE,
        details: error?.message ?? data,
      }, 503),
    };
  }
  return { ok: true };
}

async function releaseDriverFinancialRepairLock(
  supabase: RepairSupabase,
  driverId: string,
): Promise<void> {
  await supabase.rpc("admin_driver_financial_repair_lock", {
    p_driver_id: driverId,
    p_acquire: false,
  });
}

async function loadTripEvidence(
  supabase: RepairSupabase,
  args: { driverId: string; tripId: string; financialModel: string; driver: Record<string, unknown> },
): Promise<
  | { ok: true; evidence: DriverFinancialRepairEvidence; trip: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const { data: trip, error } = await supabase
    .from("trips")
    .select(
      "id, trip_code, status, financial_outcome, financial_model, driver_id, driver_net_pence, commission_pence, tip_pence, tip_amount_pence, airport_charge_pence, final_fare_pence, capture_amount_pence, provider_fee_pence, commission_pct, accepted_commission_percent, driver_tier_commission_percent, fare_snapshot_json, currency",
    )
    .eq("id", args.tripId)
    .maybeSingle();

  if (error || !trip) {
    return { ok: false, response: json({ error: "Trip not found", error_code: "TRIP_NOT_FOUND" }, 404) };
  }
  if (String(trip.driver_id) !== args.driverId) {
    return {
      ok: false,
      response: json({ error: "Trip driver mismatch", error_code: "TRIP_DRIVER_MISMATCH" }, 409),
    };
  }

  const { data: session } = await supabase
    .from("payment_sessions")
    .select(
      "id, trip_id, provider_order_id, provider_payment_id, provider_status, status, captured_amount_pence, currency, metadata",
    )
    .eq("trip_id", args.tripId)
    .order("created_at", { ascending: false })
    .limit(2);

  const sessions = session ?? [];
  const primary = sessions[0] ?? null;
  const lineageOk = sessions.length <= 1
    || sessions.every((s) => String(s.trip_id) === args.tripId);

  const { data: ledgerRows } = await supabase
    .from("driver_wallet_ledger")
    .select("id, type, amount_pence, related_trip_id")
    .eq("driver_id", args.driverId)
    .eq("related_trip_id", args.tripId);

  let actualTen = 0;
  let actualTip = 0;
  for (const row of ledgerRows ?? []) {
    const type = String(row.type ?? "");
    const amt = Math.round(Number(row.amount_pence ?? 0));
    if (type === "TRIP_EARNING_NET") actualTen += amt;
    if (type === "DRIVER_TIP_CREDIT") actualTip += amt;
  }

  const { data: reservation } = await supabase
    .from("driver_payout_reservations")
    .select("id, status")
    .eq("driver_id", args.driverId)
    .in("status", ["ACTIVE", "RESERVED", "HELD", "OPEN"])
    .limit(5);

  const activeReservation = (reservation ?? []).some((r) => {
    const st = String(r.status ?? "").toUpperCase();
    return st === "ACTIVE" || st === "RESERVED" || st === "HELD" || st === "OPEN";
  });

  const { data: payoutItems } = await supabase
    .from("payout_items")
    .select("id, status, execution_status, related_trip_id, driver_id")
    .eq("driver_id", args.driverId)
    .limit(25);

  let payoutIntentStatus: string | null = null;
  for (const item of payoutItems ?? []) {
    const st = String(item.execution_status ?? item.status ?? "").toUpperCase();
    if (st === "SUBMITTED" || st === "UNKNOWN" || st === "PROCESSING" || st === "IN_FLIGHT") {
      payoutIntentStatus = st;
      break;
    }
  }

  const { data: intents } = await supabase
    .from("driver_payout_payment_intents")
    .select("id, status")
    .eq("driver_id", args.driverId)
    .in("status", ["SUBMITTED", "UNKNOWN", "PROCESSING"])
    .limit(5);
  if (!payoutIntentStatus) {
    for (const intent of intents ?? []) {
      const st = String(intent.status ?? "").toUpperCase();
      if (st === "SUBMITTED" || st === "UNKNOWN" || st === "PROCESSING") {
        payoutIntentStatus = st;
        break;
      }
    }
  }

  const { data: priorRepair } = await supabase
    .from("driver_financial_repair_requests")
    .select("repair_token, status")
    .eq("driver_id", args.driverId)
    .eq("trip_id", args.tripId)
    .eq("status", "APPLIED")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const providerState = String(
    primary?.provider_status ?? primary?.status ?? "",
  ).toUpperCase() || null;

  const captured = primary?.captured_amount_pence != null
    ? Math.round(Number(primary.captured_amount_pence))
    : trip.capture_amount_pence != null
    ? Math.round(Number(trip.capture_amount_pence))
    : null;

  const driverName = [args.driver.first_name, args.driver.last_name]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .join(" ") || null;

  const evidence: DriverFinancialRepairEvidence = {
    driver_id: args.driverId,
    driver_name: driverName,
    driver_code: args.driver.driver_code ? String(args.driver.driver_code) : null,
    trip_id: args.tripId,
    trip_code: trip.trip_code ? String(trip.trip_code) : null,
    trip_status: trip.status ? String(trip.status) : null,
    financial_model: args.financialModel || String(trip.financial_model ?? "PLATFORM_COLLECTED"),
    financial_outcome: trip.financial_outcome ? String(trip.financial_outcome) : null,
    payment_session_id: primary?.id ? String(primary.id) : null,
    payment_session_lineage_ok: lineageOk,
    provider_order_id: primary?.provider_order_id ? String(primary.provider_order_id) : null,
    provider_payment_id: primary?.provider_payment_id ? String(primary.provider_payment_id) : null,
    provider_state: providerState,
    captured_amount_pence: captured,
    final_fare_pence: trip.final_fare_pence != null ? Math.round(Number(trip.final_fare_pence)) : null,
    commission_basis_pence: trip.final_fare_pence != null
      ? Math.max(
        0,
        Math.round(Number(trip.final_fare_pence)) - Math.round(Number(trip.airport_charge_pence ?? 0)),
      )
      : null,
    commission_rate_percent: trip.accepted_commission_percent
      ?? trip.commission_pct
      ?? trip.driver_tier_commission_percent
      ?? null,
    commission_pence: trip.commission_pence != null ? Math.round(Number(trip.commission_pence)) : null,
    provider_fee_pence: trip.provider_fee_pence != null ? Math.round(Number(trip.provider_fee_pence)) : null,
    tip_pence: Math.round(Number(trip.tip_pence ?? trip.tip_amount_pence ?? 0)),
    airport_charge_pence: trip.airport_charge_pence != null
      ? Math.round(Number(trip.airport_charge_pence))
      : null,
    existing_driver_net_pence: trip.driver_net_pence == null
      ? null
      : Math.round(Number(trip.driver_net_pence)),
    existing_commission_pence: trip.commission_pence == null
      ? null
      : Math.round(Number(trip.commission_pence)),
    existing_tip_pence: trip.tip_pence == null && trip.tip_amount_pence == null
      ? null
      : Math.round(Number(trip.tip_pence ?? trip.tip_amount_pence ?? 0)),
    actual_ten_credit_pence: actualTen,
    actual_tip_credit_pence: actualTip,
    currency: trip.currency ? String(trip.currency) : (args.driver.currency ? String(args.driver.currency) : "GBP"),
    expected_currency: primary?.currency ? String(primary.currency) : null,
    has_contradictory_stamps: false,
    active_payout_reservation: activeReservation,
    payout_intent_status: payoutIntentStatus,
    already_applied_repair_token: priorRepair?.repair_token
      ? String(priorRepair.repair_token)
      : null,
    admin_override_driver_net_pence: null,
  };

  return { ok: true, evidence, trip: trip as Record<string, unknown> };
}

async function insertRepairAudit(
  supabase: RepairSupabase,
  args: {
    event_type: string;
    repair_token: string;
    idempotency_key?: string | null;
    preview_hash?: string | null;
    driver_id: string;
    trip_id: string;
    admin_user_id: string;
    reason?: string | null;
    before_state?: Record<string, unknown> | null;
    after_state?: Record<string, unknown> | null;
    source_evidence?: Record<string, unknown> | null;
    details?: Record<string, unknown> | null;
  },
): Promise<void> {
  await supabase.from("driver_financial_repair_audit").insert({
    event_type: args.event_type,
    repair_token: args.repair_token,
    idempotency_key: args.idempotency_key ?? null,
    preview_hash: args.preview_hash ?? null,
    driver_id: args.driver_id,
    trip_id: args.trip_id,
    admin_user_id: args.admin_user_id,
    reason: args.reason ?? null,
    calculation_version: DRIVER_FINANCIAL_REPAIR_CALCULATION_VERSION,
    before_state: args.before_state ?? null,
    after_state: args.after_state ?? null,
    source_evidence: args.source_evidence ?? null,
    details: args.details ?? null,
  });

  await logFinanceAuditEvent(
    supabase,
    args.event_type,
    {
      repair_token: args.repair_token,
      idempotency_key: args.idempotency_key ?? null,
      preview_hash: args.preview_hash ?? null,
      reason: args.reason ?? null,
      calculation_version: DRIVER_FINANCIAL_REPAIR_CALCULATION_VERSION,
      before: args.before_state ?? null,
      after: args.after_state ?? null,
      source_evidence: args.source_evidence ?? null,
      ...(args.details ?? {}),
    },
    args.trip_id,
    args.driver_id,
  );
}

/** Preview — ZERO persistent DB writes. Observational only. */
async function handlePreview(
  gate: GateResult,
  body: Record<string, unknown>,
): Promise<Response> {
  const driverId = String(body.driver_id ?? "");
  const tripId = String(body.trip_id ?? "");
  if (!driverId || !tripId) {
    return json({ error: "driver_id and trip_id required", error_code: "INVALID_INPUT" }, 400);
  }

  if (
    body.admin_override_driver_net_pence != null
    || body.driver_net_pence != null
    || body.expected_stamp != null
    || body.custom_stamp != null
  ) {
    return json({
      error: "Admin cannot type an arbitrary expected stamp",
      error_code: DRIVER_FINANCIAL_REPAIR_BLOCK.ARBITRARY_STAMP_EDIT,
    }, 400);
  }

  const driverGate = await assertPlatformCollectedDriver(gate.supabase, driverId);
  if (!driverGate.ok) return driverGate.response;

  const saId = driverGate.driver.service_area_id
    ? String(driverGate.driver.service_area_id)
    : null;
  const access = await assertServiceAreaAccess(gate.supabase, gate.userId, saId);
  if (!access.ok) return access.response;

  const loaded = await loadTripEvidence(gate.supabase, {
    driverId,
    tripId,
    financialModel: driverGate.financial_model,
    driver: driverGate.driver,
  });
  if (!loaded.ok) return loaded.response;

  const repairToken = newRepairToken();
  const derivedFrozen = String(body.wallet_status ?? "").toUpperCase() === "FROZEN"
    || String(body.driver_credit_status ?? "").toUpperCase().includes("UNDER")
    || String(body.driver_credit_status ?? "").toUpperCase().includes("OVER");

  const preview = buildDriverFinancialRepairPreview({
    evidence: loaded.evidence,
    repair_token: repairToken,
    derived_frozen: derivedFrozen,
  });

  // Intentionally no persistent writes (requests / audit / finance ledger events).
  return json({
    ok: true,
    preview,
    preview_persisted: false,
    copy: {
      confirmation:
        "Review the verified payment and trip evidence before applying this repair. This action does not send money unless an exact wallet correction is shown.",
    },
  });
}

async function handleApply(
  gate: GateResult,
  body: Record<string, unknown>,
): Promise<Response> {
  const clientRepairToken = String(body.repair_token ?? "");
  const previewHash = String(body.preview_hash ?? "");
  const driverIdBody = String(body.driver_id ?? "");
  const tripIdBody = String(body.trip_id ?? "");
  const reasonCheck = validateDriverFinancialRepairReason(body.reason as string);
  if (!reasonCheck.ok) {
    return json({
      error: "Reason must be 3–500 characters",
      error_code: DRIVER_FINANCIAL_REPAIR_BLOCK.REASON_INVALID,
    }, 400);
  }
  if (!previewHash || !driverIdBody || !tripIdBody) {
    return json({
      error: "driver_id, trip_id, and preview_hash required",
      error_code: "INVALID_INPUT",
    }, 400);
  }

  if (
    body.admin_override_driver_net_pence != null
    || body.driver_net_pence != null
    || body.expected_stamp != null
  ) {
    return json({
      error: "Admin cannot type an arbitrary expected stamp",
      error_code: DRIVER_FINANCIAL_REPAIR_BLOCK.ARBITRARY_STAMP_EDIT,
    }, 400);
  }

  const driverId = driverIdBody;
  const tripId = tripIdBody;

  // Idempotent replay by preview hash / prior apply.
  const { data: priorByHash } = await gate.supabase
    .from("driver_financial_repair_requests")
    .select("*")
    .eq("driver_id", driverId)
    .eq("trip_id", tripId)
    .eq("preview_hash", previewHash)
    .eq("status", "APPLIED")
    .maybeSingle();
  if (priorByHash) {
    return json({
      ok: true,
      idempotent: true,
      result: priorByHash.apply_result ?? { already_applied: true },
      message: "Repair already applied (idempotent)",
    });
  }

  const driverGate = await assertPlatformCollectedDriver(gate.supabase, driverId);
  if (!driverGate.ok) return driverGate.response;

  const saId = driverGate.driver.service_area_id
    ? String(driverGate.driver.service_area_id)
    : null;
  const access = await assertServiceAreaAccess(gate.supabase, gate.userId, saId);
  if (!access.ok) return access.response;

  const lock = await acquireDriverFinancialRepairLock(gate.supabase, driverId);
  if (!lock.ok) return lock.response;

  try {
    const loaded = await loadTripEvidence(gate.supabase, {
      driverId,
      tripId,
      financialModel: driverGate.financial_model,
      driver: driverGate.driver,
    });
    if (!loaded.ok) return loaded.response;

    const repairToken = clientRepairToken || newRepairToken();
    const livePreview = buildDriverFinancialRepairPreview({
      evidence: loaded.evidence,
      repair_token: repairToken,
      derived_frozen: true,
    });

    const fresh = assertRepairPreviewStillFresh({
      stored_preview_hash: previewHash,
      live_preview_hash: livePreview.preview_hash,
    });
    if (!fresh.ok) {
      await insertRepairAudit(gate.supabase, {
        event_type: DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT.BLOCKED,
        repair_token: repairToken,
        preview_hash: previewHash,
        driver_id: driverId,
        trip_id: tripId,
        admin_user_id: gate.userId,
        reason: reasonCheck.reason,
        details: { error_code: fresh.error_code },
      });
      return json({
        error: "Repair preview is stale — re-run Review & repair",
        error_code: DRIVER_FINANCIAL_REPAIR_BLOCK.REPAIR_PREVIEW_STALE,
      }, 409);
    }

    if (!livePreview.apply_allowed) {
      await insertRepairAudit(gate.supabase, {
        event_type: DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT.BLOCKED,
        repair_token: repairToken,
        preview_hash: previewHash,
        driver_id: driverId,
        trip_id: tripId,
        admin_user_id: gate.userId,
        reason: reasonCheck.reason,
        details: { error_code: livePreview.block_code, block_reason: livePreview.block_reason },
      });
      return json({
        error: livePreview.block_reason ?? "Repair blocked",
        error_code: livePreview.block_code ?? "REPAIR_BLOCKED",
      }, 409);
    }

    const provenMissing = Math.max(
      0,
      (livePreview.canonical_expected_credit_pence ?? 0) - livePreview.actual_ledger_credit_pence,
    );
    const conservation = assertRepairMoneyConservation({
      canonical_ten_restoration_pence: livePreview.proposed_repair.canonical_ten_restoration_pence,
      residual_correction_pence: livePreview.proposed_repair.append_wallet_correction_pence,
      proven_missing_pence: provenMissing,
    });
    if (!conservation.ok) {
      return json({
        error: conservation.reason,
        error_code: DRIVER_FINANCIAL_REPAIR_BLOCK.MONETARY_CONSERVATION_VIOLATION,
      }, 409);
    }

    const idempotencyKey = buildDriverFinancialRepairIdempotencyKey({
      repair_token: repairToken,
      preview_hash: previewHash,
    });

    // Persist request at Apply time (not Preview).
    const { error: persistErr } = await gate.supabase.from("driver_financial_repair_requests").insert({
      repair_token: repairToken,
      driver_id: driverId,
      trip_id: tripId,
      preview_hash: previewHash,
      classification: livePreview.classification,
      preview_payload: livePreview,
      status: "PREVIEWED",
      created_by_admin_id: gate.userId,
      calculation_version: DRIVER_FINANCIAL_REPAIR_CALCULATION_VERSION,
      idempotency_key: idempotencyKey,
    });
    if (persistErr) {
      if (persistErr.code === "23505") {
        const { data: existing } = await gate.supabase
          .from("driver_financial_repair_requests")
          .select("*")
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();
        if (existing && String(existing.status) === "APPLIED") {
          return json({
            ok: true,
            idempotent: true,
            result: existing.apply_result ?? { already_applied: true },
          });
        }
      }
      return json({ error: persistErr.message, error_code: "APPLY_PERSIST_FAILED" }, 500);
    }

    await insertRepairAudit(gate.supabase, {
      event_type: DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT.PREVIEWED,
      repair_token: repairToken,
      idempotency_key: idempotencyKey,
      preview_hash: previewHash,
      driver_id: driverId,
      trip_id: tripId,
      admin_user_id: gate.userId,
      reason: reasonCheck.reason,
      source_evidence: loaded.evidence as unknown as Record<string, unknown>,
      details: { classification: livePreview.classification, phase: "apply_persist" },
    });

    const beforeState = {
      driver_net_pence: loaded.evidence.existing_driver_net_pence,
      actual_ten_credit_pence: loaded.evidence.actual_ten_credit_pence,
      actual_tip_credit_pence: loaded.evidence.actual_tip_credit_pence,
    };

    let walletDelta = 0;
    let stampRestored = false;
    let tenRestoredPence = 0;
    let correctionPence = 0;
    const messages: string[] = [];
    const provenDelta = livePreview.proposed_repair.proven_wallet_delta_pence;

    if (livePreview.proposed_repair.restore_expected_stamp && livePreview.proposed_repair.proposed_stamp) {
      const stamp = livePreview.proposed_repair.proposed_stamp;
      const existingSnapshot = (loaded.trip.fare_snapshot_json as Record<string, unknown> | null) ?? {};
      const nextSnapshot = {
        ...(existingSnapshot && typeof existingSnapshot === "object" ? existingSnapshot : {}),
        ...stamp.columns,
        repair_token: repairToken,
        repair_calculation_version: DRIVER_FINANCIAL_REPAIR_CALCULATION_VERSION,
      };
      const { error: stampErr } = await gate.supabase
        .from("trips")
        .update({
          ...stamp.columns,
          fare_snapshot_json: nextSnapshot,
        })
        .eq("id", tripId)
        .is("driver_net_pence", null);

      if (stampErr) {
        return json({ error: stampErr.message, error_code: "STAMP_RESTORE_FAILED" }, 500);
      }
      stampRestored = true;

      await insertRepairAudit(gate.supabase, {
        event_type: DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT.EXPECTED_STAMP_RESTORED,
        repair_token: repairToken,
        idempotency_key: idempotencyKey,
        preview_hash: previewHash,
        driver_id: driverId,
        trip_id: tripId,
        admin_user_id: gate.userId,
        reason: reasonCheck.reason,
        before_state: beforeState,
        after_state: { stamp },
        source_evidence: loaded.evidence as unknown as Record<string, unknown>,
      });
    }

    // Canonical TEN restoration owns this amount — residual correction must not include it.
    const tenRestore = livePreview.proposed_repair.canonical_ten_restoration_pence;
    if (tenRestore > 0) {
      const stamp = livePreview.proposed_repair.proposed_stamp;
      const tenOnly = stamp
        ? Math.max(0, stamp.driver_net_pence + stamp.airport_charge_pence)
        : tenRestore;
      const tipOnly = Math.max(0, tenRestore - tenOnly);
      try {
        await creditCapturedCardTripLedger(gate.supabase, {
          driverId,
          tripId,
          driverNetPence: Math.min(tenOnly, tenRestore),
          tipPence: tipOnly,
          currency: loaded.evidence.currency ?? "GBP",
          commissionPct: stamp?.commission_pct,
        });
        tenRestoredPence = tenRestore;
        walletDelta += tenRestore;
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "23505") {
          // Idempotent — TEN already present; do not also residual-correct the same amount.
        } else {
          return json({
            error: err instanceof Error ? err.message : "Wallet credit failed",
            error_code: "WALLET_CREDIT_FAILED",
          }, 500);
        }
      }
    }

    const appendPence = livePreview.proposed_repair.append_wallet_correction_pence;
    if (appendPence !== 0) {
      const providerTransferId = buildWalletCorrectionProviderTransferId(idempotencyKey);
      const ledgerType = appendPence > 0 ? "ADMIN_WALLET_CREDIT" : "ADMIN_WALLET_DEBIT";
      const { data: ledgerEntry, error: ledgerErr } = await gate.supabase
        .from("driver_wallet_ledger")
        .insert({
          driver_id: driverId,
          service_area_id: saId,
          type: ledgerType,
          amount_pence: appendPence,
          currency: loaded.evidence.currency ?? "GBP",
          description: "ONECAB financial repair correction",
          related_trip_id: tripId,
          provider_transfer_id: providerTransferId,
          metadata: {
            repair_token: repairToken,
            preview_hash: previewHash,
            reconciliation_issue: livePreview.classification,
            calculation_version: DRIVER_FINANCIAL_REPAIR_CALCULATION_VERSION,
            append_only: true,
            residual_after_canonical_ten: true,
            canonical_ten_restoration_pence: tenRestore,
            original_ledger_unchanged: true,
          },
        })
        .select("id")
        .maybeSingle();

      if (ledgerErr) {
        if (ledgerErr.code !== "23505") {
          return json({ error: ledgerErr.message, error_code: "WALLET_CORRECTION_FAILED" }, 500);
        }
      } else {
        correctionPence = appendPence;
        walletDelta += appendPence;
        await insertRepairAudit(gate.supabase, {
          event_type: DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT.WALLET_CORRECTION_APPENDED,
          repair_token: repairToken,
          idempotency_key: idempotencyKey,
          preview_hash: previewHash,
          driver_id: driverId,
          trip_id: tripId,
          admin_user_id: gate.userId,
          reason: reasonCheck.reason,
          before_state: beforeState,
          after_state: {
            ledger_entry_id: ledgerEntry?.id ?? null,
            correction_pence: appendPence,
          },
          source_evidence: loaded.evidence as unknown as Record<string, unknown>,
        });
        messages.push(formatWalletCorrectionResultCopy(appendPence));
      }
    }

    if (walletDelta !== provenDelta) {
      return json({
        error:
          `Wallet delta ${walletDelta}p !== proven required delta ${provenDelta}p — aborting result`,
        error_code: DRIVER_FINANCIAL_REPAIR_BLOCK.MONETARY_CONSERVATION_VIOLATION,
      }, 500);
    }

    if (stampRestored && walletDelta === 0) {
      messages.push("Financial evidence restored. No wallet balance was changed.");
    } else if (tenRestoredPence > 0 && correctionPence === 0) {
      messages.push("Financial evidence restored and missing earning posted.");
    }

    // REAL canonical recompute — never synthesize DRIVER_CREDIT_OK / variance 0.
    const snapshot = await fetchDriverWalletPayoutSnapshot(gate.supabase, { driverId });
    const freezeEval = evaluateFalseFreezeClearedFromRecompute({
      wallet_status: snapshot.wallet_status,
      driver_credit_status: snapshot.driver_credit_status,
      reconciliation_status: snapshot.reconciliation_status,
      payout_status: snapshot.payout_status,
      wallet_variance_pence: snapshot.wallet_variance_pence,
      missing_stamp_trip_count: snapshot.missing_stamp_trip_count,
      provider_state_ok: resolveProviderOk(loaded.evidence.provider_state),
      active_payout_reservation: loaded.evidence.active_payout_reservation === true,
      payout_intent_in_flight: Boolean(loaded.evidence.payout_intent_status),
    });

    const recompute = {
      source: "fetchDriverWalletPayoutSnapshot",
      wallet_status: snapshot.wallet_status,
      driver_credit_status: snapshot.driver_credit_status,
      reconciliation_status: snapshot.reconciliation_status,
      payout_status: snapshot.payout_status,
      wallet_variance_pence: snapshot.wallet_variance_pence,
      missing_stamp_trip_count: snapshot.missing_stamp_trip_count,
      remaining_blockers: freezeEval.remaining_blockers,
    };

    await insertRepairAudit(gate.supabase, {
      event_type: DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT.RECONCILIATION_RECOMPUTED,
      repair_token: repairToken,
      idempotency_key: idempotencyKey,
      preview_hash: previewHash,
      driver_id: driverId,
      trip_id: tripId,
      admin_user_id: gate.userId,
      reason: reasonCheck.reason,
      after_state: { recompute, freeze_cleared_derived: freezeEval.clear },
    });

    if (freezeEval.clear) {
      await insertRepairAudit(gate.supabase, {
        event_type: DRIVER_FINANCIAL_REPAIR_AUDIT_EVENT.FALSE_FREEZE_CLEARED,
        repair_token: repairToken,
        idempotency_key: idempotencyKey,
        preview_hash: previewHash,
        driver_id: driverId,
        trip_id: tripId,
        admin_user_id: gate.userId,
        reason: reasonCheck.reason,
        details: {
          note: "Derived from live FR/wallet snapshot — no direct wallet_status/frozen write",
        },
      });
      messages.push(
        "Reconciliation passed. The financial hold was removed automatically.",
      );
    }

    const operationalPausedBefore = driverGate.driver.payout_operational_paused === true;
    const applyResult = {
      stamp_restored: stampRestored,
      canonical_ten_restoration_pence: tenRestoredPence,
      residual_correction_pence: correctionPence,
      proven_wallet_delta_pence: provenDelta,
      actual_wallet_delta_pence: walletDelta,
      wallet_money_changed: walletDelta !== 0,
      original_ledger_unchanged: true,
      freeze_cleared_derived: freezeEval.clear,
      remaining_blockers: freezeEval.remaining_blockers,
      operational_pause_unchanged: true,
      operational_paused: operationalPausedBefore,
      recompute,
      messages,
      classification: livePreview.classification,
    };

    await gate.supabase
      .from("driver_financial_repair_requests")
      .update({
        status: "APPLIED",
        applied_at: new Date().toISOString(),
        applied_by_admin_id: gate.userId,
        apply_reason: reasonCheck.reason,
        apply_result: applyResult,
        idempotency_key: idempotencyKey,
      })
      .eq("repair_token", repairToken);

    return json({
      ok: true,
      idempotent: false,
      result: applyResult,
      copy: {
        evidence_only: walletDelta === 0 && stampRestored
          ? "Financial evidence restored. No wallet balance was changed."
          : null,
        wallet_correction: correctionPence !== 0
          ? formatWalletCorrectionResultCopy(correctionPence)
          : null,
        freeze: freezeEval.clear
          ? "Reconciliation passed. The financial hold was removed automatically."
          : null,
      },
    });
  } finally {
    await releaseDriverFinancialRepairLock(gate.supabase, driverId).catch(() => undefined);
  }
}

function resolveProviderOk(state?: string | null): boolean {
  const s = String(state ?? "").toUpperCase();
  return s === "CAPTURED" || s === "COMPLETED" || s === "SUCCEEDED" || s === "SETTLED";
}

async function handleRecompute(
  gate: GateResult,
  body: Record<string, unknown>,
): Promise<Response> {
  const driverId = String(body.driver_id ?? "");
  if (!driverId) {
    return json({ error: "driver_id required", error_code: "INVALID_INPUT" }, 400);
  }

  const driverGate = await assertPlatformCollectedDriver(gate.supabase, driverId);
  if (!driverGate.ok) return driverGate.response;

  const saId = driverGate.driver.service_area_id
    ? String(driverGate.driver.service_area_id)
    : null;
  const access = await assertServiceAreaAccess(gate.supabase, gate.userId, saId);
  if (!access.ok) return access.response;

  const snapshot = await fetchDriverWalletPayoutSnapshot(gate.supabase, { driverId });
  const freezeEval = evaluateFalseFreezeClearedFromRecompute({
    wallet_status: snapshot.wallet_status,
    driver_credit_status: snapshot.driver_credit_status,
    reconciliation_status: snapshot.reconciliation_status,
    payout_status: snapshot.payout_status,
    wallet_variance_pence: snapshot.wallet_variance_pence,
    missing_stamp_trip_count: snapshot.missing_stamp_trip_count,
    provider_state_ok: true,
    active_payout_reservation: false,
    payout_intent_in_flight: false,
  });

  return json({
    ok: true,
    recompute: {
      source: "fetchDriverWalletPayoutSnapshot",
      wallet_status: snapshot.wallet_status,
      driver_credit_status: snapshot.driver_credit_status,
      wallet_variance_pence: snapshot.wallet_variance_pence,
      remaining_blockers: freezeEval.remaining_blockers,
      freeze_cleared_derived: freezeEval.clear,
    },
    operational_pause_unchanged: true,
  });
}

export async function handleAdminDriverFinancialRepair(
  req: Request,
  deps?: {
    authorize?: (req: Request) => Promise<GateResult | { ok: false; response: Response }>;
  },
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authorize = deps?.authorize ?? ((r: Request) =>
    requireFinanceExecutionAuth(r, {
      pageSlug: PAGE_SLUG,
      requireStaffFinanceProfile: true,
    }));

  const gate = await authorize(req);
  if ("ok" in gate && gate.ok === false) return gate.response;
  const auth = gate as GateResult;

  if (auth.userId === "service-role") {
    return json({ error: "Admin user required", error_code: "ADMIN_USER_REQUIRED" }, 403);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON", error_code: "INVALID_INPUT" }, 400);
  }

  const action = String(body.action ?? "preview").toLowerCase();
  const forbidden = ["revolut", "execute_payout", "scheduler", "unfreeze", "set_wallet_status", "frozen"];
  for (const key of Object.keys(body)) {
    if (forbidden.includes(key.toLowerCase())) {
      return json({ error: "Forbidden field", error_code: "FORBIDDEN_FIELD" }, 400);
    }
  }

  if (action === "preview") return handlePreview(auth, body);
  if (action === "apply") return handleApply(auth, body);
  if (action === "recompute") return handleRecompute(auth, body);

  return json({ error: "Unknown action", error_code: "INVALID_ACTION" }, 400);
}

serve((req) => handleAdminDriverFinancialRepair(req));
