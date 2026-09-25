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
import { useDriverFinancialRepairHistory } from '@/hooks/useDriverFinancialRepairHistory';
import {
  DRIVER_FINANCIAL_REPAIR_ACTION,
  DRIVER_FINANCIAL_REPAIR_BLOCK,
  DRIVER_FINANCIAL_REPAIR_COPY,
  DRIVER_FINANCIAL_REPAIR_REASON_MIN,
  DRIVER_FINANCIAL_REPAIR_UI_STATUS,
  WALLET_CORRECTION_APPEND_CERTIFIED,
  formatWalletCorrectionResultCopy,
  resolveDriverFinancialRepairUiStatus,
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
  initialTrip?: { trip_id: string; trip_code?: string | null } | null,
): TripOption[] {
  const seen = new Set<string>();
  const out: TripOption[] = [];

  if (initialTrip?.trip_id) {
    const id = String(initialTrip.trip_id);
    seen.add(id);
    out.push({
      trip_id: id,
      trip_code: initialTrip.trip_code ?? null,
      label: initialTrip.trip_code
        ? `${initialTrip.trip_code} (from Financial Reconciliation)`
        : `${id} (from Financial Reconciliation)`,
    });
  }

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

function formatTs(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
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
  initialTripId = null,
  initialTripCode = null,
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
  /** Prefill from FR Issues deep-link — never auto-Preview. */
  initialTripId?: string | null;
  initialTripCode?: string | null;
}) {
  const queryClient = useQueryClient();
  const candidates = useMemo(
    () =>
      pickCandidateTrips(
        settlementRows,
        missingStampTrips,
        initialTripId
          ? { trip_id: initialTripId, trip_code: initialTripCode }
          : null,
      ),
    [settlementRows, missingStampTrips, initialTripId, initialTripCode],
  );
  const [tripId, setTripId] = useState<string>('');
  const [preview, setPreview] = useState<DriverFinancialRepairPreview | null>(null);
  const [reason, setReason] = useState('');
  const [resultMessages, setResultMessages] = useState<string[]>([]);

  const historyQuery = useDriverFinancialRepairHistory(driverId, open);

  useEffect(() => {
    if (!open) return;
    // Opening the panel must never Preview or mutate — reset only.
    setPreview(null);
    setReason('');
    setResultMessages([]);
    const preferred = initialTripId && candidates.some((c) => c.trip_id === initialTripId)
      ? initialTripId
      : (candidates[0]?.trip_id ?? '');
    setTripId(preferred);
  }, [open, candidates, initialTripId]);

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
      if (
        preview.classification === DRIVER_FINANCIAL_REPAIR_ACTION.APPEND_WALLET_CORRECTION
        && !WALLET_CORRECTION_APPEND_CERTIFIED
      ) {
        const err = new Error(DRIVER_FINANCIAL_REPAIR_COPY.WALLET_CORRECTION_NOT_CERTIFIED);
        (err as Error & { code?: string }).code =
          DRIVER_FINANCIAL_REPAIR_BLOCK.WALLET_CORRECTION_NOT_CERTIFIED;
        throw err;
      }
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
      void queryClient.invalidateQueries({ queryKey: ['driver-financial-repair-history', driverId] });
    },
    onError: (error: Error & { code?: string }) => {
      toast.error(error.message || 'Failed to apply repair');
    },
  });

  const uiStatus = resolveDriverFinancialRepairUiStatus({ preview });
  const walletCorrectionBlocked =
    uiStatus === DRIVER_FINANCIAL_REPAIR_UI_STATUS.WALLET_CORRECTION_NOT_CERTIFIED
    || (
      preview?.classification === DRIVER_FINANCIAL_REPAIR_ACTION.APPEND_WALLET_CORRECTION
      && !WALLET_CORRECTION_APPEND_CERTIFIED
    );

  const canApply = Boolean(
    preview?.apply_allowed
    && !walletCorrectionBlocked
    && reason.trim().length >= DRIVER_FINANCIAL_REPAIR_REASON_MIN
    && !applyMutation.isPending,
  );

  const who = driverName?.trim() || driverCode?.trim() || driverId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[720px] max-h-[90vh] overflow-y-auto"
        data-testid="driver-wallet-review-repair-panel"
      >
        <DialogHeader>
          <DialogTitle>{DRIVER_FINANCIAL_REPAIR_COPY.BUTTON}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <Alert>
            <AlertTitle>Before you apply</AlertTitle>
            <AlertDescription>{DRIVER_FINANCIAL_REPAIR_COPY.CONFIRMATION}</AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Status:</span>
            <Badge
              variant={uiStatus === DRIVER_FINANCIAL_REPAIR_UI_STATUS.SAFE_TO_APPLY ? 'default' : 'outline'}
              data-testid="review-repair-ui-status"
            >
              {uiStatus}
            </Badge>
          </div>

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
                <SelectTrigger id="repair-trip" data-testid="review-repair-trip-select">
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
              data-testid="review-repair-preview-button"
              onClick={() => previewMutation.mutate()}
            >
              {previewMutation.isPending ? 'Loading preview…' : 'Load repair preview'}
            </Button>
          </div>

          {preview ? (
            <div className="space-y-3 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{preview.classification}</Badge>
                {preview.apply_allowed && !walletCorrectionBlocked ? (
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
                    {preview.commission_rate_percent == null
                      ? (preview.classification === DRIVER_FINANCIAL_REPAIR_ACTION.CERTIFICATION_NON_PAYABLE
                        ? 'N/A (does not apply)'
                        : '—')
                      : `${preview.commission_rate_percent}%`}
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
                {preview.classification === DRIVER_FINANCIAL_REPAIR_ACTION.CERTIFICATION_NON_PAYABLE ? (
                  <>
                    <div>
                      <dt className="text-muted-foreground">Wallet change</dt>
                      <dd>£0.00</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Provider / payout</dt>
                      <dd>none / none</dd>
                    </div>
                  </>
                ) : null}
              </dl>

              {preview.classification === DRIVER_FINANCIAL_REPAIR_ACTION.CERTIFICATION_NON_PAYABLE
                && preview.certification_evidence ? (
                <Alert data-testid="review-repair-certification-evidence">
                  <AlertTitle>{DRIVER_FINANCIAL_REPAIR_COPY.CERTIFICATION_NON_PAYABLE_ACTION}</AlertTitle>
                  <AlertDescription className="space-y-1 text-xs">
                    <p>
                      Passenger: {String(preview.certification_evidence.passenger_name ?? '—')}
                      {' · '}
                      {String(preview.certification_evidence.pickup_address ?? '—')}
                      {' → '}
                      {String(preview.certification_evidence.dropoff_address ?? '—')}
                    </p>
                    <p className="font-mono break-all">
                      client_action_id: {String(preview.certification_evidence.client_action_id ?? '—')}
                    </p>
                    <p className="font-mono break-all">
                      Incorrect linked session:{' '}
                      {String(preview.certification_evidence.incorrect_linked_session_id ?? '—')}
                      {' · real owner '}
                      {String(
                        preview.certification_evidence.linked_session_real_owner_trip_code
                          ?? preview.clear_stale_payment_session_owner_trip_code
                          ?? '—',
                      )}
                    </p>
                    <p>Expected entitlement £0.00 · Wallet change £0.00</p>
                    <p className="font-medium">
                      {DRIVER_FINANCIAL_REPAIR_COPY.CERTIFICATION_NO_PROVIDER_CHANGE}
                    </p>
                  </AlertDescription>
                </Alert>
              ) : null}

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

              {walletCorrectionBlocked ? (
                <Alert variant="destructive" data-testid="review-repair-wallet-correction-block">
                  <AlertTitle>{DRIVER_FINANCIAL_REPAIR_UI_STATUS.WALLET_CORRECTION_NOT_CERTIFIED}</AlertTitle>
                  <AlertDescription>
                    {DRIVER_FINANCIAL_REPAIR_COPY.WALLET_CORRECTION_NOT_CERTIFIED}
                  </AlertDescription>
                </Alert>
              ) : preview.block_reason ? (
                <Alert variant="destructive">
                  <AlertDescription>{preview.block_reason}</AlertDescription>
                </Alert>
              ) : null}

              {preview.apply_allowed && !walletCorrectionBlocked ? (
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

          <section
            className="space-y-2 rounded-md border p-3"
            data-testid="review-repair-history"
            aria-label={DRIVER_FINANCIAL_REPAIR_COPY.HISTORY_SECTION}
          >
            <h3 className="text-sm font-medium">{DRIVER_FINANCIAL_REPAIR_COPY.HISTORY_SECTION}</h3>
            <p className="text-xs text-muted-foreground">
              Read-only Finance audit — no mutations from this panel.
            </p>
            {historyQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading history…</p>
            ) : historyQuery.isError ? (
              <p className="text-xs text-destructive">Unable to load repair history.</p>
            ) : (historyQuery.data?.length ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">No repair requests for this driver yet.</p>
            ) : (
              <ul className="space-y-3">
                {(historyQuery.data ?? []).map((row) => (
                  <li key={row.id} className="rounded border bg-muted/20 p-2 text-xs space-y-1">
                    <div className="flex flex-wrap gap-2 items-center">
                      <Badge variant="outline">{row.classification}</Badge>
                      <Badge variant={row.status === 'APPLIED' ? 'default' : 'secondary'}>{row.status}</Badge>
                    </div>
                    <p>
                      <span className="text-muted-foreground">Created:</span> {formatTs(row.created_at)}
                      {row.applied_at ? (
                        <>
                          {' · '}
                          <span className="text-muted-foreground">Applied:</span> {formatTs(row.applied_at)}
                        </>
                      ) : null}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Trip:</span>{' '}
                      {row.trip_code ?? row.trip_id.slice(0, 8)}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Admin:</span> {row.admin_actor}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Reason:</span> {row.reason ?? '—'}
                    </p>
                    <p className="font-mono break-all">
                      <span className="text-muted-foreground font-sans">Preview hash:</span>{' '}
                      {row.preview_hash}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Wallet delta:</span>{' '}
                      {formatNullablePence(row.wallet_delta_pence, currencyCode)}
                    </p>
                    <p>
                      <span className="text-muted-foreground">Audit sequence:</span>{' '}
                      {row.audit_sequence.length ? row.audit_sequence.join(' → ') : '—'}
                    </p>
                    {row.failure_or_block_reason ? (
                      <p className="text-destructive">
                        <span className="text-muted-foreground">Block/failure:</span>{' '}
                        {row.failure_or_block_reason}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canApply}
            data-testid="review-repair-apply-button"
            onClick={() => applyMutation.mutate()}
          >
            {applyMutation.isPending
              ? 'Applying…'
              : preview?.classification === DRIVER_FINANCIAL_REPAIR_ACTION.CERTIFICATION_NON_PAYABLE
                ? DRIVER_FINANCIAL_REPAIR_COPY.CERTIFICATION_NON_PAYABLE_ACTION
                : 'Approve repair'}
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

/** Opening the panel never auto-previews (lock). */
export function reviewRepairPanelAutoPreviewOnOpen(): false {
  return false;
}
