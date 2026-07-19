/**
 * Company Transfers panel — Payout Ledger SSOT only.
 * Money source: COMPANY_BALANCE / APPROVED_COMPANY_PAYABLE. Never driver wallet.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Plus, Printer, RefreshCw, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { companyTransferStatusLabel } from '../../../shared/companyPayeeSSOT';
import {
  companyTransferGateReasonLabel,
  companyTransferGateReasonLabels,
  gateHasInsufficientCompanyFunds,
  isCompanyTransferCertificationOrTestProof,
  isCompanyTransferOperationallyVisible,
} from '../../../shared/companyTransferLifecycleSSOT';
import { soleAdminCtReasonLabel } from '../../../shared/companyTransferSoleAdminApprovalSSOT';
import { isCompanyPayeeProviderVerified } from '../../../shared/companyPayeeRevolutLinkSSOT';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@/hooks/useAuth';
import { useStaffProfile } from '@/hooks/useStaffProfile';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { supabase } from '@/integrations/supabase/client';
import { downloadCsv, printPayoutReceipt } from '@/lib/financeExport';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { CompanyTransfersPayeesSection } from '@/components/finance/CompanyTransfersPayeesSection';
import {
  ADMIN_COMPANY_PAYEES_FN,
  ADMIN_COMPANY_TRANSFER_FN,
  type CompanyOutgoingTransferRow,
} from '../../../shared/adminPayoutLedgerSSOT';
import type { CompanyBalanceSnapshot } from '../../../shared/companyBalanceSSOT';
import { COMPANY_BALANCE_ERROR } from '../../../shared/companyBalanceSSOT';
import type { CompanyPayeePublicDto } from '../../../shared/companyPayeeSSOT';
import {
  COMPANY_TRANSFER_CATEGORIES,
  COMPANY_TRANSFER_KIND_LABELS,
  COMPANY_TRANSFER_KINDS,
  COMPANY_TRANSFER_MONEY_SOURCES,
  COMPANY_TRANSFER_RECIPIENT_TYPES,
  COMPANY_TRANSFER_RECONCILE_STATUSES,
  COMPANY_TRANSFER_START_MODE_LABELS,
  COMPANY_TRANSFER_START_MODES,
  resolveCompanyTransferCreateOptions,
} from '../../../shared/companyOutgoingTransferSSOT';
import {
  COMPANY_TRANSFER_CERTIFICATION_DEFAULTS,
  COMPANY_TRANSFER_FORM_FIELD_HELP,
  buildCompanyTransferDraftSummary,
  formatCompanyTransferPenceAsGbp,
} from '../../../shared/companyTransferFormUxSSOT';
import {
  previewCompanyTransferPaymentReference,
} from '../../../shared/companyTransferPaymentReferenceSSOT';
import {
  buildLiveFundsShortfallDisplay,
  canCancelCompanyTransferSafely,
  canReturnCompanyTransferToDraft,
  canSafelyAdminMutateCompanyTransfer,
  isAmountValidationOnlyBlock,
  shouldShowEditDraftAction,
  shouldShowRetryValidation,
} from '../../../shared/companyTransferDraftValidationSSOT';
import {
  evaluateCompanyTransferCreatePrecheck,
  resolvePrecheckAvailableCompanyFundsPence,
} from '../../../shared/companyTransferCreatePrecheckSSOT';
import { parseLiveCompanyTransferExecutionEnabled } from '../../../shared/companyTransferLifecycleSSOT';
import { adminCompanyTransferSubmissionDisplay } from '../../../shared/companyTransferSubmissionSSOT';
import {
  ADMIN_FINALIZE_COMPANY_TRANSFER_FN,
  ADMIN_SUBMIT_COMPANY_TRANSFER_FN,
  ADMIN_SYNC_COMPANY_TRANSFER_STATUS_FN,
} from '../../../shared/adminPayoutLedgerSSOT';

/** Slice 11: live company transfer execution stays off (client mirror; edge enforces). */
const LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED = parseLiveCompanyTransferExecutionEnabled(
  () => (typeof import.meta !== 'undefined'
    ? (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED
    : undefined),
);

function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB');
}

function RequiredAsterisk() {
  return (
    <span className="text-destructive font-semibold" aria-hidden="true">
      {' *'}
    </span>
  );
}

function FieldHelp({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-[11px] text-muted-foreground leading-snug pt-0.5">
      {children}
    </p>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-[11px] text-destructive leading-snug pt-0.5">
      {message}
    </p>
  );
}

/** Prefer structured edge body over opaque "non-2xx" — keeps form editable (no blank screen). */
async function companyTransferInvokeErrorMessage(
  data: Record<string, unknown> | null | undefined,
  error: unknown,
  fallback = 'Request failed',
): Promise<string> {
  const fromPayload = (payload: Record<string, unknown> | null | undefined): string | null => {
    if (!payload || typeof payload !== 'object') return null;
    const protection = payload.funds_protection as { message?: string } | null | undefined;
    return (
      (typeof payload.first_visible_error === 'string' ? payload.first_visible_error : null)
      ?? protection?.message
      ?? (typeof payload.message === 'string' ? payload.message : null)
      ?? (payload.error_code || payload.error
        ? (soleAdminCtReasonLabel(String(payload.error_code ?? payload.error ?? ''))
          || companyTransferGateReasonLabel(String(payload.error_code ?? payload.error ?? '')))
        : null)
      ?? (typeof payload.error === 'string' ? payload.error : null)
    );
  };

  const fromData = fromPayload(data ?? undefined);
  if (fromData) return fromData;

  if (error instanceof FunctionsHttpError) {
    try {
      const ctx = error.context as Response & { json?: () => Promise<unknown>; clone?: () => Response };
      let payload: Record<string, unknown> | null = null;
      if (typeof ctx?.json === 'function') {
        try {
          payload = await (ctx.clone?.() ?? ctx).json() as Record<string, unknown>;
        } catch {
          payload = await ctx.json() as Record<string, unknown>;
        }
      }
      const fromErr = fromPayload(payload);
      if (fromErr) return fromErr;
    } catch {
      /* fall through */
    }
  }
  if (error instanceof Error && error.message) {
    if (/non-2xx|edge function/i.test(error.message)) {
      return 'Transfer validation failed. If you created this transfer, another admin must approve it (self-approval is disabled when company LIVE is on).';
    }
    return error.message;
  }
  return fallback;
}

function AutoFilledTag() {
  return (
    <Badge variant="secondary" className="ml-1 align-middle text-[10px] font-normal">
      Auto-filled
    </Badge>
  );
}

function receiptTitleFor(row: CompanyOutgoingTransferRow): string {
  if (row.category === 'STAFF_REIMBURSEMENT') return 'Staff reimbursement receipt';
  if (row.category === 'SUPPLIER_PAYMENT') return 'Supplier payment receipt';
  return 'Company transfer receipt';
}

function openTransferReceipt(row: CompanyOutgoingTransferRow) {
  printPayoutReceipt({
    title: receiptTitleFor(row),
    fields: [
      { label: 'Transfer ID', value: row.transfer_ref },
      { label: 'Payment reference', value: row.payment_reference },
      { label: 'Statement reference', value: row.statement_reference },
      { label: 'Recipient', value: row.recipient_name },
      { label: 'Recipient type', value: row.recipient_type },
      { label: 'Category', value: row.category },
      { label: 'Money source', value: row.money_source },
      { label: 'Source account', value: row.source_account },
      { label: 'Destination account', value: row.destination_account },
      { label: 'Amount (pence)', value: row.amount_pence },
      { label: 'Currency', value: row.currency },
      { label: 'Purpose', value: row.purpose },
      { label: 'Cost centre', value: row.cost_centre },
      { label: 'Requested by', value: row.requested_by },
      { label: 'Approved by', value: row.approved_by },
      { label: 'Provider', value: row.provider },
      { label: 'Provider reference', value: row.provider_reference },
      { label: 'Status', value: row.status },
      { label: 'Execution time', value: row.execution_at },
      { label: 'Notes', value: row.notes },
      { label: 'Attachment', value: row.attachment_url },
      { label: 'Generated at', value: new Date().toISOString() },
    ],
  });
}

