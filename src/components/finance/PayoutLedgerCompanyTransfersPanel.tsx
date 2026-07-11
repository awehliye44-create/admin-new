/**
 * Company Transfers panel — Payout Ledger SSOT only.
 * Money source: COMPANY_BALANCE / APPROVED_COMPANY_PAYABLE. Never driver wallet.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Plus } from 'lucide-react';
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
import { supabase } from '@/integrations/supabase/client';
import { downloadCsv, printFinanceReport } from '@/lib/financeExport';
import { formatNullablePence } from '@/lib/formatNullablePence';
import {
  ADMIN_COMPANY_TRANSFER_FN,
  type CompanyOutgoingTransferRow,
} from '../../../shared/adminPayoutLedgerSSOT';
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

export function PayoutLedgerCompanyTransfersPanel({
  transfers,
  isLoading,
  failedOnly = false,
}: {
  transfers: CompanyOutgoingTransferRow[];
  isLoading: boolean;
  failedOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    recipient_name: '',
    recipient_type: 'STAFF',
    category: 'STAFF_REIMBURSEMENT',
    money_source: 'COMPANY_BALANCE',
    source_account: '',
    destination_account: '',
    amount_gbp: '',
    purpose: '',
    cost_centre: '',
    provider: 'manual',
    notes: '',
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const amountPence = Math.round(Number(form.amount_gbp) * 100);
      if (!Number.isFinite(amountPence) || amountPence <= 0) throw new Error('Enter a valid amount');
      const idempotencyKey = `manual:${crypto.randomUUID()}`;
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_TRANSFER_FN, {
        body: {
          action: 'create',
          recipient_name: form.recipient_name,
          recipient_type: form.recipient_type,
          category: form.category,
          money_source: form.money_source,
          source_account: form.source_account || null,
          destination_account: form.destination_account || null,
          amount_pence: amountPence,
          currency: 'GBP',
          purpose: form.purpose,
          cost_centre: form.cost_centre || null,
          provider: form.provider || null,
          notes: form.notes || null,
          idempotency_key: idempotencyKey,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Create failed');
      return data;
    },
    onSuccess: () => {
      toast.success('Company transfer submitted for approval');
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
        category: t.category,
        money_source: t.money_source,
        amount_pence: t.amount_pence,
        currency: t.currency,
        status: t.status,
        provider: t.provider,
        provider_reference: t.provider_reference,
        purpose: t.purpose,
      })),
    [transfers],
  );

  return (
    <div className="space-y-4">
      <Alert>
        <AlertTitle>Company money only</AlertTitle>
        <AlertDescription>
          Company transfers use ONECAB Company Balance or Approved Company Payables.
          Driver Wallet and Payment Sessions are never consumed here.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap gap-2">
        {!failedOnly && (
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            <Plus className="h-4 w-4 mr-2" /> {showForm ? 'Hide form' : 'New company transfer'}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={transfers.length === 0}
          onClick={() => downloadCsv('company-transfers.csv', exportRows)}
        >
          <Download className="h-4 w-4 mr-2" /> CSV / receipt export
        </Button>
        <Button variant="outline" size="sm" disabled={transfers.length === 0} onClick={() => printFinanceReport()}>
          Print receipt
        </Button>
      </div>

      {showForm && !failedOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create company transfer</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
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
                value={form.money_source}
                onValueChange={(v) => setForm((f) => ({ ...f, money_source: v }))}
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
              <Label>Amount (GBP)</Label>
              <Input
                inputMode="decimal"
                value={form.amount_gbp}
                onChange={(e) => setForm((f) => ({ ...f, amount_gbp: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Cost centre</Label>
              <Input
                value={form.cost_centre}
                onChange={(e) => setForm((f) => ({ ...f, cost_centre: e.target.value }))}
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
                disabled={createMutation.isPending || !form.recipient_name || !form.purpose}
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
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transfer</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
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
                    {t.status === 'FAILED' && (
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
                    )}
                    {(t.failure_reason || t.provider_error) && (
                      <div className="text-destructive max-w-[180px] truncate">
                        {t.failure_reason || t.provider_error}
                      </div>
                    )}
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
