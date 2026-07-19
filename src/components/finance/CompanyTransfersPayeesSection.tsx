/**
 * Company payees + automatic schedules — inside Payout Ledger Company Transfers.
 * Never shows plaintext bank details. Never uses Driver Wallet.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { formatNullablePence } from '@/lib/formatNullablePence';
import { ADMIN_COMPANY_PAYEES_FN } from '../../../shared/adminPayoutLedgerSSOT';
import {
  COMPANY_PAYEE_TYPES,
  type CompanyPayeePublicDto,
} from '../../../shared/companyPayeeSSOT';
import { COMPANY_TRANSFER_CATEGORIES } from '../../../shared/companyOutgoingTransferSSOT';

/** Local labels — keep payee CRUD deployable without shared SSOT drift. */
const PAYEE_TYPE_LABELS: Record<string, string> = {
  STAFF: 'Staff',
  DIRECTOR: 'Director',
  CONTRACTOR: 'Contractor',
  SUPPLIER: 'Supplier',
  OFFICE_EXPENSE: 'Office expense',
  SOFTWARE_SUBSCRIPTION: 'Software subscription',
  HMRC_TAX: 'Government / HMRC / Tax',
  INSURANCE: 'Insurance',
  VEHICLE_SUPPLIER: 'Vehicle supplier',
  REFUND_RECIPIENT: 'Refund recipient',
  EXPENSE_CLAIMANT: 'Expense claimant',
  OTHER: 'Other',
};

function companyPayeeTypeLabel(type: string | null | undefined): string {
  const t = String(type ?? 'OTHER').toUpperCase();
  return PAYEE_TYPE_LABELS[t] ?? (type || 'Other');
}

type ScheduleRow = {
  id: string;
  payee_id: string;
  automatic_enabled: boolean;
  frequency: string;
  weekly_day: string | null;
  monthly_day: number | null;
  local_processing_time: string;
  timezone: string;
  fixed_amount_pence: number | null;
  next_run_at_local: string | null;
  paused: boolean;
  category: string;
  execution_mode: string;
};

const emptyPayeeForm = {
  legal_name: '',
  display_name: '',
  payee_type: 'STAFF',
  email: '',
  account_holder_name: '',
  bank_name: '',
  sort_code: '',
  account_number: '',
  currency: 'GBP',
  country: 'GB',
  default_reference: '',
  link_revolut: false,
};