export function PayoutLedgerCompanyTransfersPanel({
  transfers,
  isLoading,
  failedOnly = false,
  serviceAreaId = null,
  companyBalance = null,
  kpis = null,
  emptyCopy = null,
}: {
  transfers: CompanyOutgoingTransferRow[];
  isLoading: boolean;
  failedOnly?: boolean;
  serviceAreaId?: string | null;
  companyBalance?: CompanyBalanceSnapshot | null;
  kpis?: {
    awaiting_approval_count: number;
    approved_payables_pending_pence: number;
    processing_pence: number;
    completed_month_pence?: number;
    completed_driver_payouts_month_pence?: number;
    completed_company_transfers_month_pence?: number;
    failed_count: number;
  } | null;
  emptyCopy?: string | null;
}) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { staffProfile } = useStaffProfile();
  const { data: serviceAreas = [] } = useServiceAreas({ activeOnly: true });
  const [showForm, setShowForm] = useState(false);
  const [editingTransferId, setEditingTransferId] = useState<string | null>(null);
  const [soleAdminTransfer, setSoleAdminTransfer] = useState<CompanyOutgoingTransferRow | null>(null);
  const [soleAdminReason, setSoleAdminReason] = useState(
    'Sole-admin approval: no second authorised company-transfer approver is configured.',
  );
  const [form, setForm] = useState({
    payee_id: '',
    recipient_name: '',
    recipient_type: 'STAFF',
    category: 'STAFF_SALARY',
    money_source: 'COMPANY_BALANCE',
    source_account: '',
    destination_account: '',
    amount_pence: '',
    approved_amount_pence: '',
    currency: 'GBP',
    purpose: '',
    payment_reference: '',
    statement_reference: '',
    scheduled_at: '',
    transfer_kind: 'ONE_OFF',
    start_mode: 'DRAFT',
    service_area_id: serviceAreaId ?? '',
    cost_centre: '',
    provider: 'revolut_business',
    notes: '',
    attachment_url: '',
  });

  const payeesQuery = useQuery({
    queryKey: ['admin-company-payees', serviceAreaId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_PAYEES_FN, {
        body: { action: 'list_payees', service_area_id: serviceAreaId ?? null },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'List payees failed');
      return (data.payees ?? []) as CompanyPayeePublicDto[];
    },
    enabled: !failedOnly,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const payee = (payeesQuery.data ?? []).find((p) => p.id === form.payee_id) ?? null;
      const payeeVerified = payee
        ? isCompanyPayeeProviderVerified(payee.account_verification_status)
          && Boolean(payee.revolut_counterparty_id)
        : false;
      const precheck = evaluateCompanyTransferCreatePrecheck({
        form: {
          payee_id: form.payee_id,
          recipient_name: form.recipient_name,
          category: form.category,
          money_source: form.money_source,
          source_account: form.source_account,
          destination_account: form.destination_account,
          amount_pence: form.amount_pence,
          approved_amount_pence: form.approved_amount_pence,
          payment_reference: '',
          statement_reference: form.statement_reference,
          scheduled_at: form.scheduled_at,
          currency: form.currency,
          service_area_id: form.service_area_id || serviceAreaId || '',
          cost_centre: form.cost_centre,
          provider: form.provider,
          attachment_url: form.attachment_url,
          purpose: form.purpose,
          notes: form.notes,
          transfer_kind: form.transfer_kind,
          start_mode: form.start_mode,
        },
        payee_provider_verified: payeeVerified,
        payee_currency: payee?.currency ?? null,
        context_service_area_id: serviceAreaId,
        company_balance: companyBalance,
        live_company_transfer_execution_enabled: LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED,
      });
      // Field order: payee ("Select a saved payee.") before any funding message.
      if (!precheck.form.ok) {
        throw new Error(precheck.first_visible_error ?? precheck.form.errors[0]?.message ?? 'Fix required fields');
      }
      const amountPence = precheck.form.amount_pence!;
      const fundsGate = precheck.funds_gate;
      if (!fundsGate?.ok) {
        throw new Error(fundsGate?.message ?? 'Insufficient Available Company Funds');
      }
      const validation = precheck.form;
      const approvedPence = form.approved_amount_pence.trim()
        ? Math.round(Number(form.approved_amount_pence))
        : amountPence;
      if (validation.large_amount_warning) {
        const gbp = validation.gbp_display ?? formatNullablePence(amountPence);
        if (!window.confirm(`Requested amount is ${gbp}. Create this draft anyway? No money will move.`)) {
          throw new Error('Draft creation cancelled');
        }
      }
      const createOpts = resolveCompanyTransferCreateOptions({
        kind: form.transfer_kind,
        start_mode: form.start_mode,
        scheduled_at: form.scheduled_at || null,
      });
      if (createOpts.ok === false) throw new Error(createOpts.error);
      if (createOpts.use_recurring_schedule_ui) {
        throw new Error('Use Automatic Payments (Payees tab) for recurring schedules');
      }
      // Create Draft button must ALWAYS create a DRAFT row.
      // Approval / funding / LIVE gates run only on submit_for_approval / execute.
      const createAsDraft = true;
      const isCertification = String(form.transfer_kind).toUpperCase() === 'CERTIFICATION';
      if (editingTransferId) {
        const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_TRANSFER_FN, {
          body: {
            action: 'edit_draft',
            transfer_id: editingTransferId,
            payee_id: form.payee_id || null,
            category: form.category,
            amount_pence: amountPence,
            approved_amount_pence: approvedPence,
            purpose: form.purpose,
            statement_reference: form.statement_reference.trim() || null,
            scheduled_at: createOpts.scheduled_at,
            cost_centre: form.cost_centre || null,
            attachment_url: form.attachment_url || null,
            notes: form.notes || null,
          },
        });
        // Prefer structured validation body over opaque FunctionsHttpError.
        if (data && data.success === false) {
          throw new Error(await companyTransferInvokeErrorMessage(data, error, 'Draft update failed'));
        }
        if (data?.success) return data;
        if (error) throw new Error(await companyTransferInvokeErrorMessage(data, error, 'Draft update failed'));
        throw new Error('Draft update failed');
      }
      const idempotencyKey = `manual:${crypto.randomUUID()}`;
      const requestBody = {
        action: 'create' as const,
        as_draft: createAsDraft,
        payee_id: form.payee_id || null,
        recipient_name: form.payee_id ? undefined : form.recipient_name,
        recipient_type: form.payee_id ? undefined : form.recipient_type,
        category: form.category,
        money_source: 'COMPANY_BALANCE',
        source_account: form.source_account
          || companyBalance?.source_account_label
          || companyBalance?.source_account_id
          || null,
        destination_account: form.destination_account || null,
        amount_pence: amountPence,
        approved_amount_pence: approvedPence,
        currency: form.currency || 'GBP',
        purpose: form.purpose,
        statement_reference: form.statement_reference.trim() || null,
        scheduled_at: createOpts.scheduled_at,
        execution_mode: 'DRAFT_FOR_APPROVAL' as const,
        service_area_id: form.service_area_id || serviceAreaId || null,
        cost_centre: form.cost_centre || null,
        provider: form.provider || 'revolut_business',
        notes: form.notes || null,
        attachment_url: form.attachment_url || null,
        idempotency_key: idempotencyKey,
        transfer_type: isCertification ? 'CERTIFICATION' as const : 'COMPANY_OUTGOING' as const,
      };
      console.info('[CompanyTransfer] create draft request', {
        action: requestBody.action,
        as_draft: requestBody.as_draft,
        amount_pence: requestBody.amount_pence,
        approved_amount_pence: requestBody.approved_amount_pence,
        payee_id: requestBody.payee_id,
        service_area_id: requestBody.service_area_id,
        currency: requestBody.currency,
        available_company_funds_pence: precheck.available_company_funds_pence,
      });
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_TRANSFER_FN, {
        body: requestBody,
      });
      console.info('[CompanyTransfer] create draft response', {
        success: data?.success,
        error: data?.error,
        error_code: data?.error_code,
        message: data?.message,
        first_visible_error: data?.first_visible_error,
        available_company_funds_pence: data?.available_company_funds_pence,
        requested_pence: data?.requested_pence,
        status: data?.transfer?.status,
        transfer_ref: data?.transfer?.transfer_ref,
        http_error: error?.message,
      });
      if (data && data.success === false) {
        throw new Error(await companyTransferInvokeErrorMessage(data, error, 'Create failed'));
      }
      if (data?.success) return data;
      if (error) {
        throw new Error(await companyTransferInvokeErrorMessage(data, error, 'Create failed'));
      }
      throw new Error('Create failed');
    },
    onSuccess: (data) => {
      const paymentRef = data?.transfer?.payment_reference ?? data?.payment_reference ?? null;
      const ref = paymentRef ?? data?.transfer?.transfer_ref ?? 'saved';
      const status = data?.transfer?.status ?? 'DRAFT';
      toast.success(
        editingTransferId
          ? `Draft updated — ${ref}`
          : `${companyTransferStatusLabel(status)} created — ${ref} (company funding only)`,
      );
      setShowForm(false);
      setEditingTransferId(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const actionMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_TRANSFER_FN, { body });
      if (data && data.success === false) {
        throw new Error(await companyTransferInvokeErrorMessage(data, error, 'Action failed'));
      }
      if (data?.success) return data;
      if (error) throw new Error(await companyTransferInvokeErrorMessage(data, error, 'Action failed'));
      throw new Error('Action failed');
    },
    onSuccess: (data) => {
      if (data?.blocked) {
        // Legacy path — should not create BLOCKED from submit funding gate anymore.
        const protection = data.funds_protection as
          | { message?: string }
          | null
          | undefined;
        const reasons = companyTransferGateReasonLabels(data.blocked_reason_codes ?? []);
        toast.error(
          protection?.message
            ?? reasons[0]
            ?? 'Transfer validation failed',
          { duration: 12_000 },
        );
      } else {
        toast.success(
          data?.sole_admin_override
            ? 'Sole-admin approval recorded — READY FOR EXECUTION (not submitted)'
            : 'Transfer updated',
        );
      }
      setSoleAdminTransfer(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
    },
    onError: (err: Error) => toast.error(err.message, { duration: 12_000 }),
  });

  const requestApprove = (t: CompanyOutgoingTransferRow) => {
    const isSelf = Boolean(user?.id && t.requested_by && user.id === t.requested_by);
    if (isSelf && staffProfile?.role === 'super_admin') {
      setSoleAdminReason(
        `Sole-admin approval for ${t.transfer_ref}: no second authorised company-transfer approver is configured.`,
      );
      setSoleAdminTransfer(t);
      return;
    }
    actionMutation.mutate({ action: 'approve', transfer_id: t.id });
  };

  const submitProviderMutation = useMutation({
    mutationFn: async (transferId: string) => {
      const { data, error } = await supabase.functions.invoke(ADMIN_SUBMIT_COMPANY_TRANSFER_FN, {
        body: { transfer_id: transferId, confirm_submit: true },
      });
      if (data && (data.ok === false || data.success === false)) {
        const protection = data?.funds_protection as { message?: string } | null | undefined;
        if (protection?.message) throw new Error(protection.message);
        const codes = (data?.blocked_reason_codes ?? [data?.error_code ?? data?.error]).filter(Boolean);
        if (gateHasInsufficientCompanyFunds(codes.map(String))) {
          throw new Error(
            typeof data?.message === 'string' && data.message.includes('Available Company Funds')
              ? data.message
              : 'Insufficient ONECAB Available Company Funds. This transfer has been blocked to protect driver funds and reserved driver payouts.',
          );
        }
        throw new Error(
          await companyTransferInvokeErrorMessage(data, error, 'Transfer submission blocked'),
        );
      }
      if (data?.ok || data?.success) return data;
      if (error) {
        throw new Error(
          await companyTransferInvokeErrorMessage(data, error, 'Transfer submission blocked'),
        );
      }
      throw new Error('Transfer submission blocked');
    },
    onSuccess: () => {
      toast.success('Submitted to provider — awaiting confirmation');
      void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
    },
    onError: (err: Error) => toast.error(err.message, { duration: 12_000 }),
  });

  const syncProviderMutation = useMutation({
    mutationFn: async (transferId: string) => {
      const { data, error } = await supabase.functions.invoke(ADMIN_SYNC_COMPANY_TRANSFER_STATUS_FN, {
        body: { transfer_id: transferId },
      });
      // Expected while LIVE is off / before submit — no provider payment yet.
      const missingProviderCode = (payload: Record<string, unknown> | null | undefined) => {
        const code = String(payload?.error_code ?? payload?.error ?? '');
        return code === 'MISSING_PROVIDER_PAYMENT_ID';
      };
      if (data && missingProviderCode(data)) {
        return { ok: true, no_provider_payment_id: true };
      }
      if (data && (data.ok === false || data.success === false)) {
        throw new Error(
          await companyTransferInvokeErrorMessage(data, error, 'Provider status sync failed'),
        );
      }
      if (data?.ok || data?.success) return data;
      if (error) {
        const ctx = (error as { context?: Response }).context;
        if (ctx && typeof ctx.json === 'function') {
          try {
            const body = await ctx.clone().json() as Record<string, unknown>;
            if (missingProviderCode(body)) {
              return { ok: true, no_provider_payment_id: true };
            }
          } catch {
            /* fall through */
          }
        }
        throw new Error(
          await companyTransferInvokeErrorMessage(data, error, 'Provider status sync failed'),
        );
      }
      throw new Error('Provider status sync failed');
    },
    onSuccess: (data) => {
      if ((data as { no_provider_payment_id?: boolean })?.no_provider_payment_id) {
        toast.info('Not yet sent to provider — nothing to sync');
        return;
      }
      toast.success(
        `Provider status: ${companyTransferStatusLabel(data?.provider_state ?? data?.status ?? 'synced')}`,
      );
      void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
    },
    onError: (err: Error) => toast.error(err.message, { duration: 12_000 }),
  });

  const finalizeMutation = useMutation({
    mutationFn: async (transferId: string) => {
      const { data, error } = await supabase.functions.invoke(ADMIN_FINALIZE_COMPANY_TRANSFER_FN, {
        body: { transfer_id: transferId, confirm_finalize: true },
      });
      if (data && (data.ok === false || data.success === false)) {
        throw new Error(await companyTransferInvokeErrorMessage(data, error, 'Finalize blocked'));
      }
      if (data?.ok || data?.success) return data;
      if (error) {
        throw new Error(await companyTransferInvokeErrorMessage(data, error, 'Finalize blocked'));
      }
      throw new Error('Finalize blocked');
    },
    onSuccess: () => {
      toast.success('Company transfer finalized — ledger + balance updated');
      void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
    },
    onError: (err: Error) => toast.error(err.message, { duration: 12_000 }),
  });

  const inFlightTransfers = useMemo(
    () => transfers.filter((t) =>
      COMPANY_TRANSFER_RECONCILE_STATUSES.has(String(t.status).toUpperCase())
      && Boolean(t.provider_payment_id_masked),
    ),
    [transfers],
  );

  // Auto-reconcile: poll provider status for in-flight transfers (no manual refresh required).
  useEffect(() => {
    if (inFlightTransfers.length === 0) return;
    const tick = () => {
      for (const t of inFlightTransfers.slice(0, 10)) {
        void supabase.functions.invoke(ADMIN_SYNC_COMPANY_TRANSFER_STATUS_FN, {
          body: { transfer_id: t.id },
        }).then(({ data }) => {
          if (data?.ok || data?.success) {
            void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
          }
        }).catch(() => undefined);
      }
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [inFlightTransfers, queryClient]);

  const exportRows = useMemo(
    () =>
      transfers.map((t) => ({
        transfer_id: t.transfer_ref,
        recipient: t.recipient_name,
        recipient_type: t.recipient_type,
        category: t.category,
        money_source: t.money_source,
        source_account: t.source_account,
        destination_account: t.destination_account,
        amount_pence: t.amount_pence,
        currency: t.currency,
        purpose: t.purpose,
        cost_centre: t.cost_centre,
        requested_by: t.requested_by,
        approved_by: t.approved_by,
        provider: t.provider,
        provider_reference: t.provider_reference,
        status: t.status,
        execution_at: t.execution_at,
        failure_reason: t.failure_reason,
        provider_error: t.provider_error,
        retry_count: t.retry_count,
        last_attempt_at: t.last_attempt_at,
        notes: t.notes,
        attachment_url: t.attachment_url,
      })),
    [transfers],
  );

  const draftTransfers = useMemo(
    () => transfers.filter((t) => {
      if (!isCompanyTransferOperationallyVisible(t)) return false;
      if (String(t.status) === 'DRAFT') return true;
      // Amount-only insufficient blocks stay in Drafts for Edit Draft — not Blocked.
      return ['BLOCKED', 'FUNDING_UNAVAILABLE'].includes(String(t.status))
        && isAmountValidationOnlyBlock(t.blocked_reason_codes);
    }),
    [transfers],
  );
  const awaitingApproval = useMemo(
    () => transfers.filter((t) =>
      String(t.status) === 'AWAITING_APPROVAL' && isCompanyTransferOperationallyVisible(t)),
    [transfers],
  );
  const approvedTransfers = useMemo(
    () => transfers.filter((t) =>
      ['APPROVED', 'READY_FOR_EXECUTION'].includes(String(t.status))
      && isCompanyTransferOperationallyVisible(t)),
    [transfers],
  );
  const blockedTransfers = useMemo(
    () => transfers.filter((t) =>
      ['BLOCKED', 'FUNDING_UNAVAILABLE'].includes(String(t.status))
      && isCompanyTransferOperationallyVisible(t)
      && !isAmountValidationOnlyBlock(t.blocked_reason_codes)),
    [transfers],
  );
  const processingTransfers = useMemo(
    () => transfers.filter((t) =>
      ['PROCESSING', 'SCHEDULED'].includes(String(t.status))
      && isCompanyTransferOperationallyVisible(t)),
    [transfers],
  );
  const operationalTransfers = useMemo(
    () => transfers.filter((t) => isCompanyTransferOperationallyVisible(t)),
    [transfers],
  );
  const historyTransfers = useMemo(
    () => transfers.filter((t) =>
      ['PAID', 'COMPLETED', 'FAILED', 'CANCELLED', 'DECLINED', 'REJECTED', 'REVERTED']
        .includes(String(t.status))
      || isCompanyTransferCertificationOrTestProof(t)),
    [transfers],
  );

  const activePayees = useMemo(
    () => (payeesQuery.data ?? []).filter((p) => p.active && !p.paused && !p.archived_at),
    [payeesQuery.data],
  );
  const selectedPayee = useMemo(
    () => (payeesQuery.data ?? []).find((p) => p.id === form.payee_id) ?? null,
    [payeesQuery.data, form.payee_id],
  );
  const selectedPayeeProviderVerified = selectedPayee
    ? isCompanyPayeeProviderVerified(selectedPayee.account_verification_status)
      && Boolean(selectedPayee.revolut_counterparty_id)
    : false;

  const resolvedSourceAccount = form.source_account
    || companyBalance?.source_account_label
    || (companyBalance?.source_account_id
      ? `Revolut …${companyBalance.source_account_id.slice(-8)}`
      : '');

  const createPrecheck = useMemo(
    () => evaluateCompanyTransferCreatePrecheck({
      form: {
        payee_id: form.payee_id,
        recipient_name: form.recipient_name,
        category: form.category,
        money_source: form.money_source,
        source_account: resolvedSourceAccount,
        destination_account: form.destination_account,
        amount_pence: form.amount_pence,
        approved_amount_pence: form.approved_amount_pence,
        payment_reference: form.payment_reference,
        statement_reference: form.statement_reference,
        scheduled_at: form.scheduled_at,
        currency: form.currency,
        service_area_id: form.service_area_id || serviceAreaId || '',
        cost_centre: form.cost_centre,
        provider: form.provider,
        attachment_url: form.attachment_url,
        purpose: form.purpose,
        notes: form.notes,
        transfer_kind: form.transfer_kind,
        start_mode: form.start_mode,
      },
      payee_provider_verified: selectedPayeeProviderVerified,
      payee_currency: selectedPayee?.currency ?? null,
      context_service_area_id: serviceAreaId,
      company_balance: companyBalance,
      live_company_transfer_execution_enabled: LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED,
    }),
    [
      form,
      resolvedSourceAccount,
      selectedPayeeProviderVerified,
      selectedPayee?.currency,
      serviceAreaId,
      companyBalance,
    ],
  );

  const draftValidation = createPrecheck.form;

  const availableCompanyFundsPence = createPrecheck.available_company_funds_pence
    ?? resolvePrecheckAvailableCompanyFundsPence(companyBalance);

  const liveFundsShortfall = useMemo(
    () => buildLiveFundsShortfallDisplay({
      available_company_funds_pence: availableCompanyFundsPence,
      requested_pence: draftValidation.amount_pence,
    }),
    [availableCompanyFundsPence, draftValidation.amount_pence],
  );

  const preDraftFundsGate = createPrecheck.funds_gate ?? {
    ok: false,
    reason: 'AMOUNT_INVALID' as const,
    available_company_funds_pence: availableCompanyFundsPence,
    requested_pence: 0,
    shortfall_pence: 0,
    message: null,
    funds_protection: null,
  };

  const serviceAreaName = useMemo(() => {
    const id = form.service_area_id || serviceAreaId || '';
    return serviceAreas.find((sa) => sa.id === id)?.name ?? '';
  }, [form.service_area_id, serviceAreaId, serviceAreas]);

  const paymentReferencePreview = useMemo(
    () => previewCompanyTransferPaymentReference({
      transfer_type_or_kind: form.transfer_kind,
    }),
    [form.transfer_kind],
  );

  const draftSummary = useMemo(
    () => buildCompanyTransferDraftSummary({
      recipient_name: selectedPayee?.display_name || form.recipient_name,
      masked_account: selectedPayee?.masked_account || form.destination_account,
      category: form.category,
      amount_pence: draftValidation.amount_pence,
      payment_reference: paymentReferencePreview,
      statement_reference: form.statement_reference,
      money_source: 'COMPANY_BALANCE',
      provider: form.provider,
      service_area_name: serviceAreaName,
      is_certification: String(form.transfer_kind).toUpperCase() === 'CERTIFICATION',
    }),
    [
      selectedPayee,
      form.recipient_name,
      form.destination_account,
      form.category,
      form.payment_reference,
      form.statement_reference,
      form.provider,
      form.transfer_kind,
      draftValidation.amount_pence,
      paymentReferencePreview,
      serviceAreaName,
    ],
  );

  const applyCertificationDefaults = () => {
    const certPayee = (payeesQuery.data ?? []).find((p) =>
      p.active
      && !p.paused
      && !p.archived_at
      && /3778/.test(String(p.masked_account ?? ''))
      && /onecab/i.test(String(p.display_name ?? '')),
    ) ?? (payeesQuery.data ?? []).find((p) =>
      p.active && !p.paused && !p.archived_at
      && isCompanyPayeeProviderVerified(p.account_verification_status),
    );
    setForm((f) => ({
      ...f,
      transfer_kind: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.transfer_kind,
      start_mode: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.start_mode,
      category: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.category,
      amount_pence: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.amount_pence,
      currency: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.currency,
      provider: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.provider,
      purpose: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.purpose,
      money_source: COMPANY_TRANSFER_CERTIFICATION_DEFAULTS.money_source,
      payment_reference: '',
      service_area_id: f.service_area_id || serviceAreaId || '',
      source_account: resolvedSourceAccount || f.source_account,
      payee_id: certPayee?.id ?? f.payee_id,
      recipient_name: certPayee?.display_name ?? f.recipient_name,
      recipient_type: certPayee?.payee_type ?? f.recipient_type,
      destination_account: certPayee?.masked_account ?? f.destination_account,
    }));
  };

  const beginEditDraft = (t: CompanyOutgoingTransferRow) => {
    setEditingTransferId(t.id);
    setForm((f) => ({
      ...f,
      payee_id: t.payee_id ?? '',
      recipient_name: t.recipient_name,
      recipient_type: t.recipient_type,
      category: t.category,
      money_source: 'COMPANY_BALANCE',
      source_account: t.source_account ?? resolvedSourceAccount,
      destination_account: t.destination_account ?? '',
      amount_pence: String(t.amount_pence ?? ''),
      approved_amount_pence: '',
      currency: t.currency || 'GBP',
      purpose: t.purpose || '',
      payment_reference: t.payment_reference ?? '',
      statement_reference: t.statement_reference ?? '',
      scheduled_at: '',
      transfer_kind: String(t.transfer_type ?? '').toUpperCase() === 'CERTIFICATION'
        ? 'CERTIFICATION'
        : 'ONE_OFF',
      start_mode: 'DRAFT',
      service_area_id: t.service_area_id || serviceAreaId || '',
      cost_centre: t.cost_centre ?? '',
      provider: t.provider || 'revolut_business',
      notes: t.notes ?? '',
      attachment_url: t.attachment_url ?? '',
    }));
    setShowForm(true);
  };

  const beginDuplicateTransfer = (t: CompanyOutgoingTransferRow) => {
    setEditingTransferId(null);
    setForm((f) => ({
      ...f,
      payee_id: t.payee_id ?? '',
      recipient_name: t.recipient_name,
      recipient_type: t.recipient_type,
      category: t.category,
      money_source: 'COMPANY_BALANCE',
      source_account: t.source_account ?? resolvedSourceAccount,
      destination_account: t.destination_account ?? '',
      amount_pence: String(t.amount_pence ?? ''),
      approved_amount_pence: '',
      currency: t.currency || 'GBP',
      purpose: t.purpose || '',
      payment_reference: '',
      statement_reference: t.statement_reference ?? '',
      scheduled_at: '',
      transfer_kind: String(t.transfer_type ?? '').toUpperCase() === 'CERTIFICATION'
        ? 'CERTIFICATION'
        : 'ONE_OFF',
      start_mode: 'DRAFT',
      service_area_id: t.service_area_id || serviceAreaId || '',
      cost_centre: t.cost_centre ?? '',
      provider: t.provider || 'revolut_business',
      notes: t.notes ?? '',
      attachment_url: t.attachment_url ?? '',
    }));
    setShowForm(true);
    toast.message('Duplicate ready — review fields and Create Draft (new payment reference).');
  };

  const transferHasProviderPayment = (t: CompanyOutgoingTransferRow) =>
    Boolean(t.provider_transaction_id || t.provider_reference);

  const viewEvidence = async (transferId: string) => {
    const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_TRANSFER_FN, {
      body: { action: 'view_evidence', transfer_id: transferId },
    });
    if (error || !data?.success) {
      toast.error(data?.error ?? error?.message ?? 'Evidence load failed');
      return;
    }
    const reasons = companyTransferGateReasonLabels(data.transfer?.blocked_reason_codes).join(' · ') || '—';
    const snap = data.transfer?.approval_funding_snapshot;
    toast.message(`Evidence · ${data.transfer?.transfer_ref ?? transferId}`, {
      description: `Status ${companyTransferStatusLabel(data.transfer?.status)}. Reason: ${reasons}. Settled funds: ${
        snap?.final_company_available_pence == null ? 'unavailable' : formatNullablePence(snap.final_company_available_pence)
      }. Audit events: ${(data.audit ?? []).length}.`,
    });
  };

  const companyUnavailable =
    !companyBalance
    || companyBalance.status === 'UNAVAILABLE'
    || companyBalance.company_available_for_transfer_pence == null;
  const companyUnavailableReason = (() => {
    const raw = companyBalance?.status_code ?? companyBalance?.unavailable_reason ?? null;
    if (!raw || raw === COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE) {
      return COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED;
    }
    if (raw === COMPANY_BALANCE_ERROR.ACCOUNT_NOT_CONFIGURED) {
      return COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED;
    }
    return raw;
  })();

  const sectionValue = (
    amount: number | null | undefined,
    section?: { status?: string; reason_code?: string | null } | null,
    fallbackReason?: string | null,
  ) => {
    if (amount != null) {
      return { kind: 'amount' as const, pence: amount };
    }
    const reason = section?.reason_code
      ?? (section?.status === 'NOT_CONFIGURED' ? (fallbackReason ?? 'NOT_CONFIGURED') : null)
      ?? (section?.status === 'ERROR' ? (fallbackReason ?? 'ERROR') : null)
      ?? fallbackReason
      ?? companyUnavailableReason;
    return { kind: 'unavailable' as const, reason };
  };

  const liabilitySection = sectionValue(
    companyBalance?.driver_liability_pence,
    companyBalance?.sections?.driver_liabilities,
    'DRIVER_LIABILITY_QUERY_FAILED',
  );
  const reservedSection = sectionValue(
    companyBalance?.driver_payout_reserved_pence,
    companyBalance?.sections?.reserved_driver_payouts,
    'RESERVED_DRIVER_PAYOUTS_QUERY_FAILED',
  );
  const payablesSection = sectionValue(
    kpis?.approved_payables_pending_pence ?? companyBalance?.approved_company_payables_pence,
    companyBalance?.sections?.approved_company_payables,
    'APPROVED_COMPANY_PAYABLES_UNAVAILABLE',
  );
  const reserveSection = sectionValue(
    companyBalance?.operational_reserve_pence,
    companyBalance?.sections?.operational_reserve,
    'OPERATIONAL_RESERVE_NOT_CONFIGURED',
  );
  const availableSection = sectionValue(
    companyBalance?.company_available_for_transfer_pence,
    companyBalance?.sections?.company_transfer_available
      ?? { status: 'UNAVAILABLE', reason_code: 'OPERATIONAL_RESERVE_NOT_CONFIGURED' },
    companyBalance?.sections?.company_transfer_available?.reason_code
      ?? 'OPERATIONAL_RESERVE_NOT_CONFIGURED',
  );
  const beforeReserveSection = sectionValue(
    companyBalance?.company_available_before_operational_reserve_pence ?? null,
    null,
    companyBalance?.company_available_before_operational_reserve_pence == null
      ? 'BEFORE_RESERVE_UNAVAILABLE'
      : null,
  );
  const completedDriverMonth =
    kpis?.completed_driver_payouts_month_pence
    ?? kpis?.completed_month_pence
    ?? null;
  const completedCompanyMonth = kpis?.completed_company_transfers_month_pence ?? 0;

  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>Company money only</AlertTitle>
        <AlertDescription>
          Company transfers use ONECAB Available Company Funds or Approved Company Payables.
          Revolut source-account cash is provider cash and is not wholly ONECAB-owned.
          Driver Wallet and Payment Sessions are never consumed here.
          Saved payees store encrypted bank details; UI shows masked accounts only.
          Live Revolut execution stays gated (Slice 12: submit/finalize blocked while
          LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED=false). While LIVE is off you can still
          edit, return to draft, cancel, duplicate, and review evidence — only money movement
          stays blocked.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue={failedOnly ? 'transfers' : 'transfers'}>
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="transfers">Transfers</TabsTrigger>
          {!failedOnly && <TabsTrigger value="drafts">Drafts ({draftTransfers.length})</TabsTrigger>}
          {!failedOnly && <TabsTrigger value="payees">Payees</TabsTrigger>}
          {!failedOnly && <TabsTrigger value="automatic">Automatic Payments</TabsTrigger>}
          {!failedOnly && <TabsTrigger value="approvals">Awaiting ({awaitingApproval.length})</TabsTrigger>}
          {!failedOnly && <TabsTrigger value="approved">Approved ({approvedTransfers.length})</TabsTrigger>}
          {!failedOnly && <TabsTrigger value="blocked">Blocked ({blockedTransfers.length})</TabsTrigger>}
          {!failedOnly && <TabsTrigger value="processing">Processing ({processingTransfers.length})</TabsTrigger>}
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="payees" className="space-y-4">
          <CompanyTransfersPayeesSection serviceAreaId={serviceAreaId} focus="payees" />
        </TabsContent>

        <TabsContent value="automatic" className="space-y-4">
          <CompanyTransfersPayeesSection serviceAreaId={serviceAreaId} focus="schedules" />
        </TabsContent>

        <TabsContent value="drafts" className="space-y-4">
          {draftTransfers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No drafts.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Payment reference</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Purpose</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {draftTransfers.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">{t.transfer_ref}</TableCell>
                    <TableCell className="font-mono text-xs">
                      <div className="flex items-center gap-1">
                        <span>{t.payment_reference ?? '—'}</span>
                        {t.payment_reference ? (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            title="Copy payment reference"
                            onClick={() => {
                              void navigator.clipboard.writeText(String(t.payment_reference));
                              toast.message('Payment reference copied');
                            }}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{t.recipient_name}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatNullablePence(t.amount_pence)}</TableCell>
                    <TableCell className="text-xs max-w-[180px] truncate">{t.purpose}</TableCell>
                    <TableCell className="space-x-1">
                      {shouldShowEditDraftAction({
                        status: t.status,
                        blocked_reason_codes: t.blocked_reason_codes,
                      }) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => beginEditDraft(t)}
                        >
                          Edit Draft
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionMutation.isPending}
                        onClick={() => actionMutation.mutate({
                          action: 'submit_for_approval',
                          transfer_id: t.id,
                        })}
                      >
                        Submit for approval
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={actionMutation.isPending}
                        onClick={() => {
                          const reason = window.prompt('Cancel reason?');
                          if (!reason) return;
                          actionMutation.mutate({ action: 'cancel', transfer_id: t.id, reason });
                        }}
                      >
                        Cancel
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void viewEvidence(t.id)}>
                        Evidence
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="approvals" className="space-y-4">
          <p className="text-xs text-muted-foreground">
            High-risk categories always require approval. Four-eyes stays on when company LIVE is
            enabled. If you are the only super admin and sole-admin policy is enabled, you may
            approve your own transfer within the configured limit after explicit confirmation —
            approval does not submit to Revolut.
          </p>
          {awaitingApproval.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transfers awaiting approval.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payee</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {awaitingApproval.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-xs">{t.recipient_name}</TableCell>
                    <TableCell className="text-xs">{t.category}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatNullablePence(t.amount_pence)}</TableCell>
                    <TableCell><Badge variant="outline">{companyTransferStatusLabel(t.status)}</Badge></TableCell>
                    <TableCell className="space-x-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionMutation.isPending}
                        onClick={() => requestApprove(t)}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={actionMutation.isPending}
                        onClick={() => {
                          const reason = window.prompt('Reject reason?');
                          if (!reason) return;
                          actionMutation.mutate({ action: 'reject', transfer_id: t.id, reason });
                        }}
                      >
                        Reject
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void viewEvidence(t.id)}>
                        Evidence
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="approved" className="space-y-4">
          {!LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED ? (
            <Alert>
              <AlertTitle>Live company transfer execution is disabled</AlertTitle>
              <AlertDescription>
                You can edit, cancel or return transfers to draft.
                Submit and Execute will become available only after company LIVE is enabled.
              </AlertDescription>
            </Alert>
          ) : null}
          {approvedTransfers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No approved / ready transfers.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {approvedTransfers.map((t) => {
                  const hasProvider = transferHasProviderPayment(t);
                  const safe = canSafelyAdminMutateCompanyTransfer({
                    status: t.status,
                    has_provider_payment_id: hasProvider,
                    money_moved: false,
                  });
                  const canReturn = canReturnCompanyTransferToDraft({
                    status: t.status,
                    has_provider_payment_id: hasProvider,
                    money_moved: false,
                  });
                  const canCancel = canCancelCompanyTransferSafely({
                    status: t.status,
                    has_provider_payment_id: hasProvider,
                    money_moved: false,
                  });
                  const canEdit = shouldShowEditDraftAction({
                    status: t.status,
                    blocked_reason_codes: t.blocked_reason_codes,
                    has_provider_payment_id: hasProvider,
                    money_moved: false,
                  });
                  return (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">{t.transfer_ref}</TableCell>
                    <TableCell className="text-xs">{t.recipient_name}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatNullablePence(t.amount_pence)}</TableCell>
                    <TableCell><Badge variant="outline">{companyTransferStatusLabel(t.status)}</Badge></TableCell>
                    <TableCell className="space-x-1 flex flex-wrap gap-1">
                      {t.status === 'APPROVED' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={actionMutation.isPending}
                          onClick={() => actionMutation.mutate({
                            action: 'mark_ready_for_execution',
                            transfer_id: t.id,
                          })}
                        >
                          Mark ready
                        </Button>
                      )}
                      {canEdit ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={actionMutation.isPending}
                          onClick={() => beginEditDraft(t)}
                        >
                          Edit
                        </Button>
                      ) : null}
                      {canReturn ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={actionMutation.isPending}
                          onClick={() => actionMutation.mutate({
                            action: 'return_to_draft',
                            transfer_id: t.id,
                            reason: 'Returned to draft for re-approval (LIVE off)',
                          })}
                        >
                          Return to Draft
                        </Button>
                      ) : null}
                      {canCancel ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={actionMutation.isPending}
                          onClick={() => {
                            const reason = window.prompt('Cancel reason?') ?? '';
                            if (!reason.trim()) return;
                            actionMutation.mutate({
                              action: 'cancel',
                              transfer_id: t.id,
                              reason: reason.trim(),
                            });
                          }}
                        >
                          Cancel
                        </Button>
                      ) : null}
                      {safe ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => beginDuplicateTransfer(t)}
                        >
                          Duplicate
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED || actionMutation.isPending
                        }
                        title={
                          LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED
                            ? 'Execute company transfer'
                            : 'LIVE disabled — money movement blocked'
                        }
                        onClick={() => {
                          if (!LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED) return;
                          actionMutation.mutate({
                            action: 'execute',
                            transfer_id: t.id,
                            execute_live: true,
                          });
                        }}
                      >
                        {LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED
                          ? 'Execute'
                          : 'Execute — LIVE disabled'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED || submitProviderMutation.isPending
                        }
                        title={
                          LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED
                            ? 'Submit to Revolut provider'
                            : 'LIVE disabled — money movement blocked'
                        }
                        onClick={() => {
                          if (!LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED) return;
                          submitProviderMutation.mutate(t.id);
                        }}
                      >
                        {LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED
                          ? 'Submit Transfer'
                          : 'Submit — LIVE disabled'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void viewEvidence(t.id)}>
                        Evidence
                      </Button>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="blocked" className="space-y-4">
          {blockedTransfers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No blocked transfers.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Hold</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {blockedTransfers.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">{t.transfer_ref}</TableCell>
                    <TableCell className="text-xs">{t.recipient_name}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatNullablePence(t.amount_pence)}</TableCell>
                    <TableCell className="text-xs max-w-[280px]">
                      {companyTransferGateReasonLabels(t.blocked_reason_codes).join(' · ')
                        || t.failure_reason
                        || '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {adminCompanyTransferSubmissionDisplay({
                        transfer_status: t.status,
                        hold_status: t.funding_hold_status,
                        provider_state: t.provider_state,
                        provider_payment_id: t.provider_transaction_id,
                        blocked_reason_codes: t.blocked_reason_codes,
                      }).hold_label}
                    </TableCell>
                    <TableCell className="space-x-1">
                      {shouldShowEditDraftAction({
                        status: t.status,
                        blocked_reason_codes: t.blocked_reason_codes,
                      }) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => beginEditDraft(t)}
                        >
                          Edit Draft
                        </Button>
                      ) : null}
                      {shouldShowRetryValidation({
                        status: t.status,
                        blocked_reason_codes: t.blocked_reason_codes,
                      }) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={actionMutation.isPending}
                          onClick={() => actionMutation.mutate({
                            action: 'submit_for_approval',
                            transfer_id: t.id,
                          })}
                        >
                          Retry Validation
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => void viewEvidence(t.id)}>
                        Evidence
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="processing" className="space-y-4">
          {processingTransfers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No processing transfers.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Hold</TableHead>
                  <TableHead>Payment ref</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {processingTransfers.map((t) => {
                  const display = adminCompanyTransferSubmissionDisplay({
                    transfer_status: t.status,
                    hold_status: t.funding_hold_status,
                    provider_state: t.provider_state,
                    provider_payment_id: t.provider_transaction_id,
                  });
                  return (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">{t.transfer_ref}</TableCell>
                    <TableCell className="text-xs">{t.recipient_name}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatNullablePence(t.amount_pence)}</TableCell>
                    <TableCell><Badge variant="outline">{companyTransferStatusLabel(t.status)}</Badge></TableCell>
                    <TableCell className="text-xs">{display.provider_submission_status}</TableCell>
                    <TableCell className="text-xs">{display.hold_label}</TableCell>
                    <TableCell className="text-xs font-mono">
                      {display.provider_payment_id_masked ?? '—'}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          {historyTransfers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No completed / failed history yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Completed / failed</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historyTransfers.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">{t.transfer_ref}</TableCell>
                    <TableCell className="text-xs">{t.recipient_name}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatNullablePence(t.amount_pence)}</TableCell>
                    <TableCell><Badge variant="outline">{companyTransferStatusLabel(t.status)}</Badge></TableCell>
                    <TableCell className="text-xs">{shortDate(t.execution_at ?? t.last_attempt_at)}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={() => openTransferReceipt(t)}>
                        <Printer className="h-3.5 w-3.5 mr-1" /> PDF
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="transfers" className="space-y-4">
      {/* existing body continues */}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle
              className="text-sm"
              title="Final ONECAB funds after liabilities, approved payables and a configured operational reserve. UNAVAILABLE while reserve is NOT_CONFIGURED."
            >
              Available Company Funds
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {availableSection.kind === 'unavailable' ? (
              <>
                <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
                <div className="text-xs font-mono text-muted-foreground">{availableSection.reason}</div>
              </>
            ) : (
              <div className="text-xl font-semibold tabular-nums">
                {formatNullablePence(availableSection.pence)}
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              ONECAB Available Company Funds — the only permitted Company Transfer source
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Protected Driver Liabilities</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {liabilitySection.kind === 'unavailable' ? (
              <>
                <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
                <div className="text-xs font-mono text-muted-foreground">{liabilitySection.reason}</div>
              </>
            ) : (
              <div className="text-xl font-semibold tabular-nums">
                {formatNullablePence(liabilitySection.pence)}
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              Protected — never used for company transfers
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Reserved Driver Payouts</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {reservedSection.kind === 'unavailable' ? (
              <>
                <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
                <div className="text-xs font-mono text-muted-foreground">{reservedSection.reason}</div>
              </>
            ) : (
              <div className="text-xl font-semibold tabular-nums">
                {formatNullablePence(reservedSection.pence)}
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              Reserved for drivers — never consumed by company transfers
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle
              className="text-sm"
              title="Same as Available Company Funds. Company Transfers may proceed only when requested amount ≤ this budget."
            >
              Available Company Transfer Budget
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {availableSection.kind === 'unavailable' ? (
              <>
                <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
                <div className="text-xs font-mono text-muted-foreground">{availableSection.reason}</div>
              </>
            ) : (
              <div className="text-xl font-semibold tabular-nums">
                {formatNullablePence(availableSection.pence)}
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              Max transferable now — requested must be ≤ this amount
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Approved Company Payables</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {payablesSection.kind === 'unavailable' ? (
              <>
                <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
                <div className="text-xs font-mono text-muted-foreground">{payablesSection.reason}</div>
              </>
            ) : (
              <div className="text-xl font-semibold tabular-nums">
                {formatNullablePence(payablesSection.pence)}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle
              className="text-sm"
              title="Provisional residual after liabilities and payables only. Not spendable until operational reserve is configured."
            >
              ONECAB Cash Available Before Operational Reserve
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {beforeReserveSection.kind === 'unavailable' ? (
              <>
                <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
                <div className="text-xs font-mono text-muted-foreground">{beforeReserveSection.reason}</div>
              </>
            ) : (
              <div className="text-xl font-semibold tabular-nums">
                {formatNullablePence(beforeReserveSection.pence)}
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              Provisional — not a transfer funding source while reserve is NOT_CONFIGURED
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle
              className="text-sm"
              title="Configured company reserve policy. If missing, transfers cannot use settled company funds."
            >
              Company Reserve Policy
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {reserveSection.kind === 'unavailable' ? (
              <>
                <div className="text-sm font-semibold text-amber-700">Not configured</div>
                <div className="text-xs text-muted-foreground">
                  {companyTransferGateReasonLabel(reserveSection.reason)
                    || 'Company reserve policy not configured'}
                </div>
              </>
            ) : (
              <div className="text-xl font-semibold tabular-nums">
                {formatNullablePence(reserveSection.pence)}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Selected Source Account</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {companyBalance?.source_account_id ? (
              <>
                <div className="text-sm font-semibold truncate">
                  {companyBalance.source_account_label ?? 'Revolut Business'}
                </div>
                <div className="text-xs font-mono text-muted-foreground">
                  …{companyBalance.source_account_id.slice(-8)}
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
                <div className="text-xs font-mono text-muted-foreground">
                  {COMPANY_BALANCE_ERROR.SOURCE_ACCOUNT_NOT_CONFIGURED}
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Last Provider Sync</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {companyBalance?.last_provider_sync_at || companyBalance?.last_verified_at ? (
              <div className="text-sm tabular-nums">
                {new Date(
                  companyBalance.last_provider_sync_at ?? companyBalance.last_verified_at!,
                ).toLocaleString('en-GB')}
              </div>
            ) : (
              <>
                <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
                <div className="text-xs font-mono text-muted-foreground">BALANCE_STALE</div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Connection Health</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {companyBalance?.connection_health || companyBalance?.connection_status ? (
              <>
                <div className="text-sm font-semibold">
                  {companyBalance.connection_health ?? companyBalance.connection_status}
                </div>
                <div className="text-xs font-mono text-muted-foreground">
                  {companyBalance.connection_status ?? companyBalance.status_code ?? companyUnavailableReason}
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
                <div className="text-xs font-mono text-muted-foreground">
                  {COMPANY_BALANCE_ERROR.PROVIDER_CONNECTION_UNAVAILABLE}
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Awaiting Approval</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">
            {kpis?.awaiting_approval_count ?? '—'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Processing Company Transfers</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">
            {formatNullablePence(kpis?.processing_pence ?? null)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle
              className="text-sm"
              title="Canonical driver payout executions with provider_state=completed in the Europe/London calendar month."
            >
              Completed Driver Payouts This Month
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="text-xl font-semibold tabular-nums">
              {formatNullablePence(completedDriverMonth)}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Source: driver payout COMPLETED executions
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Completed Company Transfers This Month</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="text-xl font-semibold tabular-nums">
              {formatNullablePence(completedCompanyMonth)}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Source: company_outgoing_transfers only
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Failed Company Transfers</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">
            {kpis?.failed_count ?? '—'}
          </CardContent>
        </Card>
      </div>

      <Alert>
        <AlertTitle>
          {LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED
            ? 'Company transfer execution enabled'
            : 'Company transfer execution disabled'}
        </AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            {LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED
              ? 'Ready transfers may be submitted to the configured company funding account. Company money only — never driver wallet or customer funds.'
              : 'Drafts, approvals and evidence are allowed. Provider submission stays off until company transfer execution is enabled.'}
          </p>
          <p className="font-medium text-foreground">
            Hard rule: Company Transfers may use only Available Company Funds. Protected Driver
            Liabilities and Reserved Driver Payouts are never consumed.
          </p>
        </AlertDescription>
      </Alert>

      {companyUnavailable && !failedOnly ? (
        <Alert>
          <AlertTitle>
            {companyUnavailableReason
              ? companyTransferGateReasonLabel(companyUnavailableReason)
              : 'Company funds unavailable'}
          </AlertTitle>
          <AlertDescription>
            Transfers cannot proceed until company reserve policy is configured and settled company
            funds are available. Reason:{' '}
            {companyTransferGateReasonLabel(companyUnavailableReason)}. Driver wallet and customer
            funds are never used.
            {availableSection.kind === 'amount' ? (
              <span className="block mt-1 text-foreground">
                Displayed Available Company Funds ({formatNullablePence(availableSection.pence)}) is
                not the same as a failed amount check — do not treat this banner as “requested
                exceeds available”.
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
            toast.success('Refreshing company balance…');
          }}
        >
          Refresh company balance
        </Button>
        {!failedOnly && (
          <Button
            size="sm"
            disabled={activePayees.length === 0}
            title={
              activePayees.length === 0
                ? 'Add an active company payee before creating a draft'
                : undefined
            }
            onClick={() => {
              setShowForm((v) => {
                const next = !v;
                if (!next) setEditingTransferId(null);
                if (next && editingTransferId) setEditingTransferId(null);
                return next;
              });
            }}
          >
            <Plus className="h-4 w-4 mr-2" /> {
              showForm
                ? 'Hide form'
                : (editingTransferId ? 'Edit draft' : 'Create draft')
            }
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={transfers.length === 0}
          onClick={() => downloadCsv(
            failedOnly ? 'failed-company-transfers.csv' : 'company-transfers.csv',
            exportRows,
          )}
        >
          <Download className="h-4 w-4 mr-2" /> CSV export
        </Button>
      </div>

      {showForm && !failedOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {editingTransferId ? 'Edit draft' : 'Create company transfer draft'}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2 text-xs text-muted-foreground">
              Prefer a verified saved payee. Bank details stay encrypted server-side; UI shows masked accounts only.
              Default mode DRAFT_FOR_APPROVAL — no live Revolut /pay from this form.
              Required fields are marked with <span className="text-destructive font-semibold">*</span>.
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-transfer-kind">
                Transfer type
                <RequiredAsterisk />
              </Label>
              <Select
                value={form.transfer_kind}
                onValueChange={(v) => {
                  if (v === 'CERTIFICATION') {
                    applyCertificationDefaults();
                    return;
                  }
                  setForm((f) => ({ ...f, transfer_kind: v }));
                }}
              >
                <SelectTrigger id="ct-transfer-kind" aria-required="true" aria-describedby="help-transfer-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPANY_TRANSFER_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>{COMPANY_TRANSFER_KIND_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHelp id="help-transfer-kind">{COMPANY_TRANSFER_FORM_FIELD_HELP.transfer_kind}</FieldHelp>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-start-mode">Start as</Label>
              <Select
                value={form.start_mode}
                onValueChange={(v) => setForm((f) => ({ ...f, start_mode: v }))}
                disabled={form.transfer_kind === 'CERTIFICATION'}
              >
                <SelectTrigger id="ct-start-mode" aria-describedby="help-start-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPANY_TRANSFER_START_MODES.map((m) => (
                    <SelectItem key={m} value={m}>{COMPANY_TRANSFER_START_MODE_LABELS[m]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHelp id="help-start-mode">{COMPANY_TRANSFER_FORM_FIELD_HELP.start_mode}</FieldHelp>
            </div>

            {form.transfer_kind === 'RECURRING' ? (
              <p className="sm:col-span-2 text-xs text-amber-700">
                Recurring payments use Automatic Payments under Payees — create a schedule there (draft-for-approval).
              </p>
            ) : null}

            {form.transfer_kind === 'CERTIFICATION' ? (
              <Alert className="sm:col-span-2">
                <AlertTitle>£0.01 certification draft</AlertTitle>
                <AlertDescription>
                  Defaults are pre-filled for ONECAB Limited ****3778. Certification transfers stay in Audit History
                  and are excluded from normal salary, supplier and tax totals.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="ct-payee">
                Saved payee
                <RequiredAsterisk />
              </Label>
              <Select
                value={form.payee_id || '__none__'}
                onValueChange={(v) => {
                  const payeeId = v === '__none__' ? '' : v;
                  const payee = (payeesQuery.data ?? []).find((p) => p.id === payeeId);
                  setForm((f) => ({
                    ...f,
                    payee_id: payeeId,
                    recipient_name: payee?.display_name ?? f.recipient_name,
                    recipient_type: payee?.payee_type ?? f.recipient_type,
                    destination_account: payee?.masked_account ?? f.destination_account,
                    currency: payee?.currency ?? f.currency,
                  }));
                }}
              >
                <SelectTrigger
                  id="ct-payee"
                  aria-required="true"
                  aria-invalid={Boolean(draftValidation.byField.payee_id)}
                  aria-describedby="help-payee"
                >
                  <SelectValue placeholder="Select verified payee" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select a saved payee…</SelectItem>
                  {(payeesQuery.data ?? []).filter((p) => p.active && !p.paused && !p.archived_at).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.display_name} · {p.masked_account} · {
                        isCompanyPayeeProviderVerified(p.account_verification_status)
                          ? 'PROVIDER_VERIFIED'
                          : 'UNVERIFIED'
                      }
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHelp id="help-payee">{COMPANY_TRANSFER_FORM_FIELD_HELP.saved_payee}</FieldHelp>
              <FieldError message={draftValidation.byField.payee_id} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-category">
                Category
                <RequiredAsterisk />
              </Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}
              >
                <SelectTrigger
                  id="ct-category"
                  aria-required="true"
                  aria-invalid={Boolean(draftValidation.byField.category)}
                  aria-describedby="help-category"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPANY_TRANSFER_CATEGORIES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHelp id="help-category">{COMPANY_TRANSFER_FORM_FIELD_HELP.category}</FieldHelp>
              <FieldError message={draftValidation.byField.category} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-money-source">
                Money source
                <AutoFilledTag />
              </Label>
              <Select value="COMPANY_BALANCE" disabled>
                <SelectTrigger id="ct-money-source" aria-describedby="help-money-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPANY_TRANSFER_MONEY_SOURCES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHelp id="help-money-source">{COMPANY_TRANSFER_FORM_FIELD_HELP.money_source}</FieldHelp>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-source-account">
                Source Revolut account
                <AutoFilledTag />
              </Label>
              <Input
                id="ct-source-account"
                value={resolvedSourceAccount}
                readOnly
                disabled
                aria-describedby="help-source-account"
                placeholder="Configured company funding account"
              />
              <FieldHelp id="help-source-account">{COMPANY_TRANSFER_FORM_FIELD_HELP.source_account}</FieldHelp>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-destination">
                Destination
                <AutoFilledTag />
              </Label>
              <Input
                id="ct-destination"
                value={form.destination_account}
                readOnly
                disabled
                aria-describedby="help-destination"
                placeholder="Masked account from saved payee"
              />
              <FieldHelp id="help-destination">{COMPANY_TRANSFER_FORM_FIELD_HELP.destination}</FieldHelp>
            </div>

            <div className="space-y-1">
              <div className="rounded-md border bg-muted/30 px-3 py-2 space-y-1">
                <div className="text-[11px] text-muted-foreground">Available Company Funds</div>
                <div className="text-lg font-semibold tabular-nums">
                  {liveFundsShortfall.available_label}
                </div>
              </div>
              <Label htmlFor="ct-amount">
                Requested amount (pence)
                <RequiredAsterisk />
              </Label>
              <Input
                id="ct-amount"
                inputMode="numeric"
                value={form.amount_pence}
                onChange={(e) => setForm((f) => ({ ...f, amount_pence: e.target.value.replace(/[^\d]/g, '') }))}
                placeholder="1"
                aria-required="true"
                aria-invalid={Boolean(
                  draftValidation.byField.amount_pence
                  || (draftValidation.amount_pence != null && !preDraftFundsGate.ok),
                )}
                aria-describedby="help-amount amount-gbp funds-shortfall"
              />
              <p id="amount-gbp" className="text-sm font-medium tabular-nums pt-0.5">
                {draftValidation.gbp_display
                  ? `= ${draftValidation.gbp_display}`
                  : 'Enter pence to see GBP'}
              </p>
              {draftValidation.amount_pence != null ? (
                <div
                  id="funds-shortfall"
                  className={`rounded-md border px-3 py-2 text-xs space-y-1 ${
                    liveFundsShortfall.valid
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                      : 'border-red-300 bg-red-50 text-red-900'
                  }`}
                >
                  <div>Requested: {liveFundsShortfall.requested_label}</div>
                  <div>Available: {liveFundsShortfall.available_label}</div>
                  <div className="font-medium">
                    Shortfall: {liveFundsShortfall.shortfall_label}
                  </div>
                  {liveFundsShortfall.valid ? (
                    <p className="pt-1 text-emerald-800">
                      Company funds check PASS — requested ≤ Available Company Funds.
                    </p>
                  ) : null}
                  {!liveFundsShortfall.valid && preDraftFundsGate.message ? (
                    <p className="whitespace-pre-line pt-1">{preDraftFundsGate.message}</p>
                  ) : null}
                </div>
              ) : null}
              <FieldHelp id="help-amount">{COMPANY_TRANSFER_FORM_FIELD_HELP.amount_pence}</FieldHelp>
              <FieldError message={draftValidation.byField.amount_pence} />
              {draftValidation.large_amount_warning ? (
                <p className="text-[11px] text-amber-700">
                  This amount is unusually large for a manual draft. You will be asked to confirm before create.
                </p>
              ) : null}
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-approved">Approved amount (pence)</Label>
              <Input
                id="ct-approved"
                inputMode="numeric"
                value={form.approved_amount_pence}
                onChange={(e) => setForm((f) => ({
                  ...f,
                  approved_amount_pence: e.target.value.replace(/[^\d]/g, ''),
                }))}
                placeholder="Defaults to requested"
                aria-describedby="help-approved"
              />
              <FieldHelp id="help-approved">{COMPANY_TRANSFER_FORM_FIELD_HELP.approved_amount}</FieldHelp>
              <FieldError message={draftValidation.byField.approved_amount_pence} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-reference">
                Payment reference
                <Badge variant="secondary" className="ml-1 align-middle text-[10px] font-normal">
                  Auto
                </Badge>
              </Label>
              <div className="flex gap-2">
                <Input
                  id="ct-reference"
                  value={editingTransferId && form.payment_reference
                    ? form.payment_reference
                    : paymentReferencePreview}
                  readOnly
                  disabled
                  className="font-mono text-xs"
                  aria-describedby="help-reference"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  title="Copy payment reference"
                  onClick={() => {
                    const value = editingTransferId && form.payment_reference
                      ? form.payment_reference
                      : paymentReferencePreview;
                    void navigator.clipboard.writeText(value);
                    toast.message(editingTransferId
                      ? 'Payment reference copied'
                      : 'Preview format copied — final reference assigned on create');
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <FieldHelp id="help-reference">{COMPANY_TRANSFER_FORM_FIELD_HELP.payment_reference}</FieldHelp>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-statement-ref">Statement reference (optional)</Label>
              <Input
                id="ct-statement-ref"
                value={form.statement_reference}
                onChange={(e) => setForm((f) => ({ ...f, statement_reference: e.target.value }))}
                placeholder="Optional custom label"
                maxLength={100}
                aria-describedby="help-statement-ref"
              />
              <FieldHelp id="help-statement-ref">
                {COMPANY_TRANSFER_FORM_FIELD_HELP.statement_reference}
              </FieldHelp>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-scheduled">
                Scheduled date/time
                {form.transfer_kind === 'SCHEDULED' ? <RequiredAsterisk /> : null}
              </Label>
              <Input
                id="ct-scheduled"
                type="datetime-local"
                value={form.scheduled_at}
                onChange={(e) => setForm((f) => ({ ...f, scheduled_at: e.target.value }))}
                aria-required={form.transfer_kind === 'SCHEDULED'}
                aria-invalid={Boolean(draftValidation.byField.scheduled_at)}
                aria-describedby="help-scheduled"
              />
              <FieldHelp id="help-scheduled">
                {form.transfer_kind === 'SCHEDULED'
                  ? COMPANY_TRANSFER_FORM_FIELD_HELP.scheduled_at_required
                  : COMPANY_TRANSFER_FORM_FIELD_HELP.scheduled_at}
              </FieldHelp>
              <FieldError message={draftValidation.byField.scheduled_at} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-currency">
                Currency
                <RequiredAsterisk />
                {selectedPayee ? <AutoFilledTag /> : null}
              </Label>
              <Input
                id="ct-currency"
                value={form.currency}
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
                readOnly={Boolean(selectedPayee)}
                disabled={Boolean(selectedPayee)}
                aria-required="true"
                aria-invalid={Boolean(draftValidation.byField.currency)}
                aria-describedby="help-currency"
              />
              <FieldHelp id="help-currency">{COMPANY_TRANSFER_FORM_FIELD_HELP.currency}</FieldHelp>
              <FieldError message={draftValidation.byField.currency} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-service-area">
                Service area
                <RequiredAsterisk />
                {serviceAreaId ? <AutoFilledTag /> : null}
              </Label>
              <Select
                value={form.service_area_id || serviceAreaId || '__none__'}
                onValueChange={(v) => setForm((f) => ({
                  ...f,
                  service_area_id: v === '__none__' ? '' : v,
                }))}
                disabled={Boolean(serviceAreaId)}
              >
                <SelectTrigger
                  id="ct-service-area"
                  aria-required="true"
                  aria-invalid={Boolean(draftValidation.byField.service_area_id)}
                  aria-describedby="help-service-area"
                >
                  <SelectValue placeholder="Select service area" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Select service area…</SelectItem>
                  {serviceAreas.map((sa) => (
                    <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldHelp id="help-service-area">{COMPANY_TRANSFER_FORM_FIELD_HELP.service_area}</FieldHelp>
              <FieldError message={draftValidation.byField.service_area_id} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-cost-centre">Cost centre</Label>
              <Input
                id="ct-cost-centre"
                value={form.cost_centre}
                onChange={(e) => setForm((f) => ({ ...f, cost_centre: e.target.value }))}
                placeholder="ADMIN"
                aria-describedby="help-cost-centre"
              />
              <FieldHelp id="help-cost-centre">{COMPANY_TRANSFER_FORM_FIELD_HELP.cost_centre}</FieldHelp>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ct-provider">
                Provider
                <RequiredAsterisk />
                <AutoFilledTag />
              </Label>
              <Input
                id="ct-provider"
                value={form.provider}
                readOnly
                disabled
                aria-required="true"
                aria-describedby="help-provider"
              />
              <FieldHelp id="help-provider">{COMPANY_TRANSFER_FORM_FIELD_HELP.provider}</FieldHelp>
              <FieldError message={draftValidation.byField.provider} />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="ct-attachment">Attachment URL</Label>
              <Input
                id="ct-attachment"
                value={form.attachment_url}
                onChange={(e) => setForm((f) => ({ ...f, attachment_url: e.target.value }))}
                placeholder="https://..."
                aria-describedby="help-attachment"
              />
              <FieldHelp id="help-attachment">{COMPANY_TRANSFER_FORM_FIELD_HELP.attachment_url}</FieldHelp>
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="ct-purpose">
                Purpose
                <RequiredAsterisk />
              </Label>
              <Textarea
                id="ct-purpose"
                value={form.purpose}
                onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))}
                placeholder="£0.01 company transfer certification."
                aria-required="true"
                aria-invalid={Boolean(draftValidation.byField.purpose)}
                aria-describedby="help-purpose"
              />
              <FieldHelp id="help-purpose">{COMPANY_TRANSFER_FORM_FIELD_HELP.purpose}</FieldHelp>
              <FieldError message={draftValidation.byField.purpose} />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="ct-notes">Internal notes</Label>
              <Textarea
                id="ct-notes"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                aria-describedby="help-notes"
              />
              <FieldHelp id="help-notes">{COMPANY_TRANSFER_FORM_FIELD_HELP.notes}</FieldHelp>
            </div>

            <div className="sm:col-span-2 rounded-md border bg-muted/30 p-3 space-y-2">
              <div className="text-sm font-medium">Review before create</div>
              <dl className="grid gap-1.5 sm:grid-cols-2 text-xs">
                {draftSummary.lines.map((line) => (
                  <div key={line.label} className="flex gap-2 min-w-0">
                    <dt className="text-muted-foreground shrink-0">{line.label}:</dt>
                    <dd className="font-medium break-words">{line.value}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-muted-foreground">{draftSummary.execution_note}</p>
              {!LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED ? (
                <p className="text-xs text-amber-700">
                  Submit / Execute stay disabled while company LIVE is off. Draft creation remains available.
                </p>
              ) : null}
              {createPrecheck.first_visible_error ? (
                <p role="alert" className="text-sm text-destructive font-medium">
                  {createPrecheck.first_visible_error}
                </p>
              ) : null}
              <div className="rounded-md border px-3 py-2 space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">Precheck validators</div>
                <ul className="text-[11px] space-y-0.5">
                  {createPrecheck.validators.map((v) => (
                    <li
                      key={v.id}
                      className={v.ok ? 'text-emerald-800' : 'text-destructive'}
                    >
                      {v.ok ? 'PASS' : 'FAIL'} — {v.label}
                      {v.message ? `: ${v.message}` : ''}
                      {v.id === 'requested_amount' && v.ok && createPrecheck.requested_pence != null
                        ? ` (${createPrecheck.requested_pence}p ≤ ${createPrecheck.available_company_funds_pence ?? '—'}p)`
                        : ''}
                    </li>
                  ))}
                </ul>
              </div>
              {draftValidation.errors.length > 0 ? (
                <ul className="text-[11px] text-destructive list-disc pl-4 space-y-0.5">
                  {draftValidation.errors.map((e) => (
                    <li key={`${e.field}-${e.message}`}>{e.message}</li>
                  ))}
                </ul>
              ) : null}
              <Button
                disabled={
                  createMutation.isPending
                  || !draftValidation.ok
                  || !(preDraftFundsGate.ok)
                  || activePayees.length === 0
                  || form.transfer_kind === 'RECURRING'
                }
                onClick={() => {
                  if (!draftValidation.ok) {
                    toast.error(createPrecheck.first_visible_error ?? 'Select a saved payee.');
                    return;
                  }
                  if (!preDraftFundsGate.ok) {
                    toast.error(preDraftFundsGate.message ?? 'Insufficient Available Company Funds');
                    return;
                  }
                  if (!window.confirm(
                    `${editingTransferId ? 'Save draft changes' : 'Create draft'}?\n\n`
                    + `${draftSummary.lines.map((l) => `${l.label}: ${l.value}`).join('\n')}\n`
                    + `${draftSummary.execution_note}`,
                  )) return;
                  createMutation.mutate();
                }}
              >
                {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {editingTransferId ? 'Save Draft' : 'Create Draft'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading company transfers...
        </div>
      ) : (failedOnly ? transfers : operationalTransfers).length === 0 ? (
        <Alert>
          <AlertTitle>{failedOnly ? 'No failed company transfers' : 'No company transfers yet'}</AlertTitle>
          <AlertDescription>
            {failedOnly
              ? 'Failed company transfers will appear here. Driver payouts stay on Driver Payouts and Batch History.'
              : (emptyCopy
                ?? 'No company transfers yet. Driver payouts are shown under Driver Payouts and Batch History.')}
          </AlertDescription>
        </Alert>
      ) : failedOnly ? (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transfer ID</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Provider Error</TableHead>
                <TableHead>Retry Available</TableHead>
                <TableHead>Retry Count</TableHead>
                <TableHead>Last Attempt</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {operationalTransfers.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="text-xs font-mono">{t.transfer_ref}</TableCell>
                  <TableCell className="text-xs">{t.recipient_name}</TableCell>
                  <TableCell className="text-xs max-w-[200px] truncate">{t.failure_reason ?? '—'}</TableCell>
                  <TableCell className="text-xs max-w-[200px] truncate">{t.provider_error ?? '—'}</TableCell>
                  <TableCell className="text-xs">{t.status === 'FAILED' ? 'Yes' : 'No'}</TableCell>
                  <TableCell className="text-xs">{t.retry_count}</TableCell>
                  <TableCell className="text-xs">{shortDate(t.last_attempt_at)}</TableCell>
                  <TableCell className="text-xs space-x-1">
                    <Button size="sm" variant="outline" disabled title="Read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">
                      Retry
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => openTransferReceipt(t)}>
                      <Printer className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transfer ID</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Requested / Approved</TableHead>
                <TableHead>Provider ref</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {operationalTransfers.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="text-xs">
                    <div className="font-mono">{t.transfer_ref}</div>
                    <div className="text-muted-foreground">{shortDate(t.created_at)}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div>{t.recipient_name}</div>
                    <div className="text-muted-foreground">{t.recipient_type}</div>
                  </TableCell>
                  <TableCell className="text-xs">{t.category}</TableCell>
                  <TableCell className="text-xs"><Badge variant="outline">{t.money_source}</Badge></TableCell>
                  <TableCell className="text-xs tabular-nums">{formatNullablePence(t.amount_pence)}</TableCell>
                  <TableCell className="text-xs"><Badge variant="secondary">{companyTransferStatusLabel(t.status)}</Badge></TableCell>
                  <TableCell className="text-xs font-mono">
                    <div>{t.requested_by?.slice(0, 8) ?? '—'}</div>
                    <div className="text-muted-foreground">{t.approved_by?.slice(0, 8) ?? '—'}</div>
                  </TableCell>
                  <TableCell className="text-xs font-mono">{t.provider_reference ?? '—'}</TableCell>
                  <TableCell className="text-xs space-x-1">
                    {t.status === 'DRAFT' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionMutation.isPending}
                        onClick={() => actionMutation.mutate({
                          action: 'submit_for_approval',
                          transfer_id: t.id,
                        })}
                      >
                        Submit
                      </Button>
                    )}
                    {t.status === 'AWAITING_APPROVAL' && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={actionMutation.isPending}
                          onClick={() => requestApprove(t)}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={actionMutation.isPending}
                          onClick={() => {
                            const reason = window.prompt('Reject reason?');
                            if (!reason) return;
                            actionMutation.mutate({ action: 'reject', transfer_id: t.id, reason });
                          }}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED || actionMutation.isPending
                      }
                      title={
                        LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED
                          ? 'Execute company transfer'
                          : 'LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED=false'
                      }
                      onClick={() => {
                        if (!LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED) return;
                        actionMutation.mutate({
                          action: 'execute',
                          transfer_id: t.id,
                          execute_live: true,
                        });
                      }}
                    >
                      {LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED
                        ? 'Execute'
                        : 'Execute (disabled)'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED || submitProviderMutation.isPending
                      }
                      title={
                        LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED
                          ? 'Submit to Revolut provider'
                          : 'LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED=false'
                      }
                      onClick={() => {
                        if (!LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED) return;
                        submitProviderMutation.mutate(t.id);
                      }}
                    >
                      {LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED
                        ? 'Submit Transfer'
                        : 'Submit (disabled)'}
                    </Button>
                    {COMPANY_TRANSFER_RECONCILE_STATUSES.has(String(t.status).toUpperCase())
                      || ['SUBMITTED', 'PROCESSING', 'SUBMITTING'].includes(String(t.status).toUpperCase()) ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={syncProviderMutation.isPending}
                          onClick={() => syncProviderMutation.mutate(t.id)}
                        >
                          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Sync status
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={finalizeMutation.isPending}
                          onClick={() => finalizeMutation.mutate(t.id)}
                        >
                          Finalize
                        </Button>
                      </>
                    ) : null}
                    {!['PAID', 'COMPLETED', 'CANCELLED', 'REVERTED'].includes(String(t.status)) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={actionMutation.isPending}
                        onClick={() => {
                          const reason = window.prompt('Cancel reason?');
                          if (!reason) return;
                          actionMutation.mutate({ action: 'cancel', transfer_id: t.id, reason });
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => void viewEvidence(t.id)}>
                      Evidence
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => openTransferReceipt(t)}>
                      <Printer className="h-3.5 w-3.5 mr-1" /> PDF
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
        </TabsContent>
      </Tabs>

      <Dialog
        open={soleAdminTransfer != null}
        onOpenChange={(open) => {
          if (!open && !actionMutation.isPending) setSoleAdminTransfer(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Sole-admin approval</DialogTitle>
            <DialogDescription>
              No second authorised approver is currently configured.
              Your approval will be recorded in the audit log.
              This does not submit to Revolut.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-md border bg-muted/40 p-3 space-y-1 text-xs">
              <div>Transfer: {soleAdminTransfer?.transfer_ref ?? '—'}</div>
              <div>Type: {soleAdminTransfer?.transfer_type ?? '—'}</div>
              <div>Amount: {formatNullablePence(soleAdminTransfer?.amount_pence ?? null)}</div>
              <div>Payee: {soleAdminTransfer?.recipient_name ?? '—'}</div>
            </div>
            <div>
              <Label htmlFor="ct-sole-admin-reason">Audit reason (required)</Label>
              <Textarea
                id="ct-sole-admin-reason"
                rows={3}
                value={soleAdminReason}
                onChange={(e) => setSoleAdminReason(e.target.value)}
                disabled={actionMutation.isPending}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={actionMutation.isPending}
              onClick={() => setSoleAdminTransfer(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={actionMutation.isPending || soleAdminReason.trim().length < 10}
              onClick={() => {
                if (!soleAdminTransfer) return;
                actionMutation.mutate({
                  action: 'approve',
                  transfer_id: soleAdminTransfer.id,
                  confirm_sole_admin_approval: true,
                  override_reason: soleAdminReason.trim(),
                  reason: soleAdminReason.trim(),
                });
              }}
            >
              {actionMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : 'Approve as sole administrator'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
