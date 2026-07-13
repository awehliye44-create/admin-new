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

export function CompanyTransfersPayeesSection({
  serviceAreaId,
  focus = 'all',
}: {
  serviceAreaId?: string | null;
  focus?: 'all' | 'payees' | 'schedules';
}) {
  const queryClient = useQueryClient();
  const [showPayeeForm, setShowPayeeForm] = useState(false);
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [payeeForm, setPayeeForm] = useState({
    legal_name: '',
    display_name: '',
    payee_type: 'STAFF',
    email: '',
    account_holder_name: '',
    bank_name: '',
    sort_code: '',
    account_number: '',
    currency: 'GBP',
    default_reference: '',
  });
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
    queryKey: ['admin-company-payees', serviceAreaId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke(ADMIN_COMPANY_PAYEES_FN, {
        body: { action: 'list_payees', service_area_id: serviceAreaId ?? null },
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
          ...payeeForm,
          email: payeeForm.email || null,
          bank_name: payeeForm.bank_name || null,
          default_reference: payeeForm.default_reference || null,
          service_area_id: serviceAreaId ?? null,
          execute_live: false,
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? 'Create payee failed');
      return data;
    },
    onSuccess: (data) => {
      toast.success(data.duplicate ? 'Matched existing payee (no duplicate)' : 'Payee saved (masked account only)');
      setShowPayeeForm(false);
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
      toast.success('Automatic payment schedule saved (backend next_run only)');
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

  return (
    <div className="space-y-6">
      {(focus === 'all' || focus === 'payees') && (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled title="Read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">
          <Plus className="h-4 w-4 mr-2" /> Add payee (disabled)
        </Button>
        {(focus === 'all' || focus === 'schedules') && (
        <Button size="sm" variant="outline" disabled title="Read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">
          Add automatic payment (disabled)
        </Button>
        )}
      </div>
      )}
      {focus === 'schedules' && (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled title="Read-only while LIVE_PAYOUT_EXECUTION_ENABLED=false">
          Add automatic payment (disabled)
        </Button>
      </div>
      )}

      {false && (focus === 'all' || focus === 'payees') && showPayeeForm ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Add company payee</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <p className="sm:col-span-2 text-xs text-muted-foreground">
              Bank details are encrypted at rest. After save only masked account is shown (•••• 1234).
              Revolut counterparty creation stays off until Business credentials + execute_live.
            </p>
            <div className="space-y-1"><Label>Legal name</Label><Input value={payeeForm.legal_name} onChange={(e) => setPayeeForm((f) => ({ ...f, legal_name: e.target.value }))} /></div>
            <div className="space-y-1"><Label>Display name</Label><Input value={payeeForm.display_name} onChange={(e) => setPayeeForm((f) => ({ ...f, display_name: e.target.value }))} /></div>
            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={payeeForm.payee_type} onValueChange={(v) => setPayeeForm((f) => ({ ...f, payee_type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{COMPANY_PAYEE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label>Account holder</Label><Input value={payeeForm.account_holder_name} onChange={(e) => setPayeeForm((f) => ({ ...f, account_holder_name: e.target.value }))} /></div>
            <div className="space-y-1"><Label>Sort code</Label><Input value={payeeForm.sort_code} onChange={(e) => setPayeeForm((f) => ({ ...f, sort_code: e.target.value }))} placeholder="20-00-00" /></div>
            <div className="space-y-1"><Label>Account number</Label><Input value={payeeForm.account_number} onChange={(e) => setPayeeForm((f) => ({ ...f, account_number: e.target.value }))} /></div>
            <div className="space-y-1"><Label>Email</Label><Input value={payeeForm.email} onChange={(e) => setPayeeForm((f) => ({ ...f, email: e.target.value }))} /></div>
            <div className="space-y-1"><Label>Default reference</Label><Input value={payeeForm.default_reference} onChange={(e) => setPayeeForm((f) => ({ ...f, default_reference: e.target.value }))} /></div>
            <div className="sm:col-span-2">
              <Button size="sm" disabled={createPayee.isPending} onClick={() => createPayee.mutate()}>
                {createPayee.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save payee'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {(focus === 'all' || focus === 'payees') && (
      <Card>
        <CardHeader><CardTitle className="text-base">Payees</CardTitle></CardHeader>
        <CardContent>
          {payeesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading payees…</div>
          ) : (payeesQuery.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No company payees yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payee</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Masked account</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead>Automatic payment</TableHead>
                  <TableHead>Next payment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(payeesQuery.data ?? []).map((p) => {
                  const sched = schedulesByPayee.get(p.id);
                  return (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="font-medium">{p.display_name}</div>
                      <div className="text-[11px] text-muted-foreground">{p.legal_name}</div>
                    </TableCell>
                    <TableCell className="text-xs">{p.payee_type}</TableCell>
                    <TableCell className="font-mono text-xs">{p.masked_account}</TableCell>
                    <TableCell className="text-xs">{p.currency}</TableCell>
                    <TableCell><Badge variant="outline">{p.account_verification_status}</Badge></TableCell>
                    <TableCell className="text-xs">{sched ? `${sched.frequency}${sched.paused ? ' · PAUSED' : ''}` : '—'}</TableCell>
                    <TableCell className="text-xs">{sched?.next_run_at_local ?? '—'}</TableCell>
                    <TableCell className="text-xs">{p.paused ? 'PAUSED' : p.active ? 'ACTIVE' : 'INACTIVE'}</TableCell>
                    <TableCell>
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

      {(focus === 'all' || focus === 'schedules') && false && showScheduleForm ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Automatic payment</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2 text-xs text-muted-foreground">
              Next run is computed by the backend schedule SSOT (Europe/London). Default execution mode is DRAFT_FOR_APPROVAL. No live transfer on save.
            </div>
            <div className="space-y-1">
              <Label>Payee</Label>
              <Select value={scheduleForm.payee_id} onValueChange={(v) => setScheduleForm((f) => ({ ...f, payee_id: v }))}>
                <SelectTrigger><SelectValue placeholder="Select payee" /></SelectTrigger>
                <SelectContent>
                  {(payeesQuery.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.display_name} · {p.masked_account}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Category</Label>
              <Select value={scheduleForm.category} onValueChange={(v) => setScheduleForm((f) => ({ ...f, category: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPANY_TRANSFER_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Frequency</Label>
              <Select value={scheduleForm.frequency} onValueChange={(v) => setScheduleForm((f) => ({ ...f, frequency: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'CUSTOM'].map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Weekly day</Label>
              <Select value={scheduleForm.weekly_day} onValueChange={(v) => setScheduleForm((f) => ({ ...f, weekly_day: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Processing time (local)</Label>
              <Input value={scheduleForm.local_processing_time} onChange={(e) => setScheduleForm((f) => ({ ...f, local_processing_time: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Fixed amount (pence)</Label>
              <Input value={scheduleForm.fixed_amount_pence} onChange={(e) => setScheduleForm((f) => ({ ...f, fixed_amount_pence: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <Button size="sm" disabled={upsertSchedule.isPending} onClick={() => upsertSchedule.mutate()}>
                {upsertSchedule.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save schedule'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {(focus === 'all' || focus === 'schedules') && (
      <Card>
        <CardHeader><CardTitle className="text-base">Automatic payments</CardTitle></CardHeader>
        <CardContent>
          {schedulesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading schedules…</div>
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
                    <TableCell className="text-xs">{payeeById.get(s.payee_id)?.display_name ?? s.payee_id}</TableCell>
                    <TableCell className="text-xs">{s.frequency}{s.weekly_day ? ` · ${s.weekly_day}` : ''} · {s.local_processing_time}</TableCell>
                    <TableCell className="text-xs tabular-nums">{formatNullablePence(s.fixed_amount_pence)}</TableCell>
                    <TableCell className="text-xs">{s.next_run_at_local ?? '—'}</TableCell>
                    <TableCell className="text-xs">{s.execution_mode}</TableCell>
                    <TableCell className="text-xs">{s.paused ? 'PAUSED' : s.automatic_enabled ? 'ACTIVE' : 'DISABLED'}</TableCell>
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
