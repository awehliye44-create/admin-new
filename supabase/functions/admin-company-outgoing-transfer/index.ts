/**
 * Slice 11 — Company outgoing transfer approval + execution gate.
 * Non-money workflow (draft / submit / approve / reject / cancel) allowed.
 * Live Revolut /pay / mark_paid / retry blocked while
 * LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED=false (default).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import {
  assertCompanyTransferMoneySource,
  COMPANY_TRANSFER_CATEGORIES,
  COMPANY_TRANSFER_RECIPIENT_TYPES,
  resolveEnforcedCompanyTransferMoneySource,
} from "../_shared/companyOutgoingTransferSSOT.ts";
import {
  DEFAULT_COMPANY_TRANSFER_APPROVAL_TIERS,
  resolveCompanyTransferApprovalsRequiredForCategory,
  assertDirectTransferAllowed,
} from "../_shared/companyOutgoingTransferApprovalSSOT.ts";
import { resolveLiveCompanyBalanceWithSlice10Gate } from "../_shared/companyBalanceResolveSSOT.ts";
import { loadActiveOperationalReservePolicy } from "../_shared/companyOperationalReserveLoadSSOT.ts";
import {
  loadProtectedDriverLiabilityPence,
  loadReservedDriverPayoutPence,
} from "../_shared/companyBalanceCompositionLoadSSOT.ts";
import {
  evaluateSoleAdminCompanyTransferSelfApproval,
  isCompanyTransferPayeeProviderVerified,
  parseSoleAdminCtAllowedTransferTypes,
  parseSoleAdminCtLimitPence,
  parseSoleAdminCtSettingEnabled,
  SOLE_ADMIN_CT_ELIGIBLE_APPROVER_ROLES,
  SOLE_ADMIN_CT_SETTING,
  soleAdminCtReasonLabel,
} from "../_shared/companyTransferSoleAdminApprovalSSOT.ts";
import {
  assertCompanyTransferSelfApprovalPolicy,
  buildCompanyTransferFundingSnapshot,
  canTransitionCompanyTransferStatus,
  COMPANY_TRANSFER_GATE_REASON,
  companyTransferGateReasonLabel,
  evaluateCompanyTransferExecutionGate,
  evaluateCompanyTransferFundingGate,
  isCompanyTransferMoneyMovingAction,
  LIVE_COMPANY_TRANSFER_EXECUTION_SETTING_KEY,
  parseAdminSettingEnabled,
  parseLiveCompanyTransferExecutionEnabled,
  resolveLiveCompanyTransferExecutionEnabledFailClosed,
  type CompanyTransferFundingSnapshot,
} from "../_shared/companyTransferLifecycleSSOT.ts";
import type { CompanyBalanceSnapshot } from "../../../shared/companyBalanceSSOT.ts";
import {
  resolveCompanyTransferPaymentReferenceKind,
  sanitizeCompanyTransferStatementReference,
} from "../../../shared/companyTransferPaymentReferenceSSOT.ts";
import {
  evaluatePreDraftCompanyFundsGate,
  isAmountValidationOnlyBlock,
  canSafelyAdminMutateCompanyTransfer,
  canReturnCompanyTransferToDraft,
  canCancelCompanyTransferSafely,
  resolveAvailableCompanyFundsPenceFromBalance,
} from "../../../shared/companyTransferDraftValidationSSOT.ts";
import {
  companyFundsPrecheckPasses,
  resolvePrecheckAvailableCompanyFundsPence,
} from "../../../shared/companyTransferCreatePrecheckSSOT.ts";

async function loadProviderPaymentIdForTransfer(
  supabase: { from: (t: string) => any },
  transferId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("company_transfer_payment_intents")
    .select("provider_payment_id")
    .eq("transfer_id", transferId)
    .not("provider_payment_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const id = data?.provider_payment_id;
  return id ? String(id) : null;
}

async function loadLiveCompanyTransferExecutionEnabled(
  supabase: { from: (t: string) => any },
): Promise<boolean> {
  try {
    const envEnabled = parseLiveCompanyTransferExecutionEnabled((k) => Deno.env.get(k));
    const { data } = await supabase
      .from("admin_settings")
      .select("setting_value")
      .eq("setting_key", LIVE_COMPANY_TRANSFER_EXECUTION_SETTING_KEY)
      .maybeSingle();
    const settingsEnabled = parseAdminSettingEnabled(data?.setting_value);
    return resolveLiveCompanyTransferExecutionEnabledFailClosed({
      env_enabled: envEnabled,
      admin_settings_enabled: settingsEnabled,
    });
  } catch {
    return false;
  }
}

function moneyMovingBlockedResponse(action: string) {
  return jsonResponse({
    success: false,
    ok: false,
    error_code: COMPANY_TRANSFER_GATE_REASON.LIVE_EXECUTION_DISABLED,
    error: `Company transfer action '${action}' blocked while LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED=false`,
    live_company_transfer_execution_enabled: false,
    live_payout_execution_enabled: false,
    money_moved: false,
  }, 200); // Lovable treats non-2xx as blank-screen RUNTIME_ERROR
}

const CreateSchema = z.object({
  action: z.literal("create"),
  recipient_name: z.string().min(1).max(200).optional(),
  recipient_type: z.enum(COMPANY_TRANSFER_RECIPIENT_TYPES as unknown as [string, ...string[]]).optional(),
  category: z.enum(COMPANY_TRANSFER_CATEGORIES as unknown as [string, ...string[]]),
  money_source: z.string().optional(),
  source_account: z.string().max(200).nullable().optional(),
  destination_account: z.string().max(200).nullable().optional(),
  payee_id: z.string().uuid().nullable().optional(),
  amount_pence: z.number().int().positive(),
  approved_amount_pence: z.number().int().positive().nullable().optional(),
  currency: z.string().default("GBP"),
  purpose: z.string().min(1).max(500),
  /** Ignored when present — backend always allocates SSOT payment_reference. */
  payment_reference: z.string().max(140).optional(),
  /** Optional custom statement label — never replaces SSOT payment_reference. */
  statement_reference: z.string().max(100).nullable().optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
  execution_mode: z.enum(["DRAFT_FOR_APPROVAL", "DIRECT_TRANSFER"]).optional().default("DRAFT_FOR_APPROVAL"),
  service_area_id: z.string().uuid().nullable().optional(),
  cost_centre: z.string().max(120).nullable().optional(),
  provider: z.string().max(80).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  attachment_url: z.string().max(2000).nullable().optional(),
  idempotency_key: z.string().min(8).max(200),
  /** Slice 11: create as DRAFT by default (no funding debit). */
  as_draft: z.boolean().optional().default(true),
  /**
   * COMPANY_OUTGOING (default) or CERTIFICATION (£0.01 proof / audit-only classification).
   * CERTIFICATION rows stay in History/Audit and are excluded from operational expense totals.
   */
  transfer_type: z.enum(["COMPANY_OUTGOING", "COMPANY_INTERNAL", "COMPANY_PAYABLE", "CERTIFICATION"])
    .optional()
    .default("COMPANY_OUTGOING"),
});

const SubmitSchema = z.object({
  action: z.literal("submit_for_approval"),
  transfer_id: z.string().uuid(),
});

const CancelSchema = z.object({
  action: z.literal("cancel"),
  transfer_id: z.string().uuid(),
  reason: z.string().min(1).max(500),
});

const ExecuteSchema = z.object({
  action: z.literal("execute"),
  transfer_id: z.string().uuid(),
  execute_live: z.boolean().optional().default(false),
});

const ApproveSchema = z.object({
  action: z.literal("approve"),
  transfer_id: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
  /** Required for sole-admin self-approval when LIVE four-eyes would block. */
  confirm_sole_admin_approval: z.boolean().optional(),
  override_reason: z.string().max(500).nullable().optional(),
});

const RejectSchema = z.object({
  action: z.literal("reject"),
  transfer_id: z.string().uuid(),
  reason: z.string().min(1).max(500),
});

