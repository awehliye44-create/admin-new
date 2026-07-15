/**
 * Company Transfers panel — Payout Ledger SSOT only.
 * Money source: COMPANY_BALANCE / APPROVED_COMPANY_PAYABLE. Never driver wallet.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Plus, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
  COMPANY_TRANSFER_MONEY_SOURCES,
  COMPANY_TRANSFER_RECIPIENT_TYPES,
} from '../../../shared/companyOutgoingTransferSSOT';

function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB');
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
  const { data: serviceAreas = [] } = useServiceAreas({ activeOnly: true });
  const [showForm, setShowForm] = useState(false);
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
    scheduled_at: '',
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
      const amountPence = Math.round(Number(form.amount_pence));
      const approvedPence = form.approved_amount_pence.trim()
        ? Math.round(Number(form.approved_amount_pence))
        : amountPence;
      if (!Number.isFinite(amountPence) || amountPence <= 0) {
        throw new Error('Enter amount in pence (backend SSOT units)');
      }
      if (!Number.isFinite(approvedPence) || approvedPence <= 0) {
        throw new Error('Enter approved amount in pence');
      }
      if (!form.payee_id && !form.recipient_name.trim()) {
        throw new Error('Select a saved payee or enter recipient name');
      }
      const idempotencyKey = `manual:${crypto.randomUUID()}`;
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_TRANSFER_FN, {
        body: {
          action: 'create',
          payee_id: form.payee_id || null,
          recipient_name: form.payee_id ? undefined : form.recipient_name,
          recipient_type: form.payee_id ? undefined : form.recipient_type,
          category: form.category,
          money_source:
            form.category === 'STAFF_REIMBURSEMENT'
            || form.category === 'STAFF_SALARY'
            || form.category === 'DIRECTOR_SALARY'
              ? 'COMPANY_BALANCE'
              : form.money_source,
          source_account: form.source_account || null,
          destination_account: form.destination_account || null,
          amount_pence: amountPence,
          approved_amount_pence: approvedPence,
          currency: form.currency || 'GBP',
          purpose: form.purpose,
          payment_reference: form.payment_reference || null,
          scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : null,
          execution_mode: 'DRAFT_FOR_APPROVAL',
          service_area_id: form.service_area_id || serviceAreaId || null,
          cost_centre: form.cost_centre || null,
          provider: form.provider || 'revolut_business',
          notes: form.notes || null,
          attachment_url: form.attachment_url || null,
          idempotency_key: idempotencyKey,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Create failed');
      return data;
    },
    onSuccess: (data) => {
      const ref = data?.transfer?.transfer_ref ?? 'created';
      toast.success(`Company transfer ${ref} submitted for approval`);
      setShowForm(false);
      void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const actionMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_TRANSFER_FN, { body });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Action failed');
      return data;
    },
    onSuccess: () => {
      toast.success('Transfer updated');
      void queryClient.invalidateQueries({ queryKey: ['admin-payout-ledger'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

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

  const awaitingApproval = useMemo(
    () => transfers.filter((t) => ['AWAITING_APPROVAL', 'DRAFT'].includes(String(t.status))),
    [transfers],
  );
  const historyTransfers = useMemo(
    () => transfers.filter((t) =>
      ['PAID', 'COMPLETED', 'FAILED', 'CANCELLED', 'DECLINED', 'REJECTED', 'REVERTED', 'FUNDING_UNAVAILABLE']
        .includes(String(t.status))),
    [transfers],
  );

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
          Live Revolut execution stays gated (execute_live) during validation.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue={failedOnly ? 'transfers' : 'transfers'}>
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="transfers">Transfers</TabsTrigger>
          {!failedOnly && <TabsTrigger value="payees">Payees</TabsTrigger>}
          {!failedOnly && <TabsTrigger value="automatic">Automatic Payments</TabsTrigger>}
          {!failedOnly && <TabsTrigger value="approvals">Approvals</TabsTrigger>}
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="payees" className="space-y-4">
          <CompanyTransfersPayeesSection serviceAreaId={serviceAreaId} focus="payees" />
        </TabsContent>

        <TabsContent value="automatic" className="space-y-4">
          <CompanyTransfersPayeesSection serviceAreaId={serviceAreaId} focus="schedules" />
        </TabsContent>

        <TabsContent value="approvals" className="space-y-4">
          <p className="text-xs text-muted-foreground">
            High-risk categories always require approval. Requester cannot approve their own transfer.
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
                    <TableCell><Badge variant="outline">{t.status}</Badge></TableCell>
                    <TableCell className="space-x-1">
                      <Button size="sm" variant="outline" disabled title="Read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">Approve</Button>
                      <Button size="sm" variant="ghost" disabled title="Read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">Reject</Button>
                    </TableCell>
                  </TableRow>
                ))}
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
                    <TableCell><Badge variant="outline">{t.status}</Badge></TableCell>
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
              ONECAB Available Company Funds
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
              Spendable company balance — never the Revolut source total
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
              title="Configured operational/refund reserve. Absence = OPERATIONAL_RESERVE_NOT_CONFIGURED — never invent £0."
            >
              Operational / Refund Reserve
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {reserveSection.kind === 'unavailable' ? (
              <>
                <div className="text-sm font-semibold text-amber-700">NOT_CONFIGURED</div>
                <div className="text-xs font-mono text-muted-foreground">
                  {reserveSection.reason ?? 'OPERATIONAL_RESERVE_NOT_CONFIGURED'}
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
        <AlertTitle>Company Transfers read-only</AlertTitle>
        <AlertDescription>
          LIVE_PAYOUT_EXECUTION_ENABLED=false. Balance, payees, approvals and history are display-only.
          No Pay Now, Revolut /pay, counterparty creation, wallet debit, or batch execution in this slice.
        </AlertDescription>
      </Alert>

      {companyUnavailable && !failedOnly ? (
        <Alert>
          <AlertTitle>Funding unavailable</AlertTitle>
          <AlertDescription>
            New company transfers that spend COMPANY_BALANCE are blocked until a Revolut Business
            source account is selected via Payment Providers → Use as source.
            Reason: {companyUnavailableReason}. This is not £0.00 — Driver Wallet money is never used.
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
          <Button size="sm" disabled title="Company Transfers remain read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">
            <Plus className="h-4 w-4 mr-2" /> New company transfer (disabled)
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

      {false && showForm && !failedOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create company transfer</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2 text-xs text-muted-foreground">
              Prefer a verified saved payee. Bank details stay encrypted server-side; UI shows masked accounts only.
              Default mode DRAFT_FOR_APPROVAL — no live Revolut /pay from this form.
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Saved payee</Label>
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
                    payment_reference: payee?.default_reference ?? f.payment_reference,
                  }));
                }}
              >
                <SelectTrigger><SelectValue placeholder="Select verified payee" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Manual recipient (legacy)</SelectItem>
                  {(payeesQuery.data ?? []).map((p) => (
                    <SelectItem
                      key={p.id}
                      value={p.id}
                      disabled={p.account_verification_status !== 'VERIFIED' || p.paused || !p.active}
                    >
                      {p.display_name} · {p.masked_account} · {p.account_verification_status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!form.payee_id ? (
              <>
            <div className="space-y-1">
              <Label>Recipient</Label>
              <Input
                value={form.recipient_name}
                onChange={(e) => setForm((f) => ({ ...f, recipient_name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Recipient type</Label>
              <Select
                value={form.recipient_type}
                onValueChange={(v) => setForm((f) => ({ ...f, recipient_type: v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPANY_TRANSFER_RECIPIENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
              </>
            ) : null}
            <div className="space-y-1">
              <Label>Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPANY_TRANSFER_CATEGORIES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Money source</Label>
              <Select
                value={
                  form.category === 'STAFF_REIMBURSEMENT' || form.category === 'STAFF_SALARY' || form.category === 'DIRECTOR_SALARY'
                    ? 'COMPANY_BALANCE'
                    : form.money_source
                }
                onValueChange={(v) => setForm((f) => ({ ...f, money_source: v }))}
                disabled={form.category === 'STAFF_REIMBURSEMENT' || form.category === 'STAFF_SALARY' || form.category === 'DIRECTOR_SALARY'}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPANY_TRANSFER_MONEY_SOURCES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Source Revolut account</Label>
              <Input
                value={form.source_account}
                onChange={(e) => setForm((f) => ({ ...f, source_account: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Destination (masked)</Label>
              <Input
                value={form.destination_account}
                onChange={(e) => setForm((f) => ({ ...f, destination_account: e.target.value }))}
                disabled={Boolean(form.payee_id)}
              />
            </div>
            <div className="space-y-1">
              <Label>Requested amount (pence)</Label>
              <Input
                inputMode="numeric"
                value={form.amount_pence}
                onChange={(e) => setForm((f) => ({ ...f, amount_pence: e.target.value }))}
                placeholder="e.g. 25000 for £250"
              />
            </div>
            <div className="space-y-1">
              <Label>Approved amount (pence)</Label>
              <Input
                inputMode="numeric"
                value={form.approved_amount_pence}
                onChange={(e) => setForm((f) => ({ ...f, approved_amount_pence: e.target.value }))}
                placeholder="Defaults to requested"
              />
            </div>
            <div className="space-y-1">
              <Label>Payment reference</Label>
              <Input
                value={form.payment_reference}
                onChange={(e) => setForm((f) => ({ ...f, payment_reference: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Scheduled date/time</Label>
              <Input
                type="datetime-local"
                value={form.scheduled_at}
                onChange={(e) => setForm((f) => ({ ...f, scheduled_at: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Currency</Label>
              <Input
                value={form.currency}
                onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Service area</Label>
              <Select
                value={form.service_area_id || serviceAreaId || '__none__'}
                onValueChange={(v) => setForm((f) => ({
                  ...f,
                  service_area_id: v === '__none__' ? '' : v,
                }))}
              >
                <SelectTrigger><SelectValue placeholder="Select service area" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {serviceAreas.map((sa) => (
                    <SelectItem key={sa.id} value={sa.id}>{sa.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Cost centre</Label>
              <Input
                value={form.cost_centre}
                onChange={(e) => setForm((f) => ({ ...f, cost_centre: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Provider</Label>
              <Input
                value={form.provider}
                onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Attachment URL</Label>
              <Input
                value={form.attachment_url}
                onChange={(e) => setForm((f) => ({ ...f, attachment_url: e.target.value }))}
                placeholder="https://..."
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Purpose</Label>
              <Textarea
                value={form.purpose}
                onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Notes</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
            <div className="sm:col-span-2">
              <Button
                disabled={
                  createMutation.isPending
                  || !form.recipient_name
                  || !form.purpose
                  || !form.source_account
                  || !form.destination_account
                }
                onClick={() => {
                  if (!window.confirm('Submit company transfer for approval? Requester cannot self-approve.')) return;
                  createMutation.mutate();
                }}
              >
                {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Submit for approval
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading company transfers...
        </div>
      ) : transfers.length === 0 ? (
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
              {transfers.map((t) => (
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
              {transfers.map((t) => (
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
                  <TableCell className="text-xs"><Badge variant="secondary">{t.status}</Badge></TableCell>
                  <TableCell className="text-xs font-mono">
                    <div>{t.requested_by?.slice(0, 8) ?? '—'}</div>
                    <div className="text-muted-foreground">{t.approved_by?.slice(0, 8) ?? '—'}</div>
                  </TableCell>
                  <TableCell className="text-xs font-mono">{t.provider_reference ?? '—'}</TableCell>
                  <TableCell className="text-xs space-x-1">
                    <Button size="sm" variant="outline" disabled title="Read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">
                      Approve
                    </Button>
                    <Button size="sm" variant="ghost" disabled title="Read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">
                      Reject
                    </Button>
                    <Button size="sm" variant="outline" disabled title="Read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">
                      Mark paid
                    </Button>
                    <Button size="sm" variant="outline" disabled title="Read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">
                      Process
                    </Button>
                    <Button size="sm" variant="ghost" disabled title="Read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">
                      Cancel
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
    </div>
  );
}
