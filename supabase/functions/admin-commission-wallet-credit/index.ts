/**
 * Admin Commission Wallet credit — Phase 2.
 * Writes driver_commission_wallet_ledger only (never driver_wallet_ledger).
 * Dispatch / reserve untouched.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  requireAdminOrStaff,
  requirePageAccess,
  corsHeaders,
} from "../_shared/adminPaymentGate.ts";
import {
  isCommissionWalletWorkflowEnabled,
  planAdminCommissionWalletCredit,
  planWelcomeCreditAutoGrant,
  validateAdminCommissionWalletCreditContext,
  validateAdminCommissionCreditReason,
  normalizeAdminCommissionCreditType,
  isWelcomeCommissionWalletLedgerEntry,
  buildAdminCommissionWalletCreditIdempotencyKey,
  buildCommissionWalletWelcomeIdempotencyKey,
  planManualPromotionalCampaignCredit,
  isCampaignActiveInWindow,
  ADMIN_COMMISSION_CREDIT_KIND,
  COMMISSION_WALLET_ENTRY_TYPE,
  COMMISSION_WALLET_CAMPAIGN_TYPE,
  COMMISSION_WALLET_CLAIM_KIND,
} from "../../../shared/commissionWalletSSOT.ts";

const PAGE_SLUG = "commission-wallet";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const staffGate = await requireAdminOrStaff(req);
    if (!staffGate.ok) return staffGate.response;
    const gate = await requirePageAccess(staffGate, PAGE_SLUG);
    if (!gate.ok) return gate.response;

    const body = await req.json().catch(() => ({})) as {
      driver_id?: string;
      service_area_id?: string;
      amount_minor?: number;
      currency?: string;
      credit_kind?: string;
      credit_type?: string;
      reason?: string;
      campaign_id?: string | null;
      internal_reference?: string | null;
      correction_direction?: "credit" | "debit";
      idempotency_key?: string;
    };

    const driverId = String(body.driver_id ?? "").trim();
    const serviceAreaId = String(body.service_area_id ?? "").trim();
    const currency = String(body.currency ?? "").trim().toUpperCase();
    const creditKindRaw = String(body.credit_type ?? body.credit_kind ?? "").trim().toUpperCase();
    const creditKind = normalizeAdminCommissionCreditType(creditKindRaw);
    const amountMinor = Math.round(Number(body.amount_minor) || 0);
    const campaignId = body.campaign_id ? String(body.campaign_id).trim() : null;
    const internalReference = body.internal_reference != null
      ? String(body.internal_reference).trim() || null
      : null;

    if (!driverId || !serviceAreaId || !currency) {
      return json({ success: false, error: "driver_id, service_area_id, currency required" }, 400);
    }

    const reasonGate = validateAdminCommissionCreditReason(body.reason);
    if (!reasonGate.ok) {
      return json({ success: false, error: reasonGate.error, code: reasonGate.code }, 400);
    }
    const reason = reasonGate.reason;

    if (!creditKind) {
      return json({
        success: false,
        error: "Invalid credit type",
        code: "INVALID_KIND",
      }, 400);
    }

    if (gate.userId === "service-role" || !/^[0-9a-f-]{36}$/i.test(gate.userId)) {
      return json({
        success: false,
        error: "Authenticated admin/staff user required for Commission Wallet credit",
        code: "ADMIN_USER_REQUIRED",
      }, 403);
    }
    const adminUserId = gate.userId;

    let adminDisplayName: string | null = null;
    {
      const { data: staff } = await gate.supabase
        .from("staff_profiles")
        .select("full_name")
        .eq("user_id", adminUserId)
        .maybeSingle();
      const name = String(staff?.full_name ?? "").trim();
      adminDisplayName = name || null;
    }

    const { data: sa, error: saErr } = await gate.supabase
      .from("service_areas")
      .select(
        "id, region_id, financial_model, commission_wallet_enabled, commission_wallet_currency, currency_code, welcome_credit_enabled, welcome_credit_amount_minor, welcome_credit_max_drivers",
      )
      .eq("id", serviceAreaId)
      .maybeSingle();

    if (saErr || !sa) {
      return json({ success: false, error: "Service area not found" }, 404);
    }

    const expectedCurrency = String(
      sa.commission_wallet_currency || sa.currency_code || "",
    ).toUpperCase();

    const { data: driver, error: driverErr } = await gate.supabase
      .from("drivers")
      .select("id, service_area_id, region_id, approval_status, driver_status, deleted_at")
      .eq("id", driverId)
      .maybeSingle();
    if (driverErr) {
      return json({ success: false, error: driverErr.message }, 500);
    }

    const contextGate = validateAdminCommissionWalletCreditContext({
      driverFound: Boolean(driver?.id) && !driver?.deleted_at,
      driverServiceAreaId: driver?.service_area_id,
      selectedServiceAreaId: serviceAreaId,
      financialModel: sa.financial_model,
      commissionWalletEnabled: sa.commission_wallet_enabled,
      expectedCurrency,
      requestedCurrency: currency,
    });
    if (!contextGate.ok) {
      return json({ success: false, error: contextGate.error, code: contextGate.code }, 400);
    }

    const walletEnabled = isCommissionWalletWorkflowEnabled({
      financial_model: sa.financial_model,
      commission_wallet_enabled: sa.commission_wallet_enabled,
    });

    const plan = planAdminCommissionWalletCredit({
      kind: creditKind,
      amountMinor,
      correctionDirection: body.correction_direction,
      walletEnabled,
    });

    if (!plan.ok) {
      const code = plan.code === "WALLET_DISABLED"
        ? "COMMISSION_WALLET_DISABLED"
        : plan.code;
      return json({ success: false, error: plan.error, code }, 400);
    }

    const idempotencyKey = String(
      body.idempotency_key?.trim()
        || (creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT
          ? buildCommissionWalletWelcomeIdempotencyKey(driverId, serviceAreaId)
          : buildAdminCommissionWalletCreditIdempotencyKey({
            driverId,
            serviceAreaId,
            creditKind,
            amountMinor,
            reason,
            direction: plan.direction,
          })),
    );

    let resolvedCampaignId = campaignId;
    let campaignRow: {
      id: string;
      campaign_type: string;
      currency: string;
      active: boolean | null;
      start_at: string | null;
      end_at: string | null;
    } | null = null;

    if (resolvedCampaignId) {
      const { data: camp, error: campErr } = await gate.supabase
        .from("commission_wallet_campaigns")
        .select("id, campaign_type, currency, active, start_at, end_at")
        .eq("id", resolvedCampaignId)
        .eq("service_area_id", serviceAreaId)
        .maybeSingle();
      if (campErr) {
        return json({ success: false, error: campErr.message }, 500);
      }
      if (!camp) {
        return json({ success: false, error: "Campaign not found for service area", code: "CAMPAIGN_NOT_FOUND" }, 404);
      }
      campaignRow = camp;
    }

    if (creditKind === ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT) {
      const promoGate = planManualPromotionalCampaignCredit({
        walletEnabled,
        campaign: campaignRow,
        amountMinor,
        currency,
      });
      if (!promoGate.ok) {
        return json({ success: false, error: promoGate.error, code: promoGate.code }, 400);
      }
      resolvedCampaignId = campaignRow!.id;
    }

    if (creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT && resolvedCampaignId) {
      const type = String(campaignRow?.campaign_type ?? "").toUpperCase();
      if (type !== COMMISSION_WALLET_CAMPAIGN_TYPE.WELCOME_CREDIT) {
        return json({
          success: false,
          error: "campaign_id for welcome must be WELCOME_CREDIT",
          code: "CAMPAIGN_TYPE_MISMATCH",
        }, 400);
      }
      if (!campaignRow || !isCampaignActiveInWindow(campaignRow)) {
        return json({ success: false, error: "Welcome campaign is not active", code: "INACTIVE" }, 400);
      }
    }

    if (creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT && !resolvedCampaignId) {
      const { data: welcomeCamps } = await gate.supabase
        .from("commission_wallet_campaigns")
        .select("id, campaign_type, currency, active, start_at, end_at")
        .eq("service_area_id", serviceAreaId)
        .eq("campaign_type", COMMISSION_WALLET_CAMPAIGN_TYPE.WELCOME_CREDIT)
        .eq("active", true)
        .limit(5);
      const auto = (welcomeCamps ?? []).find((c) => isCampaignActiveInWindow(c));
      if (auto) {
        campaignRow = auto;
        resolvedCampaignId = auto.id;
      }
    }

    const ensureAudit = async (ledgerEntryId: string) => {
      const { data: existingAudit } = await gate.supabase
        .from("commission_wallet_admin_audit")
        .select("id")
        .eq("ledger_entry_id", ledgerEntryId)
        .maybeSingle();
      if (existingAudit?.id) {
        return { ok: true as const, audit_id: existingAudit.id, backfilled: false };
      }
      const { data: auditRow, error: auditErr } = await gate.supabase
        .from("commission_wallet_admin_audit")
        .insert({
          admin_user_id: adminUserId,
          driver_id: driverId,
          service_area_id: serviceAreaId,
          action: plan.audit_action,
          credit_type: plan.credit_type,
          amount_minor: plan.amount_minor,
          currency,
          reason,
          campaign_id: resolvedCampaignId,
          ledger_entry_id: ledgerEntryId,
          metadata: {
            direction: plan.direction,
            credit_type: plan.credit_type,
            credit_kind: creditKind,
            entry_type: plan.entry_type,
            idempotency_key: idempotencyKey,
            admin_display_name: adminDisplayName,
            ...(internalReference ? { internal_reference: internalReference } : {}),
          },
        })
        .select("id")
        .single();
      if (auditErr) {
        const { data: raced } = await gate.supabase
          .from("commission_wallet_admin_audit")
          .select("id")
          .eq("ledger_entry_id", ledgerEntryId)
          .maybeSingle();
        if (raced?.id) {
          return { ok: true as const, audit_id: raced.id, backfilled: true };
        }
        return { ok: false as const, error: auditErr.message };
      }
      return { ok: true as const, audit_id: auditRow.id, backfilled: true };
    };

    const ensureClaim = async (ledgerEntryId: string, amountForClaim: number) => {
      if (!resolvedCampaignId) return { ok: true as const, claim_id: null as string | null };
      if (
        creditKind !== ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT
        && creditKind !== ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT
      ) {
        return { ok: true as const, claim_id: null as string | null };
      }
      const claimKind = creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT
        ? COMMISSION_WALLET_CLAIM_KIND.WELCOME
        : COMMISSION_WALLET_CLAIM_KIND.MANUAL;
      const claimKey = claimKind === COMMISSION_WALLET_CLAIM_KIND.WELCOME
        ? `cw_welcome_claim_${resolvedCampaignId}_${driverId}`.slice(0, 180)
        : `cw_manual_claim_${idempotencyKey}`.slice(0, 180);
      const { data: existingClaim } = await gate.supabase
        .from("commission_wallet_campaign_claims")
        .select("id")
        .eq("idempotency_key", claimKey)
        .maybeSingle();
      if (existingClaim?.id) {
        return { ok: true as const, claim_id: existingClaim.id };
      }
      const { data: claimRow, error: claimErr } = await gate.supabase
        .from("commission_wallet_campaign_claims")
        .insert({
          campaign_id: resolvedCampaignId,
          driver_id: driverId,
          service_area_id: serviceAreaId,
          claim_kind: claimKind,
          ledger_entry_id: ledgerEntryId,
          amount_minor: amountForClaim,
          idempotency_key: claimKey,
          metadata: { credit_type: creditKind, credit_kind: creditKind, phase: "phase5_admin_credit" },
        })
        .select("id")
        .single();
      if (claimErr) {
        if (claimErr.code === "23505") {
          const { data: raced } = await gate.supabase
            .from("commission_wallet_campaign_claims")
            .select("id")
            .eq("idempotency_key", claimKey)
            .maybeSingle();
          if (raced?.id) return { ok: true as const, claim_id: raced.id };
        }
        return { ok: false as const, error: claimErr.message };
      }
      return { ok: true as const, claim_id: claimRow.id };
    };

    const returnIdempotent = async (entry: {
      id: string;
      entry_type?: string;
      amount_minor?: number;
      direction?: string;
      created_at?: string;
    }) => {
      const audit = await ensureAudit(entry.id);
      if (!audit.ok) {
        console.error("[admin-commission-wallet-credit] audit backfill failed", audit.error);
        return json({
          success: false,
          error: `Ledger exists but audit write failed: ${audit.error}`,
          ledger_entry_id: entry.id,
          code: "AUDIT_WRITE_FAILED",
        }, 500);
      }
      const claim = await ensureClaim(entry.id, Math.round(Number(entry.amount_minor) || amountMinor));
      if (!claim.ok) {
        console.error("[admin-commission-wallet-credit] claim backfill failed", claim.error);
        return json({
          success: false,
          error: `Ledger exists but claim write failed: ${claim.error}`,
          ledger_entry_id: entry.id,
          code: "CLAIM_WRITE_FAILED",
        }, 500);
      }
      return json({
        success: true,
        idempotent: true,
        ledger_entry_id: entry.id,
        entry,
        campaign_id: resolvedCampaignId,
        audit_id: audit.audit_id,
        audit_backfilled: audit.backfilled,
        claim_id: claim.claim_id,
      });
    };

    // Idempotency first — replays must succeed even after welcome credit already posted.
    const { data: existing } = await gate.supabase
      .from("driver_commission_wallet_ledger")
      .select("id, entry_type, amount_minor, direction, created_at")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existing?.id) {
      return await returnIdempotent(existing);
    }

    if (creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT) {
      const { data: welcomeCandidateRows, error: welcomeErr } = await gate.supabase
        .from("driver_commission_wallet_ledger")
        .select("driver_id, entry_type, metadata")
        .eq("service_area_id", serviceAreaId)
        .in("entry_type", [
          COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT,
          COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
        ]);
      if (welcomeErr) {
        return json({ success: false, error: welcomeErr.message }, 500);
      }
      const welcomeRows = (welcomeCandidateRows ?? []).filter((r) =>
        isWelcomeCommissionWalletLedgerEntry(r)
      );
      const distinctWelcomeDrivers = new Set(
        welcomeRows.map((r) => String(r.driver_id)),
      );
      const welcomeGate = planWelcomeCreditAutoGrant({
        walletEnabled,
        driverAssignedToServiceArea: true,
        welcomeCreditEnabled: Boolean(sa.welcome_credit_enabled),
        welcomeCreditAmountMinor: sa.welcome_credit_amount_minor,
        welcomeCreditMaxDrivers: sa.welcome_credit_max_drivers,
        driverAlreadyHasWelcomeCredit: distinctWelcomeDrivers.has(driverId),
        distinctWelcomeDriversCount: distinctWelcomeDrivers.size,
        driverId,
        serviceAreaId,
      });
      if (!welcomeGate.ok) {
        return json({ success: false, error: welcomeGate.error, code: welcomeGate.code }, 400);
      }
      // Prefer SSOT amount when SA policy is the source of truth (auto + manual welcome).
      if (welcomeGate.amount_minor !== amountMinor) {
        return json({
          success: false,
          error: `Welcome amount must be ${welcomeGate.amount_minor} minor units`,
          code: "WELCOME_CREDIT_AMOUNT_MISMATCH",
        }, 400);
      }
    }

    const { data: entry, error: insertErr } = await gate.supabase
      .from("driver_commission_wallet_ledger")
      .insert({
        driver_id: driverId,
        service_area_id: serviceAreaId,
        region_id: sa.region_id ?? null,
        currency,
        entry_type: plan.entry_type,
        amount_minor: plan.amount_minor,
        direction: plan.direction,
        campaign_id: resolvedCampaignId,
        admin_user_id: adminUserId,
        reason,
        credit_type: plan.credit_type,
        promotional_portion_minor: plan.direction === "credit" && plan.balance_bucket === "promotional"
          ? plan.amount_minor
          : 0,
        purchased_portion_minor: 0,
        idempotency_key: idempotencyKey,
        metadata: {
          credit_type: plan.credit_type,
          credit_kind: creditKind,
          balance_bucket: plan.balance_bucket,
          phase: "phase5_admin_credit",
          admin_display_name: adminDisplayName,
          ...(internalReference ? { internal_reference: internalReference } : {}),
        },
      })
      .select("id, entry_type, credit_type, amount_minor, direction, created_at, reason, admin_user_id")
      .single();

    if (insertErr) {
      if (insertErr.code === "23505") {
        const { data: racedByKey } = await gate.supabase
          .from("driver_commission_wallet_ledger")
          .select("id, entry_type, amount_minor, direction, created_at")
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();
        if (racedByKey?.id) {
          return await returnIdempotent(racedByKey);
        }
        if (creditKind === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT) {
          const { data: racedWelcomeCandidates } = await gate.supabase
            .from("driver_commission_wallet_ledger")
            .select("id, entry_type, amount_minor, direction, created_at, metadata")
            .eq("driver_id", driverId)
            .eq("service_area_id", serviceAreaId)
            .in("entry_type", [
              COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT,
              COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
            ]);
          const racedWelcome = (racedWelcomeCandidates ?? []).find((r) =>
            isWelcomeCommissionWalletLedgerEntry(r)
          );
          if (racedWelcome?.id) {
            return await returnIdempotent(racedWelcome);
          }
        }
      }
      console.error("[admin-commission-wallet-credit] insert failed", insertErr);
      return json({ success: false, error: insertErr.message }, 500);
    }

    const audit = await ensureAudit(entry.id);
    if (!audit.ok) {
      console.error("[admin-commission-wallet-credit] audit insert failed", audit.error);
      return json({
        success: false,
        error: `Ledger credited but audit write failed: ${audit.error}`,
        ledger_entry_id: entry.id,
        code: "AUDIT_WRITE_FAILED",
      }, 500);
    }

    const claim = await ensureClaim(entry.id, plan.amount_minor);
    if (!claim.ok) {
      console.error("[admin-commission-wallet-credit] claim insert failed", claim.error);
      return json({
        success: false,
        error: `Ledger credited but claim write failed: ${claim.error}`,
        ledger_entry_id: entry.id,
        code: "CLAIM_WRITE_FAILED",
      }, 500);
    }

    return json({
      success: true,
      ledger_entry_id: entry.id,
      entry,
      credit_type: plan.credit_type,
      entry_type: plan.entry_type,
      reason,
      campaign_id: resolvedCampaignId,
      audit_action: plan.audit_action,
      audit_id: audit.audit_id,
      claim_id: claim.claim_id,
    });
  } catch (err) {
    console.error("[admin-commission-wallet-credit]", err);
    return json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
