import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { formatNullablePence } from '@/lib/formatNullablePence';
import {
  DRIVER_FINANCIAL_REPAIR_COPY,
  DRIVER_FINANCIAL_REPAIR_REASON_MIN,
  formatWalletCorrectionResultCopy,
  type DriverFinancialRepairPreview,
} from '../../../shared/driverFinancialReviewRepairSSOT';
import type { DriverWalletSettlementHistoryRow } from '@/hooks/useDriverWalletSsot';

type TripOption = {
  trip_id: string;
  trip_code: string | null;
  label: string;
};

function pickCandidateTrips(
  settlementRows: DriverWalletSettlementHistoryRow[] | null | undefined,
  missingStampTrips?: Array<{ trip_id: string | null; trip_code: string | null }> | null,
): TripOption[] {
  const seen = new Set<string>();
  const out: TripOption[] = [];

  for (const miss of missingStampTrips ?? []) {
    const id = miss.trip_id ? String(miss.trip_id) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      trip_id: id,
      trip_code: miss.trip_code ?? null,
      label: miss.trip_code ? `${miss.trip_code} (missing stamp)` : id,
    });
  }

  for (const row of settlementRows ?? []) {
    const id = row.trip_id ? String(row.trip_id) : '';
    if (!id || seen.has(id)) continue;
    const health = String(row.driver_credit_health ?? '').toUpperCase();
    const settlement = String(row.settlement_status ?? '').toUpperCase();
    const interesting =
      health === 'MISSING'
      || health === 'UNDER_CREDITED'
      || health === 'OVER_CREDITED'
      || health === 'EXPECTED_STAMP_MISSING'
      || settlement === 'MISSING_LEDGER_CREDIT'
      || row.driver_net_pence == null;
    if (!interesting) continue;
    seen.add(id);
    out.push({
      trip_id: id,
      trip_code: row.trip_code ?? null,
      label: row.trip_code
        ? `${row.trip_code} · ${health || settlement || 'review'}`
        : id,
    });
  }

  return out;
}