const MarkPaidSchema = z.object({
  action: z.literal("mark_paid"),
  transfer_id: z.string().uuid(),
  provider: z.string().min(1).max(80),
  provider_reference: z.string().min(1).max(200),
  execution_at: z.string().datetime().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const RetrySchema = z.object({
  action: z.literal("retry"),
  transfer_id: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
});

const MarkReadySchema = z.object({
  action: z.literal("mark_ready_for_execution"),
  transfer_id: z.string().uuid(),
});

const ViewEvidenceSchema = z.object({
  action: z.literal("view_evidence"),
  transfer_id: z.string().uuid(),
});

const EditDraftSchema = z.object({
  action: z.literal("edit_draft"),
  transfer_id: z.string().uuid(),
  amount_pence: z.number().int().positive().optional(),
  approved_amount_pence: z.number().int().positive().nullable().optional(),
  category: z.enum(COMPANY_TRANSFER_CATEGORIES as unknown as [string, ...string[]]).optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
  cost_centre: z.string().max(120).nullable().optional(),
  attachment_url: z.string().max(2000).nullable().optional(),
  purpose: z.string().min(1).max(500).optional(),
  payee_id: z.string().uuid().nullable().optional(),
  statement_reference: z.string().max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const ReturnToDraftSchema = z.object({
  action: z.literal("return_to_draft"),
  transfer_id: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
});

const InputSchema = z.discriminatedUnion("action", [
  CreateSchema,
  SubmitSchema,
  ApproveSchema,
  RejectSchema,
  MarkPaidSchema,
  RetrySchema,
  CancelSchema,
  ExecuteSchema,
  MarkReadySchema,
  ViewEvidenceSchema,
  EditDraftSchema,
  ReturnToDraftSchema,
]);

async function loadApprovalTiers(supabase: { from: (t: string) => any }) {
  const { data } = await supabase
    .from("admin_settings")
    .select("setting_key, setting_value")
    .in("setting_key", [
      "company_transfer_approval_single_max_pence",
      "company_transfer_approval_dual_max_pence",
      "company_transfer_allow_self_approval",
      SOLE_ADMIN_CT_SETTING.ENABLED,
      SOLE_ADMIN_CT_SETTING.LIMIT_PENCE,
      SOLE_ADMIN_CT_SETTING.ALLOWED_TYPES,
    ]);
  const map: Record<string, unknown> = {};
  for (const row of data ?? []) map[row.setting_key] = row.setting_value;
  const parse = (raw: unknown, fallback: number) => {
    const n = Number(String(raw ?? "").replace(/^"|"$/g, ""));
    return Number.isFinite(n) ? Math.round(n) : fallback;
  };
  const selfRaw = String(map.company_transfer_allow_self_approval ?? "false")
    .replace(/^"|"$/g, "")
    .trim()
    .toLowerCase();
  return {
    single_max_pence: parse(
      map.company_transfer_approval_single_max_pence,
      DEFAULT_COMPANY_TRANSFER_APPROVAL_TIERS.single_max_pence,
    ),
    dual_max_pence: parse(
      map.company_transfer_approval_dual_max_pence,
      DEFAULT_COMPANY_TRANSFER_APPROVAL_TIERS.dual_max_pence,
    ),
    allow_self_approval: selfRaw === "true",
    sole_admin_enabled: parseSoleAdminCtSettingEnabled(
      map[SOLE_ADMIN_CT_SETTING.ENABLED],
    ),
    sole_admin_limit_pence: parseSoleAdminCtLimitPence(
      map[SOLE_ADMIN_CT_SETTING.LIMIT_PENCE],
    ),
    sole_admin_allowed_types: parseSoleAdminCtAllowedTransferTypes(
      map[SOLE_ADMIN_CT_SETTING.ALLOWED_TYPES],
    ),
  };
}

async function loadActorStaffRole(
  supabase: { from: (t: string) => any },
  userId: string | null,
): Promise<string | null> {
  if (!userId || userId === "service-role") return null;
  const { data } = await supabase
    .from("staff_profiles")
    .select("role")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  return data?.role ? String(data.role) : null;
}

/** Authoritative Owner: staff_profiles.is_owner (never email / role===super_admin alone). */
async function loadActorIsOwner(
  supabase: { from: (t: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any },
  userId: string | null,
): Promise<boolean> {
  if (!userId || userId === "service-role") return false;
  const { data } = await supabase
    .from("staff_profiles")
    .select("is_owner")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  if (data?.is_owner === true) return true;
  // Fallback to public.is_owner(user_id) when column absent / stale profile row.
  if (typeof supabase.rpc === "function") {
    try {
      const { data: rpcOwner } = await supabase.rpc("is_owner", { _user_id: userId });
      return rpcOwner === true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Other active staff who can approve company transfers (excl. requester). */
async function countOtherEligibleCompanyTransferApprovers(
  supabase: { from: (t: string) => any },
  requesterId: string | null | undefined,
): Promise<number> {
  const requester = String(requesterId ?? "").trim();
  let q = supabase
    .from("staff_profiles")
    .select("user_id", { count: "exact", head: true })
    .eq("is_active", true)
    .in("role", [...SOLE_ADMIN_CT_ELIGIBLE_APPROVER_ROLES]);
  if (requester) q = q.neq("user_id", requester);
  const { count, error } = await q;
  if (error) {
    console.warn("[ct-sole-admin] approver count failed", error.message);
    // Fail closed: pretend another approver exists so sole-admin cannot bypass.
    return 1;
  }
  return Number(count ?? 0);
}

async function appendAudit(
  supabase: { from: (t: string) => any },
  args: {
    transfer_id: string;
    actor_id: string | null;
    requester_id?: string | null;
    approver_id?: string | null;
    event_type: string;
    old_status?: string | null;
    new_status?: string | null;
    provider?: string | null;
    provider_reference?: string | null;
    amount_pence?: number | null;
    currency?: string | null;
    reason?: string | null;
    attachment_url?: string | null;
    metadata?: Record<string, unknown> | null;
    live_company_transfer_execution_enabled?: boolean;
  },
) {
  await supabase.from("company_outgoing_transfer_audit").insert({
    transfer_id: args.transfer_id,
    actor_id: args.actor_id,
    requester_id: args.requester_id ?? null,
    approver_id: args.approver_id ?? null,
    event_type: args.event_type,
    old_status: args.old_status ?? null,
    new_status: args.new_status ?? null,
    provider: args.provider ?? null,
    provider_reference: args.provider_reference ?? null,
    amount_pence: args.amount_pence ?? null,
    currency: args.currency ?? null,
    reason: args.reason ?? null,
    attachment_url: args.attachment_url ?? null,
    metadata: {
      ...(args.metadata ?? {}),
      money_moved: false,
      live_company_transfer_execution_enabled:
        args.live_company_transfer_execution_enabled === true,
    },
  });
}

async function actorIsOwnerAdmin(
  supabase: { from: (t: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any },
  userId: string | null,
): Promise<boolean> {
  // Authoritative Owner identity — staff_profiles.is_owner / public.is_owner.
  // Do not use email or legacy user_roles.role = admin.
  return await loadActorIsOwner(supabase, userId);
}

async function captureFundingSnapshot(args: {
  supabase: any;
  service_area_id: string | null;
  currency: string;
  capture_phase: CompanyTransferFundingSnapshot["capture_phase"];
}): Promise<{
  company_balance: CompanyBalanceSnapshot;
  funding_snapshot: CompanyTransferFundingSnapshot;
  reserve_policy_id: string | null;
}> {
  // Same composition inputs as admin-payout-ledger company_list — without these,
  // final_company_available_pence stays null and pre-draft incorrectly returns
  // AVAILABLE_FUNDS_UNKNOWN while the ledger UI shows Available Company Funds.
  const [liability, reserved, reserveLoaded] = await Promise.all([
    loadProtectedDriverLiabilityPence(args.supabase, args.service_area_id),
    loadReservedDriverPayoutPence(args.supabase, args.service_area_id),
    loadActiveOperationalReservePolicy(args.supabase, {
      service_area_id: args.service_area_id,
      currency: args.currency,
    }),
  ]);

  const companyBalance = await resolveLiveCompanyBalanceWithSlice10Gate({
    supabase: args.supabase,
    service_area_id: args.service_area_id,
    currency: args.currency,
    approved_payables_pending_pence: 0,
    driver_liability_pence: liability.amount_pence,
    driver_payout_reserved_pence: reserved.amount_pence,
    customer_refund_reserved_pence: null,
  });

  const reserveSection = companyBalance.sections?.operational_reserve;
  const policyActive = String(reserveLoaded.policy?.status ?? "").toUpperCase() === "ACTIVE";
  const reserveAmount = companyBalance.operational_reserve_pence;
  // Section status uses AVAILABLE when amount is present; funding gate requires ACTIVE.
  // Prefer policy row status when amount resolved — never mislabel ACTIVE policy as NOT_CONFIGURED.
  const reserveStatus = reserveAmount != null && policyActive
    ? "ACTIVE"
    : reserveAmount != null
      && ["ACTIVE", "AVAILABLE"].includes(String(reserveSection?.status ?? "").toUpperCase())
    ? "ACTIVE"
    : (reserveSection?.status
      ?? (reserveAmount == null ? "NOT_CONFIGURED" : "ACTIVE"));
  const reserveReason = reserveAmount != null
    ? null
    : (reserveSection?.reason_code
      ?? reserveLoaded.error_code
      ?? null);

  const funding_snapshot = buildCompanyTransferFundingSnapshot({
    capture_phase: args.capture_phase,
    service_area_id: args.service_area_id,
    currency: args.currency,
    source_balance_pence: companyBalance.provider_available_balance_pence
      ?? companyBalance.provider_cash_balance_pence,
    protected_liabilities_pence: companyBalance.driver_liability_pence
      ?? companyBalance.sections?.driver_liabilities?.amount_pence
      ?? null,
    reserved_driver_payouts_pence: companyBalance.driver_payout_reserved_pence
      ?? companyBalance.sections?.reserved_driver_payouts?.amount_pence
      ?? null,
    approved_payables_pence: companyBalance.approved_company_payables_pence
      ?? companyBalance.sections?.approved_company_payables?.amount_pence
      ?? null,
    classified_company_cash_pence: companyBalance.classified_company_cash_pence ?? null,
    eligible_company_cash_pence: companyBalance.company_available_before_operational_reserve_pence,
    transferable_base_pence: companyBalance.transferable_base_pence ?? null,
    operational_reserve_pence: reserveAmount,
    operational_reserve_status: reserveStatus,
    operational_reserve_reason_code: reserveReason,
    reserve_policy_id: reserveLoaded.policy?.id ?? null,
    final_company_available_pence: companyBalance.final_company_available_pence
      ?? companyBalance.company_available_for_transfer_pence,
    source_account_id: companyBalance.source_account_id,
  });

  return {
    company_balance: companyBalance,
    funding_snapshot,
    reserve_policy_id: reserveLoaded.policy?.id ?? null,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gate = await requireAdminOrStaff(req);
    if (!gate.ok) return gate.response;

    const body = await req.json().catch(() => ({}));
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ success: false, error: "Invalid input", details: parsed.error.flatten() }, 200);
    }

    const actorId = gate.userId === "service-role" ? null : gate.userId;
    const input = parsed.data;
    const supabase = gate.supabase;
    const liveCompanyExec = await loadLiveCompanyTransferExecutionEnabled(supabase);
    const audit = (
      args: Parameters<typeof appendAudit>[1],
    ) => appendAudit(supabase, {
      ...args,
      live_company_transfer_execution_enabled: liveCompanyExec,
    });

    // Slice 11: only money-moving actions require live company transfer execution.
    if (isCompanyTransferMoneyMovingAction(input.action) && !liveCompanyExec) {
      return moneyMovingBlockedResponse(input.action);
    }
    if (input.action === "execute" && input.execute_live === true && !liveCompanyExec) {
      return moneyMovingBlockedResponse("execute");
    }

    if (input.action === "create") {
      let recipientName = input.recipient_name ?? "";
      let recipientType = input.recipient_type ?? "OTHER";
      let destinationAccount = input.destination_account ?? null;
      let revolutCounterpartyId: string | null = null;
      let revolutRecipientAccountId: string | null = null;
      let payeeId = input.payee_id ?? null;
      let sourceAccountId: string | null = null;

      if (payeeId) {
        const { data: payee, error: payeeErr } = await supabase
          .from("company_payees")
          .select("*")
          .eq("id", payeeId)
          .maybeSingle();
        if (payeeErr || !payee) {
          return jsonResponse({ success: false, error: "PAYEE_NOT_FOUND" }, 200);
        }
        if (!payee.active || payee.paused) {
          return jsonResponse({ success: false, error: "PAYEE_INACTIVE", error_code: "PAYEE_INACTIVE" }, 200);
        }
        if (payee.archived_at) {
          return jsonResponse({ success: false, error: "PAYEE_ARCHIVED", error_code: "PAYEE_ARCHIVED" }, 200);
        }
        recipientName = String(payee.display_name || payee.legal_name);
        recipientType = String(payee.payee_type);
        destinationAccount = String(payee.masked_account ?? "••••");
        revolutCounterpartyId = payee.revolut_counterparty_id
          ? String(payee.revolut_counterparty_id)
          : null;
        revolutRecipientAccountId = payee.revolut_recipient_account_id
          ? String(payee.revolut_recipient_account_id)
          : null;
      }
      if (!recipientName) {
        return jsonResponse({ success: false, error: "recipient_name or payee_id required" }, 200);
      }

      const moneySource = resolveEnforcedCompanyTransferMoneySource({
        category: input.category,
        money_source: input.money_source,
      });
      const amountPence = input.approved_amount_pence ?? input.amount_pence;

      // Pre-draft + non-draft: never create a row when requested > Available Company Funds.
      {
        const { company_balance, funding_snapshot } = await captureFundingSnapshot({
          supabase,
          service_area_id: input.service_area_id ?? null,
          currency: input.currency ?? "GBP",
          capture_phase: "SUBMIT",
        });
        // Prefer card field (company_available_for_transfer_pence) — same as ledger UI.
        const available = resolvePrecheckAvailableCompanyFundsPence(
          company_balance,
          funding_snapshot,
        ) ?? resolveAvailableCompanyFundsPenceFromBalance(
          company_balance,
          funding_snapshot,
        );
        const preDraft = evaluatePreDraftCompanyFundsGate({
          requested_pence: amountPence,
          available_company_funds_pence: available,
        });
        // Proof path: Available £7.74 (774p) + Requested £0.01 (1p) must PASS.
        if (
          companyFundsPrecheckPasses({
            available_company_funds_pence: available,
            requested_pence: amountPence,
          })
          && !preDraft.ok
        ) {
          console.error("[admin-company-outgoing-transfer] funds gate inconsistency", {
            available,
            amountPence,
            preDraft,
          });
        }
        if (!preDraft.ok) {
          // HTTP 200 + success:false — validation UX, not a transport failure / blank screen.
          return jsonResponse({
            success: false,
            ok: false,
            error: preDraft.reason,
            error_code: preDraft.reason,
            blocked_reason_codes: [preDraft.reason],
            funds_protection: preDraft.funds_protection,
            message: preDraft.message,
            available_company_funds_pence: available,
            requested_pence: amountPence,
            company_funds_check_should_pass: companyFundsPrecheckPasses({
              available_company_funds_pence: available,
              requested_pence: amountPence,
            }),
            funding_snapshot,
            company_balance,
            draft_created: false,
            money_moved: false,
            revolut_pay_called: false,
            driver_wallet_mutated: false,
            company_balance_mutated: false,
          }, 200);
        }
        if (!input.as_draft) {
          const fundingGate = evaluateCompanyTransferFundingGate({
            amount_pence: amountPence,
            funding_snapshot,
          });
          if (!fundingGate.allowed) {
            const protection = fundingGate.funds_protection ?? null;
            return jsonResponse({
              success: false,
              error: protection?.reason ?? "FUNDING_GATE_BLOCKED",
              error_code: protection?.reason ?? fundingGate.reason_codes[0],
              blocked_reason_codes: fundingGate.reason_codes,
              funds_protection: protection,
              message: protection?.message ?? fundingGate.reason_codes.join(", "),
              funding_snapshot: fundingGate.funding_snapshot,
              draft_created: false,
              money_moved: false,
              revolut_pay_called: false,
              driver_wallet_mutated: false,
              company_balance_mutated: false,
            }, 200);
          }
        }
      }

      const tiers = await loadApprovalTiers(supabase);
      const directGate = assertDirectTransferAllowed({
        execution_mode: input.execution_mode,
        category: input.category,
        amount_pence: amountPence,
      });
      if (!directGate.ok) {
        return jsonResponse({
          success: false,
          error: directGate.status,
          error_code: directGate.status,
        }, 200);
      }
      const requirement = resolveCompanyTransferApprovalsRequiredForCategory(
        amountPence,
        input.category,
        tiers,
      );
      const transferRef = `COT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

      const { data: existing } = await supabase
        .from("company_outgoing_transfers")
        .select("*")
        .eq("idempotency_key", input.idempotency_key)
        .maybeSingle();
      if (existing) {
        return jsonResponse({ success: true, transfer: existing, idempotent: true });
      }

      const refKind = resolveCompanyTransferPaymentReferenceKind(input.transfer_type);
      const { data: allocatedRef, error: refErr } = await supabase.rpc(
        "allocate_company_transfer_payment_reference",
        { p_kind: refKind },
      );
      if (refErr || !allocatedRef || typeof allocatedRef !== "string") {
        return jsonResponse({
          success: false,
          error: refErr?.message ?? "PAYMENT_REFERENCE_ALLOCATE_FAILED",
          error_code: "PAYMENT_REFERENCE_ALLOCATE_FAILED",
        }, 500);
      }
      const paymentReference = String(allocatedRef).trim();
      const statementReference = sanitizeCompanyTransferStatementReference(
        input.statement_reference,
      );

      // Capture source_account_id evidence only (no debit).
      const { company_balance: balHint } = await captureFundingSnapshot({
        supabase,
        service_area_id: input.service_area_id ?? null,
        currency: input.currency ?? "GBP",
        capture_phase: "SUBMIT",
      });
      sourceAccountId = balHint.source_account_id;

      const initialStatus = input.as_draft
        ? "DRAFT"
        : (input.scheduled_at ? "SCHEDULED" : "AWAITING_APPROVAL");

      const { data: created, error } = await supabase
        .from("company_outgoing_transfers")
        .insert({
          transfer_ref: transferRef,
          recipient_name: recipientName,
          recipient_type: recipientType,
          category: input.category,
          money_source: moneySource,
          source_account: input.source_account ?? null,
          source_account_id: sourceAccountId,
          destination_account: destinationAccount,
          payee_id: payeeId,
          amount_pence: input.amount_pence,
          approved_amount_pence: amountPence,
          currency: input.currency.toUpperCase(),
          purpose: input.purpose,
          payment_reference: paymentReference,
          statement_reference: statementReference,
          scheduled_at: input.scheduled_at ?? null,
          execution_mode: input.execution_mode ?? "DRAFT_FOR_APPROVAL",
          revolut_counterparty_id: revolutCounterpartyId,
          revolut_recipient_account_id: revolutRecipientAccountId,
          service_area_id: input.service_area_id ?? null,
          cost_centre: input.cost_centre ?? null,
          requested_by: actorId,
          approvals_required: requirement.approvals_required,
          approval_count: 0,
          provider: input.provider ?? "revolut_business",
          status: initialStatus,
          notes: input.notes ?? null,
          attachment_url: input.attachment_url ?? null,
          idempotency_key: input.idempotency_key,
          transfer_type: input.transfer_type === "CERTIFICATION" ? "CERTIFICATION" : "COMPANY_OUTGOING",
          metadata: {
            approval_tier: requirement.tier,
            requires_owner: requirement.requires_owner,
            money_source_enforced: moneySource,
            payee_id: payeeId,
            slice11: true,
            money_moved: false,
            payment_reference: paymentReference,
            payment_reference_kind: refKind,
            payment_reference_ssot: true,
            ...(statementReference ? { statement_reference: statementReference } : {}),
            ...(input.transfer_type === "CERTIFICATION"
              ? {
                environment_record: "TEST_PROOF",
                transfer_type: "CERTIFICATION",
                // Active certification drafts remain actionable; cancelled proofs use HISTORY_ONLY.
                certification: true,
              }
              : {}),
          },
        })
        .select("*")
        .single();
      if (error || !created) {
        return jsonResponse({ success: false, error: error?.message ?? "Create failed" }, 200);
      }
      await audit({
        transfer_id: created.id,
        actor_id: actorId,
        requester_id: actorId,
        event_type: "CREATED_DRAFT",
        old_status: null,
        new_status: initialStatus,
        amount_pence: created.amount_pence,
        currency: created.currency,
        reason: input.purpose,
        attachment_url: input.attachment_url ?? null,
        metadata: {
          money_moved: false,
          payment_reference: paymentReference,
          payment_reference_kind: refKind,
          ...(statementReference ? { statement_reference: statementReference } : {}),
        },
      });
      return jsonResponse({
        success: true,
        transfer: created,
        payment_reference: paymentReference,
        live_company_transfer_execution_enabled: liveCompanyExec,
      });
    }

    const { data: transfer, error: loadErr } = await supabase
      .from("company_outgoing_transfers")
      .select("*")
      .eq("id", input.transfer_id)
      .maybeSingle();
    if (loadErr || !transfer) {
      return jsonResponse({ success: false, error: loadErr?.message ?? "Transfer not found" }, 200);
    }

    if (input.action === "view_evidence") {
      const { data: audit } = await supabase
        .from("company_outgoing_transfer_audit")
        .select("id, created_at, event_type, old_status, new_status, actor_id, reason, amount_pence, currency, metadata")
        .eq("transfer_id", transfer.id)
        .order("created_at", { ascending: true });
      return jsonResponse({
        success: true,
        transfer: {
          id: transfer.id,
          transfer_ref: transfer.transfer_ref,
          status: transfer.status,
          amount_pence: transfer.amount_pence,
          currency: transfer.currency,
          blocked_reason_codes: transfer.blocked_reason_codes ?? [],
          approval_funding_snapshot: transfer.approval_funding_snapshot ?? null,
          pre_execution_funding_snapshot: transfer.pre_execution_funding_snapshot ?? null,
          provider_transaction_id: transfer.provider_transaction_id ?? null,
          provider_reference: transfer.provider_reference ?? null,
        },
        audit: audit ?? [],
        live_company_transfer_execution_enabled: liveCompanyExec,
      });
    }

    if (input.action === "edit_draft") {
      const status = String(transfer.status).toUpperCase();
      const providerPaymentId = await loadProviderPaymentIdForTransfer(supabase, transfer.id);
      const amountOnlyBlocked = status === "BLOCKED"
        && isAmountValidationOnlyBlock(transfer.blocked_reason_codes);
      const safeRewind = canSafelyAdminMutateCompanyTransfer({
        status,
        has_provider_payment_id: Boolean(providerPaymentId),
        money_moved: false,
      });
      if (
        status !== "DRAFT"
        && !amountOnlyBlocked
        && status !== "BLOCKED"
        && !safeRewind
      ) {
        return jsonResponse({
          success: false,
          error: "EDIT_REQUIRES_DRAFT",
          error_code: "EDIT_REQUIRES_DRAFT",
          first_visible_error: providerPaymentId
            ? "Cannot edit after provider payment was submitted"
            : "Edit is not allowed for this transfer status",
          message: providerPaymentId
            ? "Cannot edit after provider payment was submitted"
            : "Edit is not allowed for this transfer status",
        }, 200);
      }
      if (!["DRAFT", "BLOCKED", "FUNDING_UNAVAILABLE"].includes(status) && !safeRewind) {
        return jsonResponse({
          success: false,
          error: "EDIT_REQUIRES_DRAFT",
          error_code: "EDIT_REQUIRES_DRAFT",
        }, 200);
      }

      let recipientName = transfer.recipient_name as string;
      let recipientType = transfer.recipient_type as string;
      let destinationAccount = transfer.destination_account as string | null;
      let revolutCounterpartyId = transfer.revolut_counterparty_id as string | null;
      let revolutRecipientAccountId = transfer.revolut_recipient_account_id as string | null;
      let payeeId = input.payee_id !== undefined ? input.payee_id : transfer.payee_id;

      if (input.payee_id) {
        const { data: payee, error: payeeErr } = await supabase
          .from("company_payees")
          .select("*")
          .eq("id", input.payee_id)
          .maybeSingle();
        if (payeeErr || !payee) {
          return jsonResponse({ success: false, error: "PAYEE_NOT_FOUND" }, 200);
        }
        if (!payee.active || payee.paused || payee.archived_at) {
          return jsonResponse({ success: false, error: "PAYEE_INACTIVE", error_code: "PAYEE_INACTIVE" }, 200);
        }
        recipientName = String(payee.display_name || payee.legal_name);
        recipientType = String(payee.payee_type);
        destinationAccount = String(payee.masked_account ?? "••••");
        revolutCounterpartyId = payee.revolut_counterparty_id
          ? String(payee.revolut_counterparty_id)
          : null;
        revolutRecipientAccountId = payee.revolut_recipient_account_id
          ? String(payee.revolut_recipient_account_id)
          : null;
        payeeId = String(payee.id);
      }

      const nextAmount = input.amount_pence ?? Number(transfer.amount_pence);
      const nextApproved = input.approved_amount_pence !== undefined
        ? input.approved_amount_pence
        : (input.amount_pence ?? transfer.approved_amount_pence ?? nextAmount);
      const nextCategory = input.category ?? transfer.category;
      const moneySource = resolveEnforcedCompanyTransferMoneySource({
        category: String(nextCategory),
        money_source: transfer.money_source,
      });

      const { company_balance, funding_snapshot } = await captureFundingSnapshot({
        supabase,
        service_area_id: transfer.service_area_id ?? null,
        currency: transfer.currency ?? "GBP",
        capture_phase: "SUBMIT",
      });
      const available = resolvePrecheckAvailableCompanyFundsPence(
        company_balance,
        funding_snapshot,
      ) ?? resolveAvailableCompanyFundsPenceFromBalance(
        company_balance,
        funding_snapshot,
      );
      const preDraft = evaluatePreDraftCompanyFundsGate({
        requested_pence: Number(nextApproved ?? nextAmount),
        available_company_funds_pence: available,
      });

      const statementReference = input.statement_reference !== undefined
        ? sanitizeCompanyTransferStatementReference(input.statement_reference)
        : transfer.statement_reference;

      const now = new Date().toISOString();
      const patch: Record<string, unknown> = {
        amount_pence: nextAmount,
        approved_amount_pence: nextApproved,
        category: nextCategory,
        money_source: moneySource,
        recipient_name: recipientName,
        recipient_type: recipientType,
        destination_account: destinationAccount,
        payee_id: payeeId,
        revolut_counterparty_id: revolutCounterpartyId,
        revolut_recipient_account_id: revolutRecipientAccountId,
        // payment_reference stays immutable — never patched
        statement_reference: statementReference,
        status: "DRAFT",
        // Clear approval / execution path so re-approval is required.
        approval_count: 0,
        approved_by: null,
        submitted_for_approval_at: null,
        blocked_reason_codes: [],
        blocked_at: null,
        failure_reason: null,
        updated_at: now,
      };
      if (input.scheduled_at !== undefined) patch.scheduled_at = input.scheduled_at;
      if (input.cost_centre !== undefined) patch.cost_centre = input.cost_centre;
      if (input.attachment_url !== undefined) patch.attachment_url = input.attachment_url;
      if (input.purpose !== undefined) patch.purpose = input.purpose;
      if (input.notes !== undefined) patch.notes = input.notes;

      if (!preDraft.ok) {
        // Save corrections but stay DRAFT — never BLOCKED for amount shortfall.
        const { data: updated, error: updErr } = await supabase
          .from("company_outgoing_transfers")
          .update(patch)
          .eq("id", transfer.id)
          .select("*")
          .single();
        if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);
        await audit({
          transfer_id: transfer.id,
          actor_id: actorId,
          requester_id: transfer.requested_by ?? actorId,
          event_type: "DRAFT_EDITED_STILL_INSUFFICIENT",
          old_status: transfer.status,
          new_status: "DRAFT",
          amount_pence: nextAmount,
          currency: transfer.currency,
          reason: preDraft.reason,
          metadata: {
            money_moved: false,
            funds_protection: preDraft.funds_protection,
            stays_draft: true,
            payment_reference: transfer.payment_reference,
          },
        });
        // HTTP 200 + success:false — validation UX, not a transport failure.
        return jsonResponse({
          success: false,
          ok: false,
          error: preDraft.reason,
          error_code: preDraft.reason,
          transfer: updated,
          stays_draft: true,
          blocked: false,
          funds_protection: preDraft.funds_protection,
          message: preDraft.message,
          company_balance,
          funding_snapshot,
          live_company_transfer_execution_enabled: liveCompanyExec,
        }, 200);
      }

      const { data: updated, error: updErr } = await supabase
        .from("company_outgoing_transfers")
        .update(patch)
        .eq("id", transfer.id)
        .select("*")
        .single();
      if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);

      await audit({
        transfer_id: transfer.id,
        actor_id: actorId,
        requester_id: transfer.requested_by ?? actorId,
        event_type: "DRAFT_EDITED",
        old_status: transfer.status,
        new_status: "DRAFT",
        amount_pence: nextAmount,
        currency: transfer.currency,
        reason: "Draft corrected and revalidated",
        metadata: {
          money_moved: false,
          from_blocked: status === "BLOCKED",
          payment_reference: transfer.payment_reference,
          funds_ok: true,
        },
      });

      return jsonResponse({
        success: true,
        transfer: updated,
        stays_draft: true,
        blocked: false,
        revalidated: true,
        company_balance,
        funding_snapshot,
        live_company_transfer_execution_enabled: liveCompanyExec,
      });
    }

    if (input.action === "submit_for_approval") {
      if (String(transfer.status) !== "DRAFT" && String(transfer.status) !== "BLOCKED") {
        return jsonResponse({
          success: false,
          error: "SUBMIT_REQUIRES_DRAFT_OR_BLOCKED",
          error_code: "SUBMIT_REQUIRES_DRAFT_OR_BLOCKED",
        }, 200);
      }
      if (!canTransitionCompanyTransferStatus({ from: transfer.status, to: "AWAITING_APPROVAL" })
        && String(transfer.status) !== "BLOCKED") {
        return jsonResponse({ success: false, error: "INVALID_STATUS_TRANSITION" }, 200);
      }

      // Payee verification for approval path.
      if (transfer.payee_id) {
        const { data: payee } = await supabase
          .from("company_payees")
          .select("active, paused, account_verification_status")
          .eq("id", transfer.payee_id)
          .maybeSingle();
        if (!payee || !payee.active || payee.paused) {
          return jsonResponse({
            success: false,
            error_code: COMPANY_TRANSFER_GATE_REASON.PAYEE_INACTIVE,
          }, 200);
        }
        if (String(payee.account_verification_status).toUpperCase() !== "VERIFIED") {
          return jsonResponse({
            success: false,
            error_code: COMPANY_TRANSFER_GATE_REASON.PAYEE_UNVERIFIED,
          }, 200);
        }
      }

      const amount = Number(transfer.approved_amount_pence ?? transfer.amount_pence ?? 0);
      const { company_balance, funding_snapshot, reserve_policy_id } = await captureFundingSnapshot({
        supabase,
        service_area_id: transfer.service_area_id ?? null,
        currency: transfer.currency ?? "GBP",
        capture_phase: "SUBMIT",
      });
      const fundingGate = evaluateCompanyTransferFundingGate({
        amount_pence: amount,
        funding_snapshot,
      });

      // Funding-gate failures (amount, reserve, classified, unclassified) must NEVER
      // create a BLOCKED ledger row from submit. Stay DRAFT, return one precise error,
      // keep the form editable. BLOCKED is reserved for provider/execution failures.
      if (!fundingGate.allowed) {
        const protection = fundingGate.funds_protection ?? null;
        const firstCode = fundingGate.reason_codes[0]
          ?? protection?.reason
          ?? "FUNDING_GATE_BLOCKED";
        const firstMessage = protection?.message
          ?? companyTransferGateReasonLabel(firstCode)
          ?? firstCode;
        const now = new Date().toISOString();
        const { data: updated, error: updErr } = await supabase
          .from("company_outgoing_transfers")
          .update({
            status: "DRAFT",
            submitted_for_approval_at: null,
            approval_funding_snapshot: funding_snapshot,
            reserve_policy_id: reserve_policy_id,
            source_account_id: funding_snapshot.source_account_id,
            blocked_reason_codes: [],
            blocked_at: null,
            failure_reason: null,
            updated_at: now,
          })
          .eq("id", transfer.id)
          .select("*")
          .single();
        if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);

        await audit({
          transfer_id: transfer.id,
          actor_id: actorId,
          requester_id: transfer.requested_by ?? actorId,
          event_type: "SUBMIT_VALIDATION_FAILED_STAYS_DRAFT",
          old_status: transfer.status,
          new_status: "DRAFT",
          amount_pence: transfer.amount_pence,
          currency: transfer.currency,
          reason: firstCode,
          metadata: {
            money_moved: false,
            revolut_pay_called: false,
            driver_wallet_mutated: false,
            company_balance_mutated: false,
            blocked_reason_codes: fundingGate.reason_codes,
            first_failing_code: firstCode,
            funds_protection: protection,
            funding_snapshot,
            stays_draft: true,
            company_balance_summary: {
              final_company_available_pence: funding_snapshot.final_company_available_pence,
              operational_reserve_pence: funding_snapshot.operational_reserve_pence,
              operational_reserve_status: funding_snapshot.operational_reserve_status,
              unclassified_company_cash_pence: funding_snapshot.unclassified_company_cash_pence,
              reserve_policy_id: funding_snapshot.reserve_policy_id,
              source_account_id: funding_snapshot.source_account_id,
            },
          },
        });

        return jsonResponse({
          success: false,
          ok: false,
          error: firstCode,
          error_code: firstCode,
          first_visible_error: firstMessage,
          first_failing_code: firstCode,
          transfer: updated,
          blocked: false,
          stays_draft: true,
          blocked_reason_codes: fundingGate.reason_codes,
          funds_protection: protection,
          message: firstMessage,
          funding_snapshot,
          company_balance,
          live_company_transfer_execution_enabled: liveCompanyExec,
          money_moved: false,
          revolut_pay_called: false,
        }, 200);
      }

      const nextStatus = "AWAITING_APPROVAL";
      const protection = fundingGate.funds_protection ?? null;
      const now = new Date().toISOString();
      const { data: updated, error: updErr } = await supabase
        .from("company_outgoing_transfers")
        .update({
          status: nextStatus,
          submitted_for_approval_at: now,
          approval_funding_snapshot: funding_snapshot,
          reserve_policy_id: reserve_policy_id,
          source_account_id: funding_snapshot.source_account_id,
          blocked_reason_codes: [],
          blocked_at: null,
          failure_reason: null,
          updated_at: now,
        })
        .eq("id", transfer.id)
        .select("*")
        .single();
      if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);

      await audit({
        transfer_id: transfer.id,
        actor_id: actorId,
        requester_id: transfer.requested_by ?? actorId,
        event_type: "SUBMITTED_FOR_APPROVAL",
        old_status: transfer.status,
        new_status: nextStatus,
        amount_pence: transfer.amount_pence,
        currency: transfer.currency,
        reason: "Submitted for approval",
        metadata: {
          money_moved: false,
          revolut_pay_called: false,
          driver_wallet_mutated: false,
          company_balance_mutated: false,
          funding_snapshot,
        },
      });

      return jsonResponse({
        success: true,
        transfer: updated,
        blocked: false,
        blocked_reason_codes: [],
        funds_protection: protection,
        message: null,
        funding_snapshot,
        company_balance,
        live_company_transfer_execution_enabled: liveCompanyExec,
      });
    }

    if (input.action === "approve") {
      // Soft-idempotent: already approved / ready — return existing (no money move).
      if (["APPROVED", "READY_FOR_EXECUTION"].includes(String(transfer.status))) {
        return jsonResponse({
          success: true,
          transfer,
          idempotent: true,
          live_company_transfer_execution_enabled: liveCompanyExec,
        });
      }
      if (!["AWAITING_APPROVAL", "BLOCKED"].includes(String(transfer.status))) {
        return jsonResponse({ success: false, error: "APPROVE_REQUIRES_AWAITING_OR_BLOCKED" }, 200);
      }
      const requiresOwner = Boolean(transfer.metadata?.requires_owner);
      if (requiresOwner) {
        const isOwner = await actorIsOwnerAdmin(supabase, actorId);
        if (!isOwner) {
          return jsonResponse({
            success: false,
            ok: false,
            error: "OWNER_APPROVAL_REQUIRED",
            error_code: "OWNER_APPROVAL_REQUIRED",
            first_visible_error: "Owner approval is required for this transfer",
            message: "Owner approval is required for this transfer",
            money_moved: false,
          }, 200);
        }
      }

      const tiers = await loadApprovalTiers(supabase);
      const amount = Number(transfer.approved_amount_pence ?? transfer.amount_pence ?? 0);
      const { company_balance, funding_snapshot, reserve_policy_id } = await captureFundingSnapshot({
        supabase,
        service_area_id: transfer.service_area_id ?? null,
        currency: transfer.currency ?? "GBP",
        capture_phase: "APPROVAL",
      });
      const fundingGate = evaluateCompanyTransferFundingGate({
        amount_pence: amount,
        funding_snapshot,
      });

      const requesterId = transfer.requested_by ?? null;
      const isSelfApproval = Boolean(
        actorId
        && requesterId
        && String(requesterId) === String(actorId),
      );

      let soleAdminAudit: ReturnType<
        typeof evaluateSoleAdminCompanyTransferSelfApproval
      >["audit"] = null;

      if (isSelfApproval) {
        // LIVE off: allow requester approve for workflow cert (no /pay).
        // LIVE on: never blanket self-approve — sole-admin exception only.
        // Explicit confirm_sole_admin_approval always evaluates the sole-admin path
        // so certification can auto-advance to READY_FOR_EXECUTION.
        const forceSoleAdmin = input.confirm_sole_admin_approval === true;
        if (!forceSoleAdmin && (!liveCompanyExec || tiers.allow_self_approval)) {
          const selfCheck = assertCompanyTransferSelfApprovalPolicy({
            requester_id: requesterId,
            approver_id: actorId,
            allow_self_approval: true,
          });
          if (!selfCheck.ok) {
            const code = selfCheck.reason ?? "APPROVER_REQUIRED";
            const message = companyTransferGateReasonLabel(code);
            return jsonResponse({
              success: false,
              ok: false,
              error: code,
              error_code: code,
              first_visible_error: message,
              message,
              money_moved: false,
            }, 200);
          }
        } else {
          const actorRole = await loadActorStaffRole(supabase, actorId);
          const actorIsOwner = await loadActorIsOwner(supabase, actorId);
          const otherApprovers = await countOtherEligibleCompanyTransferApprovers(
            supabase,
            requesterId,
          );
          let payeeVerified = false;
          if (transfer.payee_id) {
            const { data: payee } = await supabase
              .from("company_payees")
              .select("account_verification_status, metadata")
              .eq("id", transfer.payee_id)
              .maybeSingle();
            const meta = (payee?.metadata ?? {}) as Record<string, unknown>;
            payeeVerified = isCompanyTransferPayeeProviderVerified({
              account_verification_status: payee?.account_verification_status ?? null,
              provider_link_status: meta.provider_link_status != null
                ? String(meta.provider_link_status)
                : null,
            });
          }
          const { data: intentRow } = await supabase
            .from("company_transfer_payment_intents")
            .select("id, provider_payment_id, financially_applied_at")
            .eq("transfer_id", transfer.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const hasProviderPayment = Boolean(
            intentRow?.provider_payment_id
            || transfer.provider_transaction_id,
          );
          const hasLedgerDebit = Boolean(
            intentRow?.financially_applied_at
            || ["COMPLETED", "PAID"].includes(String(transfer.status)),
          );

          const sole = evaluateSoleAdminCompanyTransferSelfApproval({
            policy_enabled: tiers.sole_admin_enabled,
            actor_role: actorRole,
            actor_is_owner: actorIsOwner,
            requester_user_id: requesterId,
            approver_user_id: actorId,
            other_eligible_approver_count: otherApprovers,
            amount_pence: amount,
            limit_pence: tiers.sole_admin_limit_pence,
            transfer_type: transfer.transfer_type ?? null,
            allowed_transfer_types: tiers.sole_admin_allowed_types,
            payee_provider_verified: payeeVerified,
            money_source: transfer.money_source ?? null,
            funding_gate_allowed: fundingGate.allowed,
            has_provider_payment: hasProviderPayment,
            has_company_ledger_debit: hasLedgerDebit,
            confirm_sole_admin_approval: input.confirm_sole_admin_approval === true,
            override_reason: input.override_reason
              ?? input.reason
              ?? null,
            payee_id: transfer.payee_id ?? null,
            transfer_id: transfer.id,
            transfer_reference: transfer.transfer_ref ?? null,
          });

          if (!sole.ok) {
            const code = sole.reason_codes[0]
              ?? COMPANY_TRANSFER_GATE_REASON.SELF_APPROVAL_DISABLED;
            const message = soleAdminCtReasonLabel(code)
              || companyTransferGateReasonLabel(code);
            return jsonResponse({
              success: false,
              ok: false,
              error: code,
              error_code: code,
              blocked_reason_codes: sole.reason_codes,
              first_visible_error: message,
              message,
              sole_admin_approval_required: true,
              money_moved: false,
              live_company_transfer_execution_enabled: liveCompanyExec,
            }, 200);
          }
          soleAdminAudit = sole.audit;
        }
      }

      if (!fundingGate.allowed) {
        const now = new Date().toISOString();
        const protection = fundingGate.funds_protection ?? null;
        const firstCode = fundingGate.reason_codes[0]
          ?? protection?.reason
          ?? "FUNDING_GATE_BLOCKED";
        const firstMessage = protection?.message
          ?? companyTransferGateReasonLabel(firstCode)
          ?? firstCode;
        // Stay AWAITING_APPROVAL (or revert BLOCKED → AWAITING) — do not create a Blocked row.
        const { data: updated, error: updErr } = await supabase
          .from("company_outgoing_transfers")
          .update({
            status: "AWAITING_APPROVAL",
            approval_funding_snapshot: funding_snapshot,
            reserve_policy_id,
            source_account_id: funding_snapshot.source_account_id,
            blocked_reason_codes: [],
            blocked_at: null,
            failure_reason: null,
            updated_at: now,
          })
          .eq("id", transfer.id)
          .select("*")
          .single();
        if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);
        await audit({
          transfer_id: transfer.id,
          actor_id: actorId,
          requester_id: transfer.requested_by ?? null,
          approver_id: actorId,
          event_type: "APPROVE_VALIDATION_FAILED",
          old_status: transfer.status,
          new_status: "AWAITING_APPROVAL",
          amount_pence: transfer.amount_pence,
          currency: transfer.currency,
          reason: firstCode,
          metadata: {
            money_moved: false,
            revolut_pay_called: false,
            driver_wallet_mutated: false,
            company_balance_mutated: false,
            blocked_reason_codes: fundingGate.reason_codes,
            funds_protection: protection,
            stays_awaiting: true,
          },
        });
        return jsonResponse({
          success: false,
          ok: false,
          error: firstCode,
          error_code: firstCode,
          first_visible_error: firstMessage,
          message: firstMessage,
          transfer: updated,
          blocked: false,
          stays_awaiting: true,
          blocked_reason_codes: fundingGate.reason_codes,
          funds_protection: protection,
          funding_snapshot,
          company_balance,
          live_company_transfer_execution_enabled: liveCompanyExec,
          money_moved: false,
        }, 200);
      }

      const approvalReason = soleAdminAudit?.override_reason
        ?? input.override_reason
        ?? input.reason
        ?? null;

      const { error: apprErr } = await supabase.from("company_outgoing_transfer_approvals").insert({
        transfer_id: transfer.id,
        approver_id: actorId,
        decision: "APPROVED",
        reason: approvalReason,
      });
      if (apprErr) {
        // Stale approval row after return_to_draft: same approver + still awaiting.
        // Continue the status transition instead of pretending already done.
        const isDup = String(apprErr.message ?? "").toLowerCase().includes("duplicate")
          || String(apprErr.code) === "23505";
        const stillNeedsApproval = ["AWAITING_APPROVAL", "BLOCKED"].includes(
          String(transfer.status),
        );
        if (isDup && stillNeedsApproval) {
          console.warn(
            "[admin-company-outgoing-transfer] reusing approval row after return_to_draft",
            transfer.id,
          );
        } else if (isDup) {
          return jsonResponse({
            success: true,
            transfer,
            idempotent: true,
            live_company_transfer_execution_enabled: liveCompanyExec,
          });
        } else {
          return jsonResponse({ success: false, error: apprErr.message }, 200);
        }
      }

      const nextCount = Number(transfer.approval_count ?? 0) + 1;
      const required = Number(transfer.approvals_required ?? 1);
      const nowIso = new Date().toISOString();
      // Sole-admin: AWAITING → APPROVED → READY_FOR_EXECUTION (no auto submit /pay).
      const approvedStatus = nextCount >= required ? "APPROVED" : "AWAITING_APPROVAL";
      const nextStatus = soleAdminAudit && approvedStatus === "APPROVED"
        ? "READY_FOR_EXECUTION"
        : approvedStatus;

      const baseMeta = {
        ...(typeof transfer.metadata === "object" && transfer.metadata
          ? transfer.metadata as Record<string, unknown>
          : {}),
        ...(soleAdminAudit
          ? {
            sole_admin_override: true,
            sole_admin_approval: soleAdminAudit,
          }
          : {}),
      };

      const { data: approvedRow, error: updErr } = await supabase
        .from("company_outgoing_transfers")
        .update({
          approval_count: nextCount,
          approved_by: actorId,
          status: approvedStatus,
          approval_funding_snapshot: funding_snapshot,
          reserve_policy_id,
          source_account_id: funding_snapshot.source_account_id,
          blocked_reason_codes: [],
          blocked_at: null,
          failure_reason: null,
          updated_at: nowIso,
          metadata: baseMeta,
        })
        .eq("id", transfer.id)
        .select("*")
        .single();
      if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);

      const soleApprovalEvent = soleAdminAudit?.owner_override
        ? "SOLE_OWNER_APPROVAL"
        : soleAdminAudit
        ? "SOLE_ADMIN_APPROVED"
        : "APPROVED";

      await audit({
        transfer_id: transfer.id,
        actor_id: actorId,
        requester_id: transfer.requested_by ?? null,
        approver_id: actorId,
        event_type: soleApprovalEvent,
        old_status: transfer.status,
        new_status: approvedStatus,
        amount_pence: transfer.amount_pence,
        currency: transfer.currency,
        reason: soleAdminAudit?.reason ?? approvalReason,
        metadata: {
          money_moved: false,
          revolut_pay_called: false,
          company_debited: false,
          ...(soleAdminAudit
            ? {
              sole_admin_override: true,
              owner_override: soleAdminAudit.owner_override === true,
              requester_user_id: soleAdminAudit.requester_user_id,
              approver_user_id: soleAdminAudit.approver_user_id,
              role: soleAdminAudit.role,
              reason: soleAdminAudit.reason,
              override_reason: soleAdminAudit.override_reason,
              approval_policy_version: soleAdminAudit.approval_policy_version,
              approved_at: soleAdminAudit.approved_at,
              amount_pence: soleAdminAudit.amount_pence,
              transfer_type: soleAdminAudit.transfer_type,
              payee: soleAdminAudit.payee_id,
              transfer_id: soleAdminAudit.transfer_id ?? transfer.id,
              transfer_reference: soleAdminAudit.transfer_reference,
            }
            : {}),
        },
      });

      let updated = approvedRow;
      if (soleAdminAudit && approvedStatus === "APPROVED") {
        const readyAt = new Date().toISOString();
        const { data: readyRow, error: readyErr } = await supabase
          .from("company_outgoing_transfers")
          .update({
            status: "READY_FOR_EXECUTION",
            pre_execution_funding_snapshot: funding_snapshot,
            ready_for_execution_at: readyAt,
            blocked_reason_codes: [],
            blocked_at: null,
            failure_reason: null,
            updated_at: readyAt,
          })
          .eq("id", transfer.id)
          .select("*")
          .single();
        if (readyErr) return jsonResponse({ success: false, error: readyErr.message }, 200);
        updated = readyRow;
        await audit({
          transfer_id: transfer.id,
          actor_id: actorId,
          requester_id: transfer.requested_by ?? null,
          approver_id: actorId,
          event_type: "READY_FOR_EXECUTION",
          old_status: "APPROVED",
          new_status: "READY_FOR_EXECUTION",
          amount_pence: transfer.amount_pence,
          currency: transfer.currency,
          reason: soleAdminAudit?.owner_override
            ? "COMPANY_TRANSFER_OWNER_SOLE_APPROVAL"
            : "COMPANY_TRANSFER_CERTIFICATION",
          metadata: {
            money_moved: false,
            revolut_pay_called: false,
            company_debited: false,
            sole_admin_override: true,
            owner_override: soleAdminAudit?.owner_override === true,
            auto_ready_after_sole_admin_approval: true,
          },
        });
      }

      return jsonResponse({
        success: true,
        transfer: updated,
        funding_snapshot,
        live_company_transfer_execution_enabled: liveCompanyExec,
        sole_admin_override: Boolean(soleAdminAudit),
        owner_override: soleAdminAudit?.owner_override === true,
        money_moved: false,
        revolut_pay_called: false,
        status_path: soleAdminAudit
          ? ["AWAITING_APPROVAL", "APPROVED", "READY_FOR_EXECUTION"]
          : [transfer.status, nextStatus],
      });
    }

    if (input.action === "reject") {
      const tiers = await loadApprovalTiers(supabase);
      const selfCheck = assertCompanyTransferSelfApprovalPolicy({
        requester_id: transfer.requested_by,
        approver_id: actorId,
        allow_self_approval: tiers.allow_self_approval || !liveCompanyExec,
      });
      if (!selfCheck.ok) {
        const code = selfCheck.reason ?? "APPROVER_REQUIRED";
        const message = companyTransferGateReasonLabel(code);
        return jsonResponse({
          success: false,
          ok: false,
          error: code,
          error_code: code,
          first_visible_error: message,
          message,
          money_moved: false,
        }, 200);
      }
      const now = new Date().toISOString();
      const { data: updated, error: updErr } = await supabase
        .from("company_outgoing_transfers")
        .update({
          status: "REJECTED",
          failure_reason: input.reason,
          rejected_at: now,
          updated_at: now,
        })
        .eq("id", transfer.id)
        .select("*")
        .single();
      if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);
      await supabase.from("company_outgoing_transfer_approvals").insert({
        transfer_id: transfer.id,
        approver_id: actorId,
        decision: "REJECTED",
        reason: input.reason,
      });
      await audit({
        transfer_id: transfer.id,
        actor_id: actorId,
        requester_id: transfer.requested_by ?? null,
        approver_id: actorId,
        event_type: "REJECTED",
        old_status: transfer.status,
        new_status: "REJECTED",
        amount_pence: transfer.amount_pence,
        currency: transfer.currency,
        reason: input.reason,
        metadata: { money_moved: false },
      });
      return jsonResponse({ success: true, transfer: updated });
    }

    if (input.action === "mark_ready_for_execution") {
      if (String(transfer.status) !== "APPROVED" && String(transfer.status) !== "SCHEDULED") {
        return jsonResponse({ success: false, error: "READY_REQUIRES_APPROVED" }, 200);
      }
      const amount = Number(transfer.approved_amount_pence ?? transfer.amount_pence ?? 0);
      const { funding_snapshot, reserve_policy_id } = await captureFundingSnapshot({
        supabase,
        service_area_id: transfer.service_area_id ?? null,
        currency: transfer.currency ?? "GBP",
        capture_phase: "PRE_EXECUTION",
      });
      const execGate = evaluateCompanyTransferExecutionGate({
        amount_pence: amount,
        funding_snapshot,
        live_company_transfer_execution_enabled: liveCompanyExec,
      });
      // Even when live is disabled, READY_FOR_EXECUTION requires authoritative funding.
      // Live-disabled alone does not prevent marking ready — only blocks execute/pay.
      const fundingOnly = evaluateCompanyTransferFundingGate({
        amount_pence: amount,
        funding_snapshot,
      });
      const now = new Date().toISOString();
      if (!fundingOnly.allowed) {
        const protection = fundingOnly.funds_protection ?? null;
        const { data: blocked, error: blkErr } = await supabase
          .from("company_outgoing_transfers")
          .update({
            status: "BLOCKED",
            pre_execution_funding_snapshot: funding_snapshot,
            reserve_policy_id,
            blocked_reason_codes: fundingOnly.reason_codes,
            blocked_at: now,
            failure_reason: protection?.message ?? fundingOnly.reason_codes.join(","),
            updated_at: now,
          })
          .eq("id", transfer.id)
          .select("*")
          .single();
        if (blkErr) return jsonResponse({ success: false, error: blkErr.message }, 200);
        await audit({
          transfer_id: transfer.id,
          actor_id: actorId,
          event_type: "BLOCKED_PRE_EXECUTION",
          old_status: transfer.status,
          new_status: "BLOCKED",
          amount_pence: transfer.amount_pence,
          currency: transfer.currency,
          reason: protection?.reason ?? fundingOnly.reason_codes.join(","),
          metadata: {
            money_moved: false,
            revolut_pay_called: false,
            driver_wallet_mutated: false,
            company_balance_mutated: false,
            funds_protection: protection,
          },
        });
        return jsonResponse({
          success: true,
          transfer: blocked,
          blocked: true,
          blocked_reason_codes: fundingOnly.reason_codes,
          funds_protection: protection,
          message: protection?.message ?? null,
          funding_snapshot,
        });
      }

      const { data: updated, error: updErr } = await supabase
        .from("company_outgoing_transfers")
        .update({
          status: "READY_FOR_EXECUTION",
          pre_execution_funding_snapshot: funding_snapshot,
          reserve_policy_id,
          ready_for_execution_at: now,
          blocked_reason_codes: [],
          blocked_at: null,
          updated_at: now,
        })
        .eq("id", transfer.id)
        .select("*")
        .single();
      if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);
      await audit({
        transfer_id: transfer.id,
        actor_id: actorId,
        event_type: "READY_FOR_EXECUTION",
        old_status: transfer.status,
        new_status: "READY_FOR_EXECUTION",
        amount_pence: transfer.amount_pence,
        currency: transfer.currency,
        reason: liveCompanyExec
          ? null
          : COMPANY_TRANSFER_GATE_REASON.LIVE_EXECUTION_DISABLED,
        metadata: {
          money_moved: false,
          live_execution_still_disabled: !liveCompanyExec,
          execution_gate_codes: execGate.reason_codes,
        },
      });
      return jsonResponse({
        success: true,
        transfer: updated,
        funding_snapshot,
        live_company_transfer_execution_enabled: liveCompanyExec,
        execute_still_blocked: !liveCompanyExec,
      });
    }

    if (input.action === "mark_paid") {
      // Unreachable while live company execution disabled (gated above).
      if (String(transfer.status) !== "APPROVED"
        && String(transfer.status) !== "PROCESSING"
        && String(transfer.status) !== "READY_FOR_EXECUTION") {
        return jsonResponse({ success: false, error: "TRANSFER_NOT_EXECUTABLE" }, 200);
      }
      assertCompanyTransferMoneySource(transfer.money_source);
      const executionAt = input.execution_at ?? new Date().toISOString();
      const { data: updated, error: updErr } = await supabase
        .from("company_outgoing_transfers")
        .update({
          status: "PAID",
          provider: input.provider,
          provider_reference: input.provider_reference,
          execution_at: executionAt,
          notes: input.notes ?? transfer.notes,
          last_attempt_at: executionAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", transfer.id)
        .select("*")
        .single();
      if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);
      await audit({
        transfer_id: transfer.id,
        actor_id: actorId,
        requester_id: transfer.requested_by ?? null,
        approver_id: transfer.approved_by ?? null,
        event_type: "MARKED_PAID",
        old_status: transfer.status,
        new_status: "PAID",
        provider: input.provider,
        provider_reference: input.provider_reference,
        amount_pence: transfer.amount_pence,
        currency: transfer.currency,
        reason: input.notes ?? null,
      });
      return jsonResponse({ success: true, transfer: updated });
    }

    if (input.action === "retry") {
      if (String(transfer.status) !== "FAILED") {
        return jsonResponse({ success: false, error: "RETRY_ONLY_FAILED" }, 200);
      }
      assertCompanyTransferMoneySource(transfer.money_source);
      const { data: updated, error: updErr } = await supabase
        .from("company_outgoing_transfers")
        .update({
          status: "APPROVED",
          retry_count: Number(transfer.retry_count ?? 0) + 1,
          last_attempt_at: new Date().toISOString(),
          failure_reason: null,
          provider_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", transfer.id)
        .select("*")
        .single();
      if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);
      await audit({
        transfer_id: transfer.id,
        actor_id: actorId,
        event_type: "RETRY_QUEUED",
        old_status: "FAILED",
        new_status: "APPROVED",
        amount_pence: transfer.amount_pence,
        currency: transfer.currency,
        reason: input.reason ?? null,
      });
      return jsonResponse({ success: true, transfer: updated });
    }

    if (input.action === "return_to_draft") {
      const status = String(transfer.status).toUpperCase();
      const providerPaymentId = await loadProviderPaymentIdForTransfer(supabase, transfer.id);
      if (!canReturnCompanyTransferToDraft({
        status,
        has_provider_payment_id: Boolean(providerPaymentId),
        money_moved: false,
      })) {
        return jsonResponse({
          success: false,
          error: "RETURN_TO_DRAFT_NOT_ALLOWED",
          error_code: "RETURN_TO_DRAFT_NOT_ALLOWED",
          first_visible_error: providerPaymentId
            ? "Cannot return to draft after provider payment was submitted"
            : "Return to draft is not allowed for this status",
          message: providerPaymentId
            ? "Cannot return to draft after provider payment was submitted"
            : "Return to draft is not allowed for this status",
          money_moved: false,
          revolut_pay_called: false,
        }, 200);
      }
      if (!canTransitionCompanyTransferStatus({ from: status, to: "DRAFT" })) {
        return jsonResponse({
          success: false,
          error: "INVALID_STATUS_TRANSITION",
          error_code: "INVALID_STATUS_TRANSITION",
        }, 200);
      }
      try {
        await supabase.rpc("release_company_funding_hold", {
          p_transfer_id: transfer.id,
          p_reason: "RETURNED_TO_DRAFT",
        });
      } catch {
        /* no hold — ignore */
      }
      const now = new Date().toISOString();
      // Clear prior approval votes so a later re-submit requires fresh approval.
      await supabase
        .from("company_outgoing_transfer_approvals")
        .delete()
        .eq("transfer_id", transfer.id);
      const { data: updated, error: updErr } = await supabase
        .from("company_outgoing_transfers")
        .update({
          status: "DRAFT",
          approval_count: 0,
          approved_by: null,
          submitted_for_approval_at: null,
          blocked_reason_codes: [],
          blocked_at: null,
          failure_reason: null,
          updated_at: now,
        })
        .eq("id", transfer.id)
        .select("*")
        .single();
      if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);
      await audit({
        transfer_id: transfer.id,
        actor_id: actorId,
        requester_id: transfer.requested_by ?? actorId,
        event_type: "RETURNED_TO_DRAFT",
        old_status: transfer.status,
        new_status: "DRAFT",
        amount_pence: transfer.amount_pence,
        currency: transfer.currency,
        reason: input.reason ?? "Returned to draft (no money moved)",
        metadata: {
          money_moved: false,
          revolut_pay_called: false,
          payment_reference: transfer.payment_reference,
        },
      });
      return jsonResponse({
        success: true,
        transfer: updated,
        stays_draft: true,
        money_moved: false,
        revolut_pay_called: false,
      });
    }

    if (input.action === "cancel") {
      const status = String(transfer.status).toUpperCase();
      const providerPaymentId = await loadProviderPaymentIdForTransfer(supabase, transfer.id);
      if (!canCancelCompanyTransferSafely({
        status,
        has_provider_payment_id: Boolean(providerPaymentId),
        money_moved: false,
      })) {
        return jsonResponse({
          success: false,
          error: "CANCEL_NOT_ALLOWED",
          error_code: "CANCEL_NOT_ALLOWED",
          first_visible_error: providerPaymentId
            ? "Cancel after provider submit requires provider reversal — not safe cancel"
            : "Cancel is not allowed for this status",
          message: providerPaymentId
            ? "Cancel after provider submit requires provider reversal — not safe cancel"
            : "Cancel is not allowed for this status",
          money_moved: false,
          revolut_pay_called: false,
        }, 200);
      }
      try {
        await supabase.rpc("release_company_funding_hold", {
          p_transfer_id: transfer.id,
          p_reason: "CANCELLED",
        });
      } catch {
        /* no hold — ignore */
      }
      const { data: updated, error: updErr } = await supabase
        .from("company_outgoing_transfers")
        .update({
          status: "CANCELLED",
          failure_reason: input.reason,
          updated_at: new Date().toISOString(),
        })
        .eq("id", transfer.id)
        .select("*")
        .single();
      if (updErr) return jsonResponse({ success: false, error: updErr.message }, 200);
      await audit({
        transfer_id: transfer.id,
        actor_id: actorId,
        requester_id: transfer.requested_by ?? null,
        event_type: "CANCELLED",
        old_status: transfer.status,
        new_status: "CANCELLED",
        amount_pence: transfer.amount_pence,
        currency: transfer.currency,
        reason: input.reason,
        metadata: {
          money_moved: false,
          revolut_pay_called: false,
          hold_released: true,
        },
      });
      return jsonResponse({
        success: true,
        transfer: updated,
        money_moved: false,
        revolut_pay_called: false,
      });
    }

    if (input.action === "execute") {
      // Preview only unless live company transfer execution enabled (never in Slice 11).
      assertCompanyTransferMoneySource(transfer.money_source);
      if (!["APPROVED", "SCHEDULED", "READY_FOR_EXECUTION"].includes(String(transfer.status))) {
        return jsonResponse({ success: false, error: "EXECUTE_REQUIRES_READY" }, 200);
      }
      const amount = Number(transfer.approved_amount_pence ?? transfer.amount_pence ?? 0);
      const { company_balance, funding_snapshot } = await captureFundingSnapshot({
        supabase,
        service_area_id: transfer.service_area_id ?? null,
        currency: transfer.currency ?? "GBP",
        capture_phase: "PRE_EXECUTION",
      });
      const execGate = evaluateCompanyTransferExecutionGate({
        amount_pence: amount,
        funding_snapshot,
        live_company_transfer_execution_enabled: liveCompanyExec && input.execute_live === true,
      });
      if (!execGate.allowed) {
        const protection = execGate.funds_protection ?? null;
        await supabase.from("company_outgoing_transfers").update({
          status: "BLOCKED",
          pre_execution_funding_snapshot: funding_snapshot,
          blocked_reason_codes: execGate.reason_codes,
          blocked_at: new Date().toISOString(),
          failure_reason: protection?.message ?? execGate.reason_codes.join(","),
          updated_at: new Date().toISOString(),
        }).eq("id", transfer.id);
        return jsonResponse({
          success: false,
          error_code: protection?.reason ?? execGate.reason_codes[0],
          blocked_reason_codes: execGate.reason_codes,
          funds_protection: protection,
          message: protection?.message ?? execGate.reason_codes.join(","),
          error: protection?.message ?? execGate.reason_codes.join(","),
          company_balance,
          funding_snapshot,
          money_moved: false,
          revolut_pay_called: false,
          driver_wallet_mutated: false,
          company_balance_mutated: false,
        }, 200);
      }
      // Live path must never run in Slice 11 — belt and braces.
      return jsonResponse({
        success: false,
        error_code: COMPANY_TRANSFER_GATE_REASON.LIVE_EXECUTION_DISABLED,
        error: "Live Revolut company transfers are disabled (Slice 11 safety)",
        live_company_transfer_execution_enabled: false,
      }, 200);
    }

    return jsonResponse({ success: false, error: "Unhandled action" }, 200);
  } catch (err) {
    console.error("[admin-company-outgoing-transfer]", err);
    return jsonResponse({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500);
  }
});
