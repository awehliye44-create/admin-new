/**
 * Driver Wallet manual admin adjustments — create / approve / reject.
 * Append-only driver_wallet_ledger; audit in driver_wallet_admin_adjustments.
 * No Payment Sessions, Payout Ledger execution, or provider calls.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  corsHeaders,
  requireFinanceExecutionAuth,
  FINANCE_EXECUTION_PAGE_SLUGS,
  type GateResult,
} from "../_shared/adminPaymentGate.ts";
import { resolveCurrencyFromDriver } from "../_shared/regionCurrency.ts";
import { computeLedgerWalletBalancePence } from "../_shared/onecabFinanceLedger.ts";
import { fetchDriverPayoutEligibility } from "../_shared/fetchDriverPayoutEligibility.ts";
import { logFinanceAuditEvent } from "../_shared/onecabFinanceLedger.ts";
import {
  buildDriverWalletManualAdjustmentIdempotencyKey,
  buildDriverWalletManualAdjustmentLedgerMetadata,
  DRIVER_WALLET_ADJUSTMENT_STATUS,
  driverWalletAdminAdjustmentsDeployed,
  planDriverWalletManualAdjustment,
  validateDriverWalletManualAdjustmentInput,
  driverWalletAdjustmentDriverSubtitle,
} from "../_shared/driverWalletManualAdjustmentSSOT.ts";

const PAGE_SLUG = FINANCE_EXECUTION_PAGE_SLUGS.DRIVER_WALLET_LEDGER;

type AdjustmentSupabase = GateResult["supabase"];

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function loadActorOwnerFlag(
  supabase: AdjustmentSupabase,
  userId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("staff_profiles")
    .select("is_owner")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  return data?.is_owner === true;
}

async function assertPlatformCollectedDriver(
  supabase: AdjustmentSupabase,
  driverId: string,
): Promise<
  | { ok: true; driver: { id: string; service_area_id: string | null } }
  | { ok: false; response: Response }
> {
  const { data: driver, error } = await supabase
    .from("drivers")
    .select("id, service_area_id, service_areas(financial_model)")
    .eq("id", driverId)
    .maybeSingle();

  if (error || !driver) {
    return { ok: false, response: json({ error: "Driver not found", error_code: "DRIVER_NOT_FOUND" }, 404) };
  }

  const sa = driver.service_areas as { financial_model?: string | null } | null;
  const model = String(sa?.financial_model ?? "").toUpperCase();
  if (model === "DRIVER_COLLECTED_COMMISSION_WALLET") {
    return {
      ok: false,
      response: json({
        error: "FINANCIAL_MODEL_VIOLATION: Driver Wallet adjustment forbidden on DRIVER_COLLECTED_COMMISSION_WALLET",
        error_code: "FINANCIAL_MODEL_VIOLATION",
      }, 409),
    };
  }

  return {
    ok: true,
    driver: {
      id: String(driver.id),
      service_area_id: driver.service_area_id ? String(driver.service_area_id) : null,
    },
  };
}

async function applyAdjustmentToLedger(
  supabase: AdjustmentSupabase,
  args: {
    adjustmentId: string;
    driverId: string;
    serviceAreaId: string | null;
    signedAmountPence: number;
    ledgerType: string;
    currencyCode: string;
    reasonCategory: string;
    reasonNote: string;
    evidenceReference: string | null;
    payoutEligible: boolean;
    createdByAdminId: string;
    approvedByAdminId: string;
    relatedTripId?: string | null;
    relatedPayoutItemId?: string | null;
    idempotencyKey: string;
  },
): Promise<
  | { ok: true; ledgerEntryId: string }
  | { ok: false; duplicate: boolean; error?: string }
> {
  const providerTransferId = buildDriverWalletManualAdjustmentIdempotencyKey(args.idempotencyKey);
  const metadata = buildDriverWalletManualAdjustmentLedgerMetadata({
    adjustmentId: args.adjustmentId,
    reasonCategory: args.reasonCategory as never,
    reasonNote: args.reasonNote,
    evidenceReference: args.evidenceReference,
    payoutEligible: args.payoutEligible,
    createdByAdminId: args.createdByAdminId,
    approvedByAdminId: args.approvedByAdminId,
  });

  const description = `ONECAB adjustment · ${
    driverWalletAdjustmentDriverSubtitle(args.reasonCategory as never, args.reasonNote)
  }`;

  const { data: ledgerEntry, error: ledgerError } = await supabase
    .from("driver_wallet_ledger")
    .insert({
      driver_id: args.driverId,
      service_area_id: args.serviceAreaId,
      type: args.ledgerType,
      amount_pence: args.signedAmountPence,
      currency: args.currencyCode,
      description,
      related_trip_id: args.relatedTripId ?? null,
      provider_transfer_id: providerTransferId,
      metadata,
    })
    .select("id")
    .single();

  if (ledgerError) {
    if (ledgerError.code === "23505") {
      return { ok: false, duplicate: true };
    }
    return { ok: false, duplicate: false, error: ledgerError.message };
  }

  return { ok: true, ledgerEntryId: String(ledgerEntry.id) };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const gate = await requireFinanceExecutionAuth(req, {
      pageSlug: PAGE_SLUG,
      requireStaffFinanceProfile: true,
    });
    if (!gate.ok) return gate.response;

    if (gate.userId === "service-role") {
      return json({
        error: "Authenticated finance staff required for Driver Wallet adjustments",
        error_code: "ADMIN_USER_REQUIRED",
      }, 403);
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action ?? "create").trim().toLowerCase();
    const adminUserId = gate.userId;
    const actorIsOwner = await loadActorOwnerFlag(gate.supabase, adminUserId);

    if (!driverWalletAdminAdjustmentsDeployed()) {
      return json({
        error: "Driver wallet manual adjustments are not deployed in this environment",
        error_code: "ADJUSTMENTS_NOT_DEPLOYED",
      }, 503);
    }

    if (action === "approve" || action === "reject") {
      if (!actorIsOwner) {
        return json({
          error: "Owner approval required",
          error_code: "OWNER_APPROVAL_REQUIRED",
        }, 403);
      }

      const adjustmentId = String(body.adjustment_id ?? "").trim();
      if (!adjustmentId) {
        return json({ error: "adjustment_id required", error_code: "ADJUSTMENT_ID_REQUIRED" }, 400);
      }

      const { data: row, error: rowErr } = await gate.supabase
        .from("driver_wallet_admin_adjustments")
        .select("*")
        .eq("id", adjustmentId)
        .maybeSingle();

      if (rowErr || !row) {
        return json({ error: "Adjustment not found", error_code: "NOT_FOUND" }, 404);
      }
      if (row.status !== DRIVER_WALLET_ADJUSTMENT_STATUS.PENDING_APPROVAL) {
        return json({
          error: "Adjustment is not pending approval",
          error_code: "INVALID_STATUS",
          status: row.status,
        }, 409);
      }

      if (action === "reject") {
        const rejectionNote = body.rejection_note != null
          ? String(body.rejection_note).trim() || null
          : null;
        const { error: rejectErr } = await gate.supabase
          .from("driver_wallet_admin_adjustments")
          .update({
            status: DRIVER_WALLET_ADJUSTMENT_STATUS.REJECTED,
            rejected_by_admin_id: adminUserId,
            rejected_at: new Date().toISOString(),
            rejection_note: rejectionNote,
          })
          .eq("id", adjustmentId)
          .eq("status", DRIVER_WALLET_ADJUSTMENT_STATUS.PENDING_APPROVAL);

        if (rejectErr) throw rejectErr;

        await logFinanceAuditEvent(
          gate.supabase,
          "driver_wallet_admin_adjustment_rejected",
          { adjustment_id: adjustmentId, rejected_by: adminUserId, rejection_note: rejectionNote },
          null,
          String(row.driver_id),
        );

        return json({ success: true, status: DRIVER_WALLET_ADJUSTMENT_STATUS.REJECTED, adjustment_id: adjustmentId });
      }

      const driverGate = await assertPlatformCollectedDriver(gate.supabase, String(row.driver_id));
      if (!driverGate.ok) return driverGate.response;

      let currencyCode = "GBP";
      try {
        const regionCurrency = await resolveCurrencyFromDriver(gate.supabase, String(row.driver_id));
        currencyCode = regionCurrency.currency_code;
      } catch (e) {
        return json({ error: (e as Error).message, error_code: "REGION_CURRENCY_UNRESOLVABLE" }, 400);
      }

      const applyResult = await applyAdjustmentToLedger(gate.supabase, {
        adjustmentId,
        driverId: String(row.driver_id),
        serviceAreaId: driverGate.driver.service_area_id,
        signedAmountPence: Number(row.signed_amount_pence ?? row.amount_pence),
        ledgerType: String(row.ledger_type),
        currencyCode,
        reasonCategory: String(row.reason_category),
        reasonNote: String(row.reason_note),
        evidenceReference: row.evidence_reference ? String(row.evidence_reference) : null,
        payoutEligible: row.payout_eligible === true,
        createdByAdminId: String(row.created_by_admin_id),
        approvedByAdminId: adminUserId,
        relatedTripId: row.related_trip_id ? String(row.related_trip_id) : null,
        relatedPayoutItemId: row.related_payout_item_id ? String(row.related_payout_item_id) : null,
        idempotencyKey: String(row.idempotency_key),
      });

      if (!applyResult.ok) {
        if (applyResult.duplicate) {
          const { data: existing } = await gate.supabase
            .from("driver_wallet_admin_adjustments")
            .select("id, status, ledger_entry_id")
            .eq("idempotency_key", String(row.idempotency_key))
            .maybeSingle();
          return json({
            success: true,
            idempotent_replay: true,
            adjustment: existing,
          });
        }
        throw new Error(applyResult.error ?? "Ledger insert failed");
      }

      const appliedAt = new Date().toISOString();
      const { error: updateErr } = await gate.supabase
        .from("driver_wallet_admin_adjustments")
        .update({
          status: DRIVER_WALLET_ADJUSTMENT_STATUS.APPLIED,
          approved_by_admin_id: adminUserId,
          applied_at: appliedAt,
          ledger_entry_id: applyResult.ledgerEntryId,
        })
        .eq("id", adjustmentId)
        .eq("status", DRIVER_WALLET_ADJUSTMENT_STATUS.PENDING_APPROVAL);

      if (updateErr) throw updateErr;

      await logFinanceAuditEvent(
        gate.supabase,
        "driver_wallet_admin_adjustment_applied",
        {
          adjustment_id: adjustmentId,
          ledger_entry_id: applyResult.ledgerEntryId,
          approved_by: adminUserId,
          signed_amount_pence: row.signed_amount_pence,
        },
        row.related_trip_id ? String(row.related_trip_id) : null,
        String(row.driver_id),
      );

      return json({
        success: true,
        status: DRIVER_WALLET_ADJUSTMENT_STATUS.APPLIED,
        adjustment_id: adjustmentId,
        ledger_entry_id: applyResult.ledgerEntryId,
      });
    }

    // Controlled manual adjustment create
    const driverId = String(body.driver_id ?? "").trim();
    if (!driverId) {
      return json({ error: "driver_id required", error_code: "DRIVER_ID_REQUIRED" }, 400);
    }

    const validation = validateDriverWalletManualAdjustmentInput({
      direction: body.direction != null ? String(body.direction) : null,
      amount_pence: body.amount_pence,
      reason_category: body.reason_category != null ? String(body.reason_category) : null,
      reason_note: body.reason_note != null ? String(body.reason_note) : null,
      evidence_reference: body.evidence_reference != null ? String(body.evidence_reference) : null,
    });
    if (!validation.ok) {
      return json({ error: validation.error, error_code: validation.code }, 400);
    }

    const rawIdempotency = body.idempotency_key != null
      ? String(body.idempotency_key).trim()
      : crypto.randomUUID();
    let idempotencyKey: string;
    try {
      idempotencyKey = buildDriverWalletManualAdjustmentIdempotencyKey(rawIdempotency);
    } catch (e) {
      return json({ error: (e as Error).message, error_code: "INVALID_IDEMPOTENCY_KEY" }, 400);
    }

    const { data: existingAdj } = await gate.supabase
      .from("driver_wallet_admin_adjustments")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (existingAdj) {
      return json({
        success: true,
        idempotent_replay: true,
        adjustment: existingAdj,
      });
    }

    const driverGate = await assertPlatformCollectedDriver(gate.supabase, driverId);
    if (!driverGate.ok) return driverGate.response;

    const [eligibility, ledgerRes] = await Promise.all([
      fetchDriverPayoutEligibility(gate.supabase, { driver_id: driverId }),
      gate.supabase
        .from("driver_wallet_ledger")
        .select("type, amount_pence")
        .eq("driver_id", driverId),
    ]);

    const liveBalance = computeLedgerWalletBalancePence(ledgerRes.data ?? []);
    const plan = planDriverWalletManualAdjustment({
      direction: validation.direction,
      amountPence: validation.amountPence,
      reasonCategory: validation.reasonCategory,
      liveBalancePence: liveBalance,
      availableBalancePence: eligibility.available_balance_pence,
      actorIsOwner,
    });

    let currencyCode = "GBP";
    try {
      const regionCurrency = await resolveCurrencyFromDriver(gate.supabase, driverId);
      currencyCode = regionCurrency.currency_code;
    } catch (e) {
      return json({ error: (e as Error).message, error_code: "REGION_CURRENCY_UNRESOLVABLE" }, 400);
    }

    const relatedTripId = body.related_trip_id ? String(body.related_trip_id).trim() || null : null;
    const relatedPayoutItemId = body.related_payout_item_id
      ? String(body.related_payout_item_id).trim() || null
      : null;

    if (relatedTripId) {
      const { data: trip } = await gate.supabase
        .from("trips")
        .select("id, financial_model")
        .eq("id", relatedTripId)
        .maybeSingle();
      if (!trip) {
        return json({ error: "Trip not found", error_code: "TRIP_NOT_FOUND" }, 404);
      }
      if (String(trip.financial_model ?? "").toUpperCase() === "DRIVER_COLLECTED_COMMISSION_WALLET") {
        return json({ error: "FINANCIAL_MODEL_VIOLATION", error_code: "FINANCIAL_MODEL_VIOLATION" }, 409);
      }
    }

    const adjustmentInsert = {
      driver_id: driverId,
      service_area_id: driverGate.driver.service_area_id,
      status: plan.status,
      direction: validation.direction,
      amount_pence: validation.amountPence,
      signed_amount_pence: plan.signedAmountPence,
      currency: currencyCode,
      reason_category: validation.reasonCategory,
      reason_note: validation.reasonNote,
      evidence_reference: validation.evidenceReference,
      ledger_type: plan.ledgerType,
      payout_eligible: plan.payoutEligible,
      idempotency_key: idempotencyKey,
      related_trip_id: relatedTripId,
      related_payout_item_id: relatedPayoutItemId,
      created_by_admin_id: adminUserId,
      requires_owner_approval: plan.requiresOwnerApproval,
      approval_reason_codes: plan.approvalReasonCodes,
      metadata: {
        source: "admin_manual_adjustment",
        projected_live_after_pence: plan.projectedLiveAfterPence,
        projected_available_after_pence: plan.projectedAvailableAfterPence,
        creates_debt_position: plan.createsDebtPosition,
      },
    };

    const { data: createdAdj, error: createErr } = await gate.supabase
      .from("driver_wallet_admin_adjustments")
      .insert(adjustmentInsert)
      .select("*")
      .single();

    if (createErr) {
      if (createErr.code === "23505") {
        const { data: replay } = await gate.supabase
          .from("driver_wallet_admin_adjustments")
          .select("*")
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();
        return json({ success: true, idempotent_replay: true, adjustment: replay });
      }
      throw createErr;
    }

    await logFinanceAuditEvent(
      gate.supabase,
      "driver_wallet_admin_adjustment_created",
      {
        adjustment_id: createdAdj.id,
        status: plan.status,
        requires_owner_approval: plan.requiresOwnerApproval,
        approval_reason_codes: plan.approvalReasonCodes,
        signed_amount_pence: plan.signedAmountPence,
      },
      relatedTripId,
      driverId,
    );

    if (plan.status === DRIVER_WALLET_ADJUSTMENT_STATUS.PENDING_APPROVAL) {
      return json({
        success: true,
        status: plan.status,
        requires_owner_approval: true,
        approval_reason_codes: plan.approvalReasonCodes,
        adjustment: createdAdj,
        plan,
      });
    }

    const applyResult = await applyAdjustmentToLedger(gate.supabase, {
      adjustmentId: String(createdAdj.id),
      driverId,
      serviceAreaId: driverGate.driver.service_area_id,
      signedAmountPence: plan.signedAmountPence,
      ledgerType: plan.ledgerType,
      currencyCode,
      reasonCategory: validation.reasonCategory,
      reasonNote: validation.reasonNote,
      evidenceReference: validation.evidenceReference,
      payoutEligible: plan.payoutEligible,
      createdByAdminId: adminUserId,
      approvedByAdminId: adminUserId,
      relatedTripId,
      relatedPayoutItemId,
      idempotencyKey,
    });

    if (!applyResult.ok) {
      if (applyResult.duplicate) {
        const { data: replay } = await gate.supabase
          .from("driver_wallet_admin_adjustments")
          .select("*")
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();
        return json({ success: true, idempotent_replay: true, adjustment: replay });
      }
      throw new Error(applyResult.error ?? "Ledger insert failed");
    }

    const appliedAt = new Date().toISOString();
    await gate.supabase
      .from("driver_wallet_admin_adjustments")
      .update({
        status: DRIVER_WALLET_ADJUSTMENT_STATUS.APPLIED,
        approved_by_admin_id: adminUserId,
        applied_at: appliedAt,
        ledger_entry_id: applyResult.ledgerEntryId,
      })
      .eq("id", createdAdj.id);

    await logFinanceAuditEvent(
      gate.supabase,
      "driver_wallet_admin_adjustment_applied",
      {
        adjustment_id: createdAdj.id,
        ledger_entry_id: applyResult.ledgerEntryId,
        signed_amount_pence: plan.signedAmountPence,
      },
      relatedTripId,
      driverId,
    );

    const updatedLedger = await gate.supabase
      .from("driver_wallet_ledger")
      .select("type, amount_pence")
      .eq("driver_id", driverId);

    return json({
      success: true,
      status: DRIVER_WALLET_ADJUSTMENT_STATUS.APPLIED,
      adjustment_id: createdAdj.id,
      ledger_entry_id: applyResult.ledgerEntryId,
      signed_amount_pence: plan.signedAmountPence,
      wallet: {
        live_balance_pence: computeLedgerWalletBalancePence(updatedLedger.data ?? []),
        available_balance_pence: eligibility.available_balance_pence,
        creates_debt_position: plan.createsDebtPosition,
      },
      plan,
    });
  } catch (error) {
    console.error("Error in admin-driver-adjustment:", error);
    return json({ error: (error as Error).message, error_code: "INTERNAL_ERROR" }, 500);
  }
});
