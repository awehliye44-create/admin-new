import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronDown, RefreshCw, Banknote, Undo2, Pencil, ShieldCheck, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useAuth } from '@/hooks/useAuth';

interface PaymentState {
  trip_id: string;
  payment_intent_id: string | null;
  payment_method: string | null;
  payment_status: string | null;
  authorized_pence: number;
  captured_pence: number;
  refunded_pence: number;
  net_captured_pence: number;
  amount_capturable_pence: number | null;
  stripe_status: string | null;
  stripe_currency: string | null;
  final_fare_pence: number;
}

interface AuditEntry {
  id: string;
  action: 'capture' | 'refund' | 'edit_fare';
  reason: string;
  amount_pence_before: number | null;
  amount_pence_after: number | null;
  delta_pence: number | null;
  stripe_payment_intent_id: string | null;
  stripe_refund_id: string | null;
  admin_user_id: string;
  created_at: string;
}

const formatPence = (pence: number, currency = 'GBP') => {
  const code = currency || 'GBP';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format((pence || 0) / 100);
  } catch {
    return `${(pence / 100).toFixed(2)} ${code}`;
  }
};

type Mode = 'capture' | 'refund' | 'edit';

export function PaymentControlsCard({ tripId }: { tripId: string }) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode | null>(null);
  const [amountInput, setAmountInput] = useState<string>('');
  const [reason, setReason] = useState('');
  const [auditOpen, setAuditOpen] = useState(false);

  const stateQuery = useQuery<PaymentState>({
    queryKey: ['admin-payment-state', tripId],
    enabled: !!tripId && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('admin-get-trip-payment-state', {
        body: { trip_id: tripId },
      });
      if (error) throw new Error(data?.error || error.message);
      return data as PaymentState;
    },
  });

  const auditQuery = useQuery<AuditEntry[]>({
    queryKey: ['admin-payment-audit', tripId],
    enabled: !!tripId && isAdmin && auditOpen,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('admin_payment_audit')
        .select('*')
        .eq('trip_id', tripId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as AuditEntry[];
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-payment-state', tripId] });
    queryClient.invalidateQueries({ queryKey: ['admin-payment-audit', tripId] });
    queryClient.invalidateQueries({ queryKey: ['admin-payment-detail', tripId] });
    queryClient.invalidateQueries({ queryKey: ['admin-payments-list'] });
    queryClient.invalidateQueries({ queryKey: ['admin-payments-summary'] });
  };

  const actionMutation = useMutation({
    mutationFn: async (input: { mode: Mode; amount_pence?: number; new_total_pence?: number; reason: string }) => {
      const fn =
        input.mode === 'capture' ? 'admin-capture-trip-payment'
        : input.mode === 'refund' ? 'admin-refund-trip-payment'
        : 'admin-edit-trip-fare';
      const body: Record<string, unknown> = { trip_id: tripId, reason: input.reason };
      if (input.mode === 'edit') body.new_total_pence = input.new_total_pence;
      else if (input.amount_pence !== undefined) body.amount_pence = input.amount_pence;
      const { data, error } = await supabase.functions.invoke(fn, { body });
      if (error) throw new Error(data?.error || error.message);
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      const id = data.stripe_refund_id || data.stripe_charge_id || data.stripe_payment_intent_id;
      toast.success(data.message || 'Action completed', {
        description: id ? `Stripe ref: ${id}` : undefined,
      });
      setMode(null);
      setReason('');
      setAmountInput('');
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!isAdmin) return null;

  const state = stateQuery.data;
  const currency = state?.stripe_currency || 'GBP';
  const isUncaptured = state?.stripe_status === 'requires_capture';
  const hasCharge = !!state && state.captured_pence > 0;
  const refundable = state ? Math.max(0, state.captured_pence - state.refunded_pence) : 0;

  const openMode = (m: Mode) => {
    setMode(m);
    setReason('');
    if (!state) { setAmountInput(''); return; }
    if (m === 'capture') setAmountInput(((state.amount_capturable_pence ?? state.authorized_pence) / 100).toFixed(2));
    else if (m === 'refund') setAmountInput((refundable / 100).toFixed(2));
    else setAmountInput((state.final_fare_pence / 100).toFixed(2));
  };

  const submit = () => {
    const value = Number(amountInput);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter a valid amount greater than 0');
      return;
    }
    if (reason.trim().length < 5) {
      toast.error('Reason must be at least 5 characters');
      return;
    }
    const pence = Math.round(value * 100);
    if (mode === 'edit') actionMutation.mutate({ mode, new_total_pence: pence, reason: reason.trim() });
    else if (mode) actionMutation.mutate({ mode, amount_pence: pence, reason: reason.trim() });
  };

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Admin Payment Controls
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => stateQuery.refetch()} disabled={stateQuery.isFetching}>
            <RefreshCw className={`h-4 w-4 ${stateQuery.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {stateQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : stateQuery.error ? (
          <div className="text-sm text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {(stateQuery.error as Error).message}
          </div>
        ) : state ? (
          <>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">Authorized</div>
                <div className="font-semibold">{formatPence(state.authorized_pence, currency)}</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">Captured</div>
                <div className="font-semibold">{formatPence(state.captured_pence, currency)}</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">Refunded</div>
                <div className="font-semibold">{formatPence(state.refunded_pence, currency)}</div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline">PI: {state.stripe_status || state.payment_status || '—'}</Badge>
              {state.payment_intent_id && (
                <code className="bg-muted px-2 py-0.5 rounded">{state.payment_intent_id}</code>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {isUncaptured && (
                <Button size="sm" onClick={() => openMode('capture')}>
                  <Banknote className="h-4 w-4 mr-1" /> Capture
                </Button>
              )}
              {hasCharge && refundable > 0 && (
                <Button size="sm" variant="outline" onClick={() => openMode('refund')}>
                  <Undo2 className="h-4 w-4 mr-1" /> Refund
                </Button>
              )}
              {(isUncaptured || hasCharge) && (
                <Button size="sm" variant="outline" onClick={() => openMode('edit')}>
                  <Pencil className="h-4 w-4 mr-1" /> Edit Fare
                </Button>
              )}
              {!isUncaptured && !hasCharge && (
                <p className="text-xs text-muted-foreground">No PaymentIntent actions available for this trip.</p>
              )}
            </div>

            <Collapsible open={auditOpen} onOpenChange={setAuditOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-between">
                  <span className="text-sm">Audit log</span>
                  <ChevronDown className={`h-4 w-4 transition-transform ${auditOpen ? 'rotate-180' : ''}`} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                {auditQuery.isLoading ? (
                  <Skeleton className="h-12 w-full" />
                ) : !auditQuery.data || auditQuery.data.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">No admin actions recorded.</p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {auditQuery.data.map((e) => (
                      <div key={e.id} className="rounded-md border p-2 text-xs space-y-1">
                        <div className="flex items-center justify-between">
                          <Badge variant="secondary" className="capitalize">{e.action.replace('_', ' ')}</Badge>
                          <span className="text-muted-foreground">{format(new Date(e.created_at), 'dd MMM yyyy HH:mm')}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Before → After</span>
                          <span>{formatPence(e.amount_pence_before ?? 0, currency)} → {formatPence(e.amount_pence_after ?? 0, currency)}</span>
                        </div>
                        {e.delta_pence !== null && (
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">Delta</span>
                            <span>{formatPence(e.delta_pence, currency)}</span>
                          </div>
                        )}
                        <div><span className="text-muted-foreground">Reason: </span>{e.reason}</div>
                        {e.stripe_refund_id && <div className="text-muted-foreground break-all">Refund: {e.stripe_refund_id}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          </>
        ) : null}
      </CardContent>

      <Dialog open={!!mode} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode === 'capture' && 'Capture payment'}
              {mode === 'refund' && 'Refund payment'}
              {mode === 'edit' && 'Edit trip fare'}
            </DialogTitle>
            <DialogDescription>
              {mode === 'capture' && 'Capture an authorized PaymentIntent (full or partial).'}
              {mode === 'refund' && 'Refund a captured charge (full or partial).'}
              {mode === 'edit' && 'Sets the trip fare. Captures or refunds the difference automatically.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{mode === 'edit' ? 'New total' : 'Amount'} ({currency})</Label>
              <Input
                type="number" step="0.01" min="0.01"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
              />
            </div>
            <div>
              <Label>Reason (required, min 5 chars)</Label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMode(null)} disabled={actionMutation.isPending}>Cancel</Button>
            <Button onClick={submit} disabled={actionMutation.isPending}>
              {actionMutation.isPending && <RefreshCw className="h-4 w-4 mr-2 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