export function CompanyTransfersPayeesSection({
  serviceAreaId,
  focus = 'all',
}: {
  serviceAreaId?: string | null;
  focus?: 'all' | 'payees' | 'schedules';
}) {
  const queryClient = useQueryClient();
  const [showPayeeForm, setShowPayeeForm] = useState(false);
  const [editingPayeeId, setEditingPayeeId] = useState<string | null>(null);
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [payeeForm, setPayeeForm] = useState(emptyPayeeForm);
  const [scheduleForm, setScheduleForm] = useState({
    payee_id: '',
    frequency: 'WEEKLY',
    weekly_day: 'tuesday',
    local_processing_time: '12:00',
    timezone: 'Europe/London',
    fixed_amount_pence: '',
    category: 'STAFF_SALARY',
    automatic_enabled: true,
    approval_required: true,
  });

  const payeesQuery = useQuery({
    queryKey: ['admin-company-payees', serviceAreaId, typeFilter],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_PAYEES_FN, {
        body: {
          action: 'list_payees',
          service_area_id: serviceAreaId ?? null,
          include_inactive: true,
          include_archived: false,
          payee_type: typeFilter === 'ALL' ? null : typeFilter,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'List payees failed');
      return (data.payees ?? []) as CompanyPayeePublicDto[];
    },
  });

  const schedulesQuery = useQuery({
    queryKey: ['admin-company-payee-schedules', serviceAreaId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_PAYEES_FN, {
        body: { action: 'list_schedules' },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'List schedules failed');
      return (data.schedules ?? []) as ScheduleRow[];
    },
  });

  const createPayee = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_PAYEES_FN, {
        body: {
          action: 'create_payee',
          legal_name: payeeForm.legal_name,
          display_name: payeeForm.display_name,
          payee_type: payeeForm.payee_type,
          email: payeeForm.email || null,
          account_holder_name: payeeForm.account_holder_name,
          bank_name: payeeForm.bank_name || null,
          sort_code: payeeForm.sort_code || null,
          account_number: payeeForm.account_number || null,
          currency: payeeForm.currency,
          country: payeeForm.country,
          default_reference: payeeForm.default_reference || null,
          service_area_id: serviceAreaId ?? null,
          // Configuration only — never require LIVE / never move money on create.
          execute_live: false,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Create payee failed');
      return data;
    },
    onSuccess: (data) => {
      toast.success(
        data.duplicate
          ? 'Matched existing payee (no duplicate)'
          : 'Payee saved — link Revolut when ready',
      );
      setShowPayeeForm(false);
      setPayeeForm(emptyPayeeForm);
      void queryClient.invalidateQueries({ queryKey: ['admin-company-payees'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updatePayee = useMutation({
    mutationFn: async () => {
      if (!editingPayeeId) throw new Error('No payee selected');
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_PAYEES_FN, {
        body: {
          action: 'update_payee',
          payee_id: editingPayeeId,
          legal_name: payeeForm.legal_name,
          display_name: payeeForm.display_name,
          payee_type: payeeForm.payee_type,
          email: payeeForm.email || null,
          country: payeeForm.country || 'GB',
          default_reference: payeeForm.default_reference || null,
          account_holder_name: payeeForm.account_holder_name,
          bank_name: payeeForm.bank_name || null,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Update payee failed');
      return data;
    },
    onSuccess: () => {
      toast.success('Payee updated');
      setEditingPayeeId(null);
      setShowPayeeForm(false);
      setPayeeForm(emptyPayeeForm);
      void queryClient.invalidateQueries({ queryKey: ['admin-company-payees'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const upsertSchedule = useMutation({
    mutationFn: async () => {
      const amount = Math.round(Number(scheduleForm.fixed_amount_pence));
      if (!scheduleForm.payee_id) throw new Error('Select a payee');
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter fixed amount in pence');
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_PAYEES_FN, {
        body: {
          action: 'upsert_schedule',
          payee_id: scheduleForm.payee_id,
          automatic_enabled: scheduleForm.automatic_enabled,
          frequency: scheduleForm.frequency,
          weekly_day: scheduleForm.weekly_day,
          local_processing_time: scheduleForm.local_processing_time,
          timezone: scheduleForm.timezone,
          fixed_amount_pence: amount,
          category: scheduleForm.category,
          approval_required: scheduleForm.approval_required,
          execution_mode: 'DRAFT_FOR_APPROVAL',
          paused: false,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Schedule save failed');
      return data;
    },
    onSuccess: () => {
      toast.success('Automatic payment schedule saved (drafts only — no live /pay)');
      setShowScheduleForm(false);
      void queryClient.invalidateQueries({ queryKey: ['admin-company-payee-schedules'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const payeeById = useMemo(() => {
    const map = new Map<string, CompanyPayeePublicDto>();
    for (const p of payeesQuery.data ?? []) map.set(p.id, p);
    return map;
  }, [payeesQuery.data]);

  const schedulesByPayee = useMemo(() => {
    const map = new Map<string, ScheduleRow>();
    for (const s of schedulesQuery.data ?? []) {
      if (!map.has(s.payee_id)) map.set(s.payee_id, s);
    }
    return map;
  }, [schedulesQuery.data]);

  const filteredPayees = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = payeesQuery.data ?? [];
    if (!q) return rows;
    return rows.filter((p) =>
      p.display_name.toLowerCase().includes(q)
      || p.legal_name.toLowerCase().includes(q)
      || String(p.email ?? '').toLowerCase().includes(q)
      || companyPayeeTypeLabel(p.payee_type).toLowerCase().includes(q)
      || p.masked_account.toLowerCase().includes(q));
  }, [payeesQuery.data, search]);

  function openCreatePayee() {
    setEditingPayeeId(null);
    setPayeeForm(emptyPayeeForm);
    setShowPayeeForm(true);
  }

  function openEditPayee(p: CompanyPayeePublicDto) {
    setEditingPayeeId(p.id);
    setPayeeForm({
      legal_name: p.legal_name,
      display_name: p.display_name,
      payee_type: String(p.payee_type || 'OTHER'),
      email: p.email ?? '',
      account_holder_name: p.account_holder_name ?? '',
      bank_name: p.bank_name ?? '',
      sort_code: '',
      account_number: '',
      currency: p.currency || 'GBP',
      country: p.country || 'GB',
      default_reference: p.default_reference ?? '',
      link_revolut: false,
    });
    setShowPayeeForm(true);
  }

  return (
    <div className="space-y-6">
      {(focus === 'all' || focus === 'payees') && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={openCreatePayee}>
            <Plus className="h-4 w-4 mr-2" /> Add Payee
          </Button>
          {focus === 'all' && (
            <Button size="sm" variant="outline" onClick={() => setShowScheduleForm(true)}>
              Add automatic payment
            </Button>
          )}
        </div>
      )}
      {focus === 'schedules' && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowScheduleForm(true)}>
            Add automatic payment
          </Button>
        </div>
      )}

      {(focus === 'all' || focus === 'payees') && showPayeeForm ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {editingPayeeId ? 'Edit company payee' : 'Add company payee'}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <p className="sm:col-span-2 text-xs text-muted-foreground">
              Company Transfers only — never Driver Wallet or Payment Sessions.
              Bank details are encrypted at rest; after save only the masked account is shown.
              Link Revolut creates the Business counterparty so transfers can be submitted.
            </p>
            <div className="space-y-1">
              <Label>Legal name</Label>
              <Input
                value={payeeForm.legal_name}
                onChange={(e) => setPayeeForm((f) => ({ ...f, legal_name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input
                value={payeeForm.display_name}
                onChange={(e) => setPayeeForm((f) => ({ ...f, display_name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Category</Label>
              <Select
                value={payeeForm.payee_type}
                onValueChange={(v) => setPayeeForm((f) => ({ ...f, payee_type: v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPANY_PAYEE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{companyPayeeTypeLabel(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Account holder</Label>
              <Input
                value={payeeForm.account_holder_name}
                onChange={(e) => setPayeeForm((f) => ({ ...f, account_holder_name: e.target.value }))}
              />
            </div>
            {!editingPayeeId && (
              <>
                <div className="space-y-1">
                  <Label>Sort code</Label>
                  <Input
                    value={payeeForm.sort_code}
                    onChange={(e) => setPayeeForm((f) => ({ ...f, sort_code: e.target.value }))}
                    placeholder="20-00-00"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Account number</Label>
                  <Input
                    value={payeeForm.account_number}
                    onChange={(e) => setPayeeForm((f) => ({ ...f, account_number: e.target.value }))}
                  />
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label>Email</Label>
              <Input
                value={payeeForm.email}
                onChange={(e) => setPayeeForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Default reference</Label>
              <Input
                value={payeeForm.default_reference}
                onChange={(e) => setPayeeForm((f) => ({ ...f, default_reference: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Currency</Label>
              <Input value={payeeForm.currency} disabled />
            </div>
            <div className="space-y-1">
              <Label>Country</Label>
              <Input
                value={payeeForm.country}
                onChange={(e) => setPayeeForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))}
              />
            </div>
            {!editingPayeeId ? (
              <p className="sm:col-span-2 text-xs text-muted-foreground">
                Revolut linking is optional and separate — use <strong>Link Revolut</strong> on the payee
                row after save. Creating a payee never enables live payment execution.
              </p>
            ) : null}
            <div className="sm:col-span-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={createPayee.isPending || updatePayee.isPending}
                onClick={() => (editingPayeeId ? updatePayee.mutate() : createPayee.mutate())}
              >
                {(createPayee.isPending || updatePayee.isPending)
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : (editingPayeeId ? 'Save changes' : 'Save payee')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowPayeeForm(false);
                  setEditingPayeeId(null);
                  setPayeeForm(emptyPayeeForm);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {(focus === 'all' || focus === 'payees') && (
        <Card>
          <CardHeader className="space-y-3">
            <CardTitle className="text-base">Payees</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Input
                className="max-w-xs"
                placeholder="Search payees…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-[220px]"><SelectValue placeholder="Filter category" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All categories</SelectItem>
                  {COMPANY_PAYEE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{companyPayeeTypeLabel(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {payeesQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading payees…
              </div>
            ) : filteredPayees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No company payees yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Payee</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Masked account</TableHead>
                    <TableHead>Currency</TableHead>
                    <TableHead>Verification</TableHead>
                    <TableHead>Created by</TableHead>
                    <TableHead>Automatic payment</TableHead>
                    <TableHead>Next payment</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPayees.map((p) => {
                    const sched = schedulesByPayee.get(p.id);
                    return (
                      <TableRow key={p.id}>
                        <TableCell>
                          <div className="font-medium">{p.display_name}</div>
                          <div className="text-[11px] text-muted-foreground">{p.legal_name}</div>
                        </TableCell>
                        <TableCell className="text-xs">{companyPayeeTypeLabel(p.payee_type)}</TableCell>
                        <TableCell className="font-mono text-xs">{p.masked_account}</TableCell>
                        <TableCell className="text-xs">{p.currency}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{p.account_verification_status}</Badge>
                          {p.verified_at ? (
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              Verified {new Date(p.verified_at).toLocaleDateString()}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs font-mono">
                          {p.created_by ? `${p.created_by.slice(0, 8)}…` : '—'}
                        </TableCell>
                        <TableCell className="text-xs">
                          {sched ? `${sched.frequency}${sched.paused ? ' · PAUSED' : ''}` : '—'}
                        </TableCell>
                        <TableCell className="text-xs">{sched?.next_run_at_local ?? '—'}</TableCell>
                        <TableCell className="text-xs">
                          {p.archived_at ? 'ARCHIVED' : p.paused ? 'PAUSED' : p.active ? 'ACTIVE' : 'INACTIVE'}
                        </TableCell>
                        <TableCell className="space-x-1">
                          <Button size="sm" variant="ghost" onClick={() => openEditPayee(p)}>
                            Edit
                          </Button>
                          {p.account_verification_status !== 'VERIFIED' || !p.revolut_counterparty_id ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={async () => {
                                const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_PAYEES_FN, {
                                  body: { action: 'link_revolut_payee', payee_id: p.id },
                                });
                                if (error || !data?.success) {
                                  toast.error(error?.message ?? data?.error ?? 'Link Revolut failed');
                                  return;
                                }
                                toast.success(
                                  data.already_linked ? 'Already linked' : 'Payee linked to Revolut',
                                );
                                void queryClient.invalidateQueries({ queryKey: ['admin-company-payees'] });
                              }}
                            >
                              Link Revolut
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_PAYEES_FN, {
                                body: { action: 'pause_payee', payee_id: p.id, paused: !p.paused },
                              });
                              if (error || !data?.success) {
                                toast.error(error?.message ?? data?.error ?? 'Pause failed');
                                return;
                              }
                              toast.success(p.paused ? 'Payee resumed' : 'Payee paused');
                              void queryClient.invalidateQueries({ queryKey: ['admin-company-payees'] });
                            }}
                          >
                            {p.paused ? 'Resume' : 'Pause'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_PAYEES_FN, {
                                body: { action: 'archive_payee', payee_id: p.id, archived: true },
                              });
                              if (error || !data?.success) {
                                toast.error(error?.message ?? data?.error ?? 'Archive failed');
                                return;
                              }
                              toast.success('Payee archived');
                              void queryClient.invalidateQueries({ queryKey: ['admin-company-payees'] });
                            }}
                          >
                            Archive
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {(focus === 'all' || focus === 'schedules') && showScheduleForm ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Automatic payment</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2 text-xs text-muted-foreground">
              Next run is computed by the backend schedule SSOT (Europe/London).
              Default execution mode is DRAFT_FOR_APPROVAL. No live transfer on save.
            </div>
            <div className="space-y-1">
              <Label>Payee</Label>
              <Select
                value={scheduleForm.payee_id}
                onValueChange={(v) => setScheduleForm((f) => ({ ...f, payee_id: v }))}
              >
                <SelectTrigger><SelectValue placeholder="Select payee" /></SelectTrigger>
                <SelectContent>
                  {(payeesQuery.data ?? []).filter((p) => p.active && !p.archived_at).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.display_name} · {p.masked_account}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Category</Label>
              <Select
                value={scheduleForm.category}
                onValueChange={(v) => setScheduleForm((f) => ({ ...f, category: v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPANY_TRANSFER_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Frequency</Label>
              <Select
                value={scheduleForm.frequency}
                onValueChange={(v) => setScheduleForm((f) => ({ ...f, frequency: v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'CUSTOM'].map((f) => (
                    <SelectItem key={f} value={f}>{f}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Weekly day</Label>
              <Select
                value={scheduleForm.weekly_day}
                onValueChange={(v) => setScheduleForm((f) => ({ ...f, weekly_day: v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Processing time (local)</Label>
              <Input
                value={scheduleForm.local_processing_time}
                onChange={(e) => setScheduleForm((f) => ({ ...f, local_processing_time: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Fixed amount (pence)</Label>
              <Input
                value={scheduleForm.fixed_amount_pence}
                onChange={(e) => setScheduleForm((f) => ({ ...f, fixed_amount_pence: e.target.value }))}
              />
            </div>
            <div className="sm:col-span-2 flex gap-2">
              <Button size="sm" disabled={upsertSchedule.isPending} onClick={() => upsertSchedule.mutate()}>
                {upsertSchedule.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save schedule'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowScheduleForm(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {(focus === 'all' || focus === 'schedules') && (
        <Card>
          <CardHeader><CardTitle className="text-base">Automatic payments</CardTitle></CardHeader>
          <CardContent>
            {schedulesQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading schedules…
              </div>
            ) : (schedulesQuery.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No automatic payment schedules.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Payee</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Next payment</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(schedulesQuery.data ?? []).map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-xs">
                        {payeeById.get(s.payee_id)?.display_name ?? s.payee_id}
                      </TableCell>
                      <TableCell className="text-xs">
                        {s.frequency}{s.weekly_day ? ` · ${s.weekly_day}` : ''} · {s.local_processing_time}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {formatNullablePence(s.fixed_amount_pence)}
                      </TableCell>
                      <TableCell className="text-xs">{s.next_run_at_local ?? '—'}</TableCell>
                      <TableCell className="text-xs">{s.execution_mode}</TableCell>
                      <TableCell className="text-xs">
                        {s.paused ? 'PAUSED' : s.automatic_enabled ? 'ACTIVE' : 'DISABLED'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
