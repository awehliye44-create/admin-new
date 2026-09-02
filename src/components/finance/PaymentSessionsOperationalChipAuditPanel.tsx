import type { AdminPaymentSessionsSummary } from '../../../shared/adminPaymentSessionsSSOT';
import type { PaymentSessionsOpChip } from '../../../shared/paymentSessionsNavigationSSOT';
import { formatAgeMinutes } from '@/lib/formatNullablePence';

type AuditRow = NonNullable<
  AdminPaymentSessionsSummary['operational_chip_audit']
>['release_pending'][number];

function AuditTable({
  title,
  rows,
}: {
  title: string;
  rows: AuditRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        {title} ({rows.length}) — row IDs counted in chip
      </p>
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-[11px]">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-2">Session</th>
              <th className="p-2">Reason</th>
              <th className="p-2">Provider</th>
              <th className="p-2">Hold</th>
              <th className="p-2">Auth</th>
              <th className="p-2">Cap</th>
              <th className="p-2">Rel</th>
              <th className="p-2">Ref</th>
              <th className="p-2">Trip</th>
              <th className="p-2">Age</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.row_id} className="border-t">
                <td className="p-2 font-mono">{row.payment_session_id?.slice(0, 8) ?? row.row_id.slice(0, 8)}</td>
                <td className="p-2">{row.actionable_reason}</td>
                <td className="p-2">{row.provider_state ?? '—'}</td>
                <td className="p-2">{row.provider_hold_active ? 'yes' : 'no'}</td>
                <td className="p-2 tabular-nums">{row.authorised_amount_pence ?? '—'}</td>
                <td className="p-2 tabular-nums">{row.captured_amount_pence ?? '—'}</td>
                <td className="p-2 tabular-nums">{row.released_amount_pence ?? '—'}</td>
                <td className="p-2 tabular-nums">{row.refunded_amount_pence ?? '—'}</td>
                <td className="p-2">{row.trip_status ?? '—'}</td>
                <td className="p-2">{formatAgeMinutes(row.age_minutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Proves which rows are counted in an operational chip (active queue only). */
export function PaymentSessionsOperationalChipAuditPanel({
  summary,
  opChip,
}: {
  summary: AdminPaymentSessionsSummary | null | undefined;
  opChip: PaymentSessionsOpChip;
}) {
  const audit = summary?.operational_chip_audit;
  if (!audit) return null;

  if (opChip === 'release_pending') {
    return <AuditTable title="Active releases audit" rows={audit.release_pending} />;
  }
  if (opChip === 'recovery_required') {
    return <AuditTable title="Manual recovery audit" rows={audit.recovery_required} />;
  }
  return null;
}