export function DriverWalletReviewRepairPanel({
  open,
  onOpenChange,
  driverId,
  driverName,
  driverCode,
  currencyCode = 'GBP',
  walletStatus,
  driverCreditStatus,
  settlementRows,
  missingStampTrips,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driverId: string;
  driverName?: string | null;
  driverCode?: string | null;
  currencyCode?: string;
  walletStatus?: string | null;
  driverCreditStatus?: string | null;
  settlementRows?: DriverWalletSettlementHistoryRow[] | null;
  missingStampTrips?: Array<{ trip_id: string | null; trip_code: string | null }> | null;
}) {
  const queryClient = useQueryClient();
  const candidates = useMemo(
    () => pickCandidateTrips(settlementRows, missingStampTrips),
    [settlementRows, missingStampTrips],
  );
  const [tripId, setTripId] = useState<string>('');
  const [preview, setPreview] = useState<DriverFinancialRepairPreview | null>(null);
  const [reason, setReason] = useState('');
  const [resultMessages, setResultMessages] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setReason('');
    setResultMessages([]);
    setTripId(candidates[0]?.trip_id ?? '');
  }, [open, candidates]);

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!tripId) throw new Error('Select an affected trip');
      const { data, error } = await supabase.functions.invoke('admin-driver-financial-repair', {
        body: {
          action: 'preview',
          driver_id: driverId,
          trip_id: tripId,
          wallet_status: walletStatus ?? undefined,
          driver_credit_status: driverCreditStatus ?? undefined,
        },
      });
      if (error) throw error;
      if (data?.error) {
        const err = new Error(String(data.error));
        (err as Error & { code?: string }).code = data.error_code;
        throw err;
      }
      return data as { preview: DriverFinancialRepairPreview };
    },
    onSuccess: (data) => {
      setPreview(data.preview);
      if (!data.preview.apply_allowed) {
        toast.message('Repair blocked', {
          description: data.preview.block_reason ?? data.preview.block_code ?? 'See panel',
        });
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to preview repair');
    },
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error('Preview required');
      const { data, error } = await supabase.functions.invoke('admin-driver-financial-repair', {
        body: {
          action: 'apply',
          driver_id: driverId,
          trip_id: tripId,
          repair_token: preview.repair_token,
          preview_hash: preview.preview_hash,
          reason: reason.trim(),
        },
      });
      if (error) throw error;
      if (data?.error) {
        const err = new Error(String(data.error));
        (err as Error & { code?: string }).code = data.error_code;
        throw err;
      }
      return data as {
        result?: { messages?: string[]; correction_pence?: number; freeze_cleared_derived?: boolean };
        copy?: { evidence_only?: string | null; wallet_correction?: string | null; freeze?: string | null };
      };
    },
    onSuccess: (data) => {
      const messages = [
        ...(data.copy?.evidence_only ? [data.copy.evidence_only] : []),
        ...(data.copy?.wallet_correction ? [data.copy.wallet_correction] : []),
        ...(data.copy?.freeze ? [data.copy.freeze] : []),
        ...((data.result?.messages ?? []) as string[]),
      ].filter(Boolean);
      const unique = [...new Set(messages)];
      setResultMessages(unique.length ? unique : ['Repair applied']);
      toast.success('Review & repair applied');
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot'] });
      void queryClient.invalidateQueries({ queryKey: ['driver-wallet-ssot-detail', driverId] });
      void queryClient.invalidateQueries({ queryKey: ['finance-ledger-transactions'] });
    },
    onError: (error: Error & { code?: string }) => {
      toast.error(error.message || 'Failed to apply repair');
    },
  });

  const canApply = Boolean(
    preview?.apply_allowed
    && reason.trim().length >= DRIVER_FINANCIAL_REPAIR_REASON_MIN
    && !applyMutation.isPending,
  );

  const who = driverName?.trim() || driverCode?.trim() || driverId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{DRIVER_FINANCIAL_REPAIR_COPY.BUTTON}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <Alert>
            <AlertTitle>Before you apply</AlertTitle>
            <AlertDescription>{DRIVER_FINANCIAL_REPAIR_COPY.CONFIRMATION}</AlertDescription>
          </Alert>

          <div className="text-sm space-y-1">
            <p>
              <span className="text-muted-foreground">Driver:</span> {who}
              {driverCode ? ` (${driverCode})` : ''}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="repair-trip">Affected trip</Label>
            {candidates.length > 0 ? (
              <Select value={tripId} onValueChange={(v) => { setTripId(v); setPreview(null); }}>
                <SelectTrigger id="repair-trip">
                  <SelectValue placeholder="Select trip" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.trip_id} value={c.trip_id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">
                No candidate trips on this wallet view. Open a trip with EXPECTED_STAMP_MISSING /
                credit mismatch from Financial Reconciliation, or paste a trip context after
                refreshing settlement history.
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!tripId || previewMutation.isPending}
              onClick={() => previewMutation.mutate()}
            >
              {previewMutation.isPending ? 'Loading preview…' : 'Load repair preview'}
            </Button>
          </div>

          {preview ? (
            <div className="space-y-3 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{preview.classification}</Badge>
                {preview.apply_allowed ? (
                  <Badge>Apply allowed</Badge>
                ) : (
                  <Badge variant="destructive">{preview.block_code ?? 'Blocked'}</Badge>
                )}
              </div>

              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Payment session</dt>
                  <dd className="font-mono text-xs break-all">{preview.payment_session_id ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Provider order / payment</dt>
                  <dd className="font-mono text-xs break-all">
                    {preview.provider_order_id ?? '—'} / {preview.provider_payment_id ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Provider state</dt>
                  <dd>{preview.provider_state ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Captured amount</dt>
                  <dd>{formatNullablePence(preview.captured_amount_pence, currencyCode)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Final fare</dt>
                  <dd>{formatNullablePence(preview.final_fare_pence, currencyCode)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Commission basis / rate</dt>
                  <dd>
                    {formatNullablePence(preview.commission_basis_pence, currencyCode)}
                    {' · '}
                    {preview.commission_rate_percent == null ? '—' : `${preview.commission_rate_percent}%`}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Expected entitlement</dt>
                  <dd>{formatNullablePence(preview.expected_driver_entitlement_pence, currencyCode)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Existing stamps (net / tip)</dt>
                  <dd>
                    {formatNullablePence(preview.existing_trip_stamps.driver_net_pence, currencyCode)}
                    {' / '}
                    {formatNullablePence(preview.existing_trip_stamps.tip_pence, currencyCode)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Actual TEN / tip credits</dt>
                  <dd>
                    {formatNullablePence(preview.actual_ten_credit_pence, currencyCode)}
                    {' / '}
                    {formatNullablePence(preview.actual_tip_credit_pence, currencyCode)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Exact variance</dt>
                  <dd>{formatNullablePence(preview.variance_pence, currencyCode)}</dd>
                </div>
              </dl>

              {preview.missing_evidence_fields.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Missing evidence: {preview.missing_evidence_fields.join(', ')}
                </p>
              ) : null}

              <div className="space-y-1 text-xs">
                <p>
                  Proposed:{' '}
                  {preview.proposed_repair.restore_expected_stamp
                    ? 'Restore expected stamp (server-calculated)'
                    : 'No stamp restore'}
                  {preview.proposed_repair.canonical_ten_restoration_pence > 0
                    ? ` · TEN restore ${formatNullablePence(preview.proposed_repair.canonical_ten_restoration_pence, currencyCode)}`
                    : ''}
                  {preview.proposed_repair.append_wallet_correction_pence !== 0
                    ? ` · residual ${formatNullablePence(preview.proposed_repair.append_wallet_correction_pence, currencyCode)} correction`
                    : ' · no residual wallet correction'}
                </p>
                <p>
                  Proven wallet delta:{' '}
                  {formatNullablePence(preview.proposed_repair.proven_wallet_delta_pence, currencyCode)}
                </p>
                <p>
                  Wallet money changes:{' '}
                  {preview.proposed_repair.wallet_money_changes ? 'Yes' : 'No'}
                </p>
                <p>
                  Freeze should clear after recompute:{' '}
                  {preview.proposed_repair.freeze_should_clear_after_recompute ? 'Yes' : 'No'}
                </p>
                {preview.proposed_repair.proposed_stamp ? (
                  <p className="font-mono">
                    Server stamp net={preview.proposed_repair.proposed_stamp.driver_net_pence}p
                    commission={preview.proposed_repair.proposed_stamp.commission_pence}p
                    tip={preview.proposed_repair.proposed_stamp.tip_pence}p
                  </p>
                ) : null}
              </div>

              {preview.block_reason ? (
                <Alert variant="destructive">
                  <AlertDescription>{preview.block_reason}</AlertDescription>
                </Alert>
              ) : null}

              {preview.apply_allowed ? (
                <div className="space-y-2">
                  <Label htmlFor="repair-reason">Admin reason (3–500 characters)</Label>
                  <Textarea
                    id="repair-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    maxLength={500}
                    placeholder="Why this repair is approved…"
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {resultMessages.length > 0 ? (
            <Alert>
              <AlertTitle>Result</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4 space-y-1">
                  {resultMessages.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canApply}
            onClick={() => applyMutation.mutate()}
          >
            {applyMutation.isPending ? 'Applying…' : 'Approve repair'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Helper for unit tests / copy assertions. */
export function reviewRepairWalletCorrectionCopy(pence: number): string {
  return formatWalletCorrectionResultCopy(pence);
}
