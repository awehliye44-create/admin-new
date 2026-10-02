/**
 * Company operational/refund reserve policy — finance-gated mutations only.
 * Config never moves money. Direct client writes blocked by RLS after migration.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import {
  corsHeaders,
  jsonResponse,
  requireFinanceExecutionAuth,
  requireOwnerTierAuth,
  buildFinanceActorAuditContext,
  FINANCE_EXECUTION_PAGE_SLUGS,
} from "../_shared/adminPaymentGate.ts";
import {
  COMPANY_RESERVE_POLICY_ACTIONS,
} from "../_shared/companyFundsAuthoritySSOT.ts";
import {
  buildCompanyFundsAuditEnvelope,
  redactCompanyFundsAuditState,
} from "../_shared/companyFundsActorAuditSSOT.ts";
import {
  RESERVE_MODE,
  RESERVE_POLICY_STATUS,
  validateReservePolicyDraft,
  validateZeroReserveOwnerActivation,
} from "../_shared/companyOperationalReserveSSOT.ts";

const SaveDraftSchema = z.object({
  action: z.literal(COMPANY_RESERVE_POLICY_ACTIONS.SAVE_DRAFT),
  service_area_id: z.string().uuid().nullable(),
  currency: z.string().min(3).max(3).default("GBP"),
  reserve_mode: z.enum([RESERVE_MODE.FIXED_AMOUNT, RESERVE_MODE.PERCENTAGE]),
  reserve_amount_pence: z.number().int().nonnegative().nullable().optional(),
  reserve_percentage_bps: z.number().int().min(0).max(100000).nullable().optional(),
  minimum_reserve_pence: z.number().int().nonnegative().default(0),
  effective_from: z.string().datetime().optional(),
  audit_note: z.string().max(2000).nullable().optional(),
  reserve_id: z.string().uuid().nullable().optional(),
  request_id: z.string().max(200).nullable().optional(),
});

const ActivateSchema = z.object({
  action: z.literal(COMPANY_RESERVE_POLICY_ACTIONS.ACTIVATE),
  reserve_id: z.string().uuid(),
  audit_reason: z.string().min(10).max(2000),
  confirm_zero_reserve: z.boolean().optional(),
  request_id: z.string().max(200).nullable().optional(),
});

const DisableSchema = z.object({
  action: z.literal(COMPANY_RESERVE_POLICY_ACTIONS.DISABLE),
  reserve_id: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
  request_id: z.string().max(200).nullable().optional(),
});

const InputSchema = z.discriminatedUnion("action", [
  SaveDraftSchema,
  ActivateSchema,
  DisableSchema,
]);

async function writeReserveAudit(
  supabase: { from: (t: string) => any },
  args: {
    reserve_id: string | null;
    action: string;
    actor_id: string | null;
    actor_audit: ReturnType<typeof buildFinanceActorAuditContext>;
    from_status: string | null;
    to_status: string | null;
    before_state?: Record<string, unknown> | null;
    after_state?: Record<string, unknown> | null;
    note?: string | null;
    request_id?: string | null;
  },
) {
  const payload = buildCompanyFundsAuditEnvelope({
    actor: args.actor_audit,
    action: args.action,
    before_state: redactCompanyFundsAuditState(args.before_state),
    after_state: redactCompanyFundsAuditState(args.after_state),
    note: args.note ?? "Config only — no money movement",
    request_id: args.request_id ?? null,
  });
  await supabase.from("company_operational_reserve_audit").insert({
    reserve_id: args.reserve_id,
    action: args.action,
    actor_id: args.actor_id,
    from_status: args.from_status,
    to_status: args.to_status,
    payload,
    note: args.note ?? "Config only — no money movement",
    money_moved: false,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const actionRaw = String((body as { action?: string })?.action ?? "").trim();
    const pageSlug = FINANCE_EXECUTION_PAGE_SLUGS.PAYOUT_LEDGER;

    let gate;
    if (actionRaw === COMPANY_RESERVE_POLICY_ACTIONS.ACTIVATE) {
      gate = await requireOwnerTierAuth(req, { pageSlug, allowSuperAdmin: true });
    } else if (actionRaw === COMPANY_RESERVE_POLICY_ACTIONS.DISABLE) {
      gate = await requireOwnerTierAuth(req, { pageSlug, allowSuperAdmin: false });
    } else {
      gate = await requireFinanceExecutionAuth(req, {
        pageSlug,
        requireStaffFinanceProfile: true,
      });
    }
    if (!gate.ok) return gate.response;

    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ success: false, error: "Invalid input", details: parsed.error.flatten() }, 400);
    }

    const input = parsed.data;
    const supabase = gate.supabase;
    const actorId = gate.userId;
    const actorAudit = buildFinanceActorAuditContext(gate);

    if (input.action === COMPANY_RESERVE_POLICY_ACTIONS.SAVE_DRAFT) {
      const currency = input.currency.toUpperCase();
      const validated = validateReservePolicyDraft({
        reserve_mode: input.reserve_mode,
        reserve_amount_pence: input.reserve_amount_pence ?? null,
        reserve_percentage_bps: input.reserve_percentage_bps ?? null,
        minimum_reserve_pence: input.minimum_reserve_pence,
        currency,
      });
      if (!validated.ok) {
        return jsonResponse({ success: false, error: validated.message, code: validated.reason_code }, 400);
      }

      const payload = {
        service_area_id: input.service_area_id,
        currency,
        reserve_mode: input.reserve_mode,
        reserve_amount_pence: input.reserve_mode === RESERVE_MODE.FIXED_AMOUNT
          ? Math.round(Number(input.reserve_amount_pence))
          : null,
        reserve_percentage_bps: input.reserve_mode === RESERVE_MODE.PERCENTAGE
          ? Math.round(Number(input.reserve_percentage_bps))
          : null,
        minimum_reserve_pence: Math.round(input.minimum_reserve_pence),
        effective_from: input.effective_from ?? new Date().toISOString(),
        effective_to: null as string | null,
        status: RESERVE_POLICY_STATUS.DRAFT,
        audit_note: input.audit_note?.trim()
          || "Draft via admin-company-operational-reserve (no money movement)",
        updated_at: new Date().toISOString(),
      };

      if (input.reserve_id) {
        const { data: before } = await supabase
          .from("company_operational_refund_reserves")
          .select("*")
          .eq("id", input.reserve_id)
          .eq("status", RESERVE_POLICY_STATUS.DRAFT)
          .maybeSingle();
        if (!before) {
          return jsonResponse({ success: false, error: "Draft reserve not found", code: "NOT_FOUND" }, 404);
        }
        const { data: after, error } = await supabase
          .from("company_operational_refund_reserves")
          .update(payload)
          .eq("id", input.reserve_id)
          .eq("status", RESERVE_POLICY_STATUS.DRAFT)
          .select("*")
          .single();
        if (error) throw error;
        await writeReserveAudit(supabase, {
          reserve_id: input.reserve_id,
          action: "UPDATE_DRAFT",
          actor_id: actorId,
          actor_audit: actorAudit,
          from_status: RESERVE_POLICY_STATUS.DRAFT,
          to_status: RESERVE_POLICY_STATUS.DRAFT,
          before_state: before as Record<string, unknown>,
          after_state: after as Record<string, unknown>,
          request_id: input.request_id ?? null,
        });
        return jsonResponse({ success: true, reserve: after });
      }

      const insertPayload = { ...payload, created_by: actorId };
      const { data: inserted, error } = await supabase
        .from("company_operational_refund_reserves")
        .insert(insertPayload)
        .select("*")
        .single();
      if (error) throw error;
      await writeReserveAudit(supabase, {
        reserve_id: inserted.id,
        action: "SAVE_DRAFT",
        actor_id: actorId,
        actor_audit: actorAudit,
        from_status: null,
        to_status: RESERVE_POLICY_STATUS.DRAFT,
        after_state: inserted as Record<string, unknown>,
        request_id: input.request_id ?? null,
      });
      return jsonResponse({ success: true, reserve: inserted });
    }

    if (input.action === COMPANY_RESERVE_POLICY_ACTIONS.ACTIVATE) {
      const { data: target, error: targetErr } = await supabase
        .from("company_operational_refund_reserves")
        .select("*")
        .eq("id", input.reserve_id)
        .maybeSingle();
      if (targetErr || !target) {
        return jsonResponse({ success: false, error: "Reserve not found", code: "NOT_FOUND" }, 404);
      }

      const zeroGate = validateZeroReserveOwnerActivation({
        reserve_mode: target.reserve_mode,
        reserve_amount_pence: target.reserve_amount_pence,
        confirm_zero_reserve: input.confirm_zero_reserve,
        audit_reason: input.audit_reason,
      });
      if (!zeroGate.ok) {
        return jsonResponse(
          { success: false, error: zeroGate.message, code: zeroGate.reason_code },
          400,
        );
      }

      const sa = target.service_area_id as string | null;
      const currency = String(target.currency ?? "GBP").toUpperCase();
      let activeQuery = supabase
        .from("company_operational_refund_reserves")
        .select("*")
        .eq("status", RESERVE_POLICY_STATUS.ACTIVE)
        .eq("currency", currency);
      activeQuery = sa
        ? activeQuery.eq("service_area_id", sa)
        : activeQuery.is("service_area_id", null);
      const { data: activeRows } = await activeQuery;

      for (const row of activeRows ?? []) {
        if (String(row.id) === input.reserve_id) continue;
        const before = row as Record<string, unknown>;
        const { data: disabled, error: disableErr } = await supabase
          .from("company_operational_refund_reserves")
          .update({
            status: RESERVE_POLICY_STATUS.DISABLED,
            disabled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .select("*")
          .single();
        if (disableErr) throw disableErr;
        await writeReserveAudit(supabase, {
          reserve_id: String(row.id),
          action: "DISABLE",
          actor_id: actorId,
          actor_audit: actorAudit,
          from_status: RESERVE_POLICY_STATUS.ACTIVE,
          to_status: RESERVE_POLICY_STATUS.DISABLED,
          before_state: before,
          after_state: disabled as Record<string, unknown>,
          note: "Replaced by activation",
          request_id: input.request_id ?? null,
        });
      }

      const beforeState = target as Record<string, unknown>;
      const { data: activated, error } = await supabase
        .from("company_operational_refund_reserves")
        .update({
          status: RESERVE_POLICY_STATUS.ACTIVE,
          approved_by: actorId,
          activated_at: new Date().toISOString(),
          disabled_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.reserve_id)
        .select("*")
        .single();
      if (error) throw error;
      await writeReserveAudit(supabase, {
        reserve_id: input.reserve_id,
        action: "ACTIVATE",
        actor_id: actorId,
        actor_audit: actorAudit,
        from_status: String(target.status ?? null),
        to_status: RESERVE_POLICY_STATUS.ACTIVE,
        before_state: beforeState,
        after_state: activated as Record<string, unknown>,
        note: input.audit_reason.trim(),
        request_id: input.request_id ?? null,
      });
      return jsonResponse({ success: true, reserve: activated });
    }

    if (input.action === COMPANY_RESERVE_POLICY_ACTIONS.DISABLE) {
      const { data: target, error: targetErr } = await supabase
        .from("company_operational_refund_reserves")
        .select("*")
        .eq("id", input.reserve_id)
        .maybeSingle();
      if (targetErr || !target) {
        return jsonResponse({ success: false, error: "Reserve not found", code: "NOT_FOUND" }, 404);
      }
      const beforeState = target as Record<string, unknown>;
      const { data: disabled, error } = await supabase
        .from("company_operational_refund_reserves")
        .update({
          status: RESERVE_POLICY_STATUS.DISABLED,
          disabled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.reserve_id)
        .select("*")
        .single();
      if (error) throw error;
      await writeReserveAudit(supabase, {
        reserve_id: input.reserve_id,
        action: "DISABLE",
        actor_id: actorId,
        actor_audit: actorAudit,
        from_status: String(target.status ?? null),
        to_status: RESERVE_POLICY_STATUS.DISABLED,
        before_state: beforeState,
        after_state: disabled as Record<string, unknown>,
        note: input.reason ?? "Disabled via admin-company-operational-reserve",
        request_id: input.request_id ?? null,
      });
      return jsonResponse({ success: true, reserve: disabled });
    }

    return jsonResponse({ success: false, error: "Unknown action" }, 400);
  } catch (error) {
    console.error("[admin-company-operational-reserve]", error);
    return jsonResponse({ success: false, error: (error as Error).message }, 200);
  }
});
