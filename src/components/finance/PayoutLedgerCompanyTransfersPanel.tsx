/**
 * Company Transfers panel — Payout Ledger SSOT only.
 * Money source: COMPANY_BALANCE / APPROVED_COMPANY_PAYABLE. Never driver wallet.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { useServiceAreas } from '@/hooks/useServiceAreas';
import { supabase } from '@/integrations/supabase/client';
import { downloadCsv, printPayoutReceipt } from '@/lib/financeExport';
import { formatNullablePence } from '@/lib/formatNullablePence';
import {
  ADMIN_COMPANY_TRANSFER_FN,
  type CompanyOutgoingTransferRow,
} from '../../../shared/adminPayoutLedgerSSOT';
import type { CompanyBalanceSnapshot } from '../../../shared/companyBalanceSSOT';
import { COMPANY_BALANCE_ERROR } from '../../../shared/companyBalanceSSOT';
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
    completed_month_pence: number;
    failed_count: number;
  } | null;
}) {
  const queryClient = useQueryClient();
  const { data: serviceAreas = [] } = useServiceAreas({ activeOnly: true });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    recipient_name: '',
    recipient_type: 'STAFF',
    category: 'STAFF_REIMBURSEMENT',
    money_source: 'COMPANY_BALANCE',
    source_account: '',
    destination_account: '',
    amount_pence: '',
    currency: 'GBP',
    purpose: '',
    service_area_id: serviceAreaId ?? '',
    cost_centre: '',
    provider: 'manual',
    notes: '',
    attachment_url: '',
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const amountPence = Math.round(Number(form.amount_pence));
      if (!Number.isFinite(amountPence) || amountPence <= 0) {
        throw new Error('Enter amount in pence (backend SSOT units)');
      }
      const idempotencyKey = `manual:${crypto.randomUUID()}`;
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_TRANSFER_FN, {
        body: {
          action: 'create',
          recipient_name: form.recipient_name,
          recipient_type: form.recipient_type,
          category: form.category,
          money_source:
            form.category === 'STAFF_REIMBURSEMENT' || form.category === 'STAFF_SALARY'
              ? 'COMPANY_BALANCE'
              : form.money_source,
          source_account: form.source_account || null,
          destination_account: form.destination_account || null,
          amount_pence: amountPence,
          currency: form.currency || 'GBP',
          purpose: form.purpose,
          service_area_id: form.service_area_id || serviceAreaId || null,
          cost_centre: form.cost_centre || null,
          provider: form.provider || null,
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

  const companyUnavailable =
    !companyBalance
    || companyBalance.status === 'UNAVAILABLE'
    || companyBalance.company_available_for_transfer_pence == null;
  const companyUnavailableReason =
    companyBalance?.unavailable_reason ?? COMPANY_BALANCE_ERROR.SOURCE_UNAVAILABLE;

  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>Company money only</AlertTitle>
        <AlertDescription>
          Company transfers use ONECAB Company Balance or Approved Company Payables.
          Driver Wallet and Payment Sessions are never consumed here.
        </AlertDescription>
      </Alert>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">ONECAB Company Balance</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {companyUnavailable ? (
              <>
                <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
                <div className="text-xs font-mono text-muted-foreground">{companyUnavailableReason}</div>
              </>
            ) : (
              <div className="text-xl font-semibold tabular-nums">
                {formatNullablePence(companyBalance?.company_ledger_balance_pence)}
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">Source: Company Balance SSOT</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Available for Transfer</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {companyUnavailable ? (
              <>
                <div className="text-sm font-semibold text-amber-700">UNAVAILABLE</div>
                <div className="text-xs font-mono text-muted-foreground">{companyUnavailableReason}</div>
              </>
            ) : (
              <div className="text-xl font-semibold tabular-nums">
                {formatNullablePence(companyBalance?.company_available_for_transfer_pence)}
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">Source: Company Balance SSOT</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Approved Payables</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">
            {formatNullablePence(kpis?.approved_payables_pending_pence ?? null)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Awaiting Approval</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">
            {kpis?.awaiting_approval_count ?? '—'}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Processing</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">
            {formatNullablePence(kpis?.processing_pence ?? null)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Completed This Month</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">
            {formatNullablePence(kpis?.completed_month_pence ?? null)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Failed Transfers</CardTitle></CardHeader>
          <CardContent className="text-xl font-semibold tabular-nums">
            {kpis?.failed_count ?? '—'}
          </CardContent>
        </Card>
      </div>

      {companyUnavailable && !failedOnly ? (
        <Alert>
          <AlertTitle>Funding unavailable</AlertTitle>
          <AlertDescription>
            New company transfers that spend COMPANY_BALANCE are blocked until a proven company cash source is wired.
            Reason: {companyUnavailableReason}. This is not £0.00.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {!failedOnly && (
          <Button size="sm" onClick={() => setShowForm((v) => !v)} disabled={companyUnavailable}>
            <Plus className="h-4 w-4 mr-2" /> {showForm ? 'Hide form' : 'New company transfer'}
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
            <CardTitle className="text-base">Create company transfer</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2 text-xs text-muted-foreground">
              Transfer ID is assigned by the backend on submit. Requested By is the signed-in admin.
              Approved By / Provider Reference / Status / Execution Time are set by the approval and pay workflow.
            </div>
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
                  form.category === 'STAFF_REIMBURSEMENT' || form.category === 'STAFF_SALARY'
                    ? 'COMPANY_BALANCE'
                    : form.money_source
                }
                onValueChange={(v) => setForm((f) => ({ ...f, money_source: v }))}
                disabled={form.category === 'STAFF_REIMBURSEMENT' || form.category === 'STAFF_SALARY'}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPANY_TRANSFER_MONEY_SOURCES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(form.category === 'STAFF_REIMBURSEMENT' || form.category === 'STAFF_SALARY') && (
                <p className="text-[10px] text-muted-foreground">Staff salary/reimbursement must use COMPANY_BALANCE.</p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Source account</Label>
              <Input
                value={form.source_account}
                onChange={(e) => setForm((f) => ({ ...f, source_account: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Destination account</Label>
              <Input
                value={form.destination_account}
                onChange={(e) => setForm((f) => ({ ...f, destination_account: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Amount (pence)</Label>
              <Input
                inputMode="numeric"
                value={form.amount_pence}
                onChange={(e) => setForm((f) => ({ ...f, amount_pence: e.target.value }))}
                placeholder="e.g. 25000 for £250"
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
            Create a transfer above. Driver payouts stay on the Driver Payouts tab.
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
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={actionMutation.isPending}
                      onClick={() => {
                        if (!window.confirm(`Retry ${t.transfer_ref}?`)) return;
                        actionMutation.mutate({ action: 'retry', transfer_id: t.id });
                      }}
                    >
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
                    {t.status === 'AWAITING_APPROVAL' && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={actionMutation.isPending}
                          onClick={() => {
                            if (!window.confirm(`Approve ${t.transfer_ref} for ${formatNullablePence(t.amount_pence)}?`)) return;
                            actionMutation.mutate({ action: 'approve', transfer_id: t.id });
                          }}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={actionMutation.isPending}
                          onClick={() => {
                            const reason = window.prompt('Rejection reason');
                            if (!reason) return;
                            actionMutation.mutate({ action: 'reject', transfer_id: t.id, reason });
                          }}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                    {t.status === 'APPROVED' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionMutation.isPending}
                        onClick={() => {
                          const provider_reference = window.prompt('Provider reference (required)');
                          if (!provider_reference) return;
                          if (!window.confirm(`Mark ${t.transfer_ref} paid with ref ${provider_reference}?`)) return;
                          actionMutation.mutate({
                            action: 'mark_paid',
                            transfer_id: t.id,
                            provider: t.provider || 'manual',
                            provider_reference,
                          });
                        }}
                      >
                        Mark paid
                      </Button>
                    )}
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
    </div>
  );
}
