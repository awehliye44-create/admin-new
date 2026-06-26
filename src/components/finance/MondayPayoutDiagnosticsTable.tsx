import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatPayoutDisplayStatus } from "@/lib/payoutStatusLabels";
import { formatPence } from "@/hooks/useDriverWallet";
import {
  PARTIAL_SETTLEMENT_MESSAGE,
  canRetryMondayPayoutItem,
  type MondayPayoutDiagnosticsRow,
} from "@/hooks/useMondayPayoutDiagnostics";
import { format } from "date-fns";
import { AlertTriangle, RefreshCw } from "lucide-react";

function statusBadge(row: MondayPayoutDiagnosticsRow) {
  if (row.payout_policy_violation) {
    return (
      <Badge variant="destructive" title={row.payout_policy_violation_detail ?? undefined}>
        POLICY VIOLATION
      </Badge>
    );
  }
  if (row.settlement_status === "PARTIAL_SETTLEMENT") {
    return <Badge variant="outline" className="border-amber-500 text-amber-700">PARTIAL_SETTLEMENT</Badge>;
  }
  if (row.payout_status === "failed" || row.payout_status === "ledger_sync_failed") {
    return <Badge variant="destructive">{formatPayoutDisplayStatus("failed")}</Badge>;
  }
  if (row.payout_status === "completed") {
    return <Badge variant="default">{formatPayoutDisplayStatus("paid")}</Badge>;
  }
  return <Badge variant="secondary">{formatPayoutDisplayStatus(row.payout_status)}</Badge>;
}

export function MondayPayoutDiagnosticsTable({
  rows,
  currencyCode,
  onRetry,
  retryingId,
  compact = false,
  emptyMessage = "No Monday payout records for this period.",
}: {
  rows: MondayPayoutDiagnosticsRow[];
  currencyCode: string;
  onRetry?: (row: MondayPayoutDiagnosticsRow) => void;
  retryingId?: string | null;
  compact?: boolean;
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">{emptyMessage}</p>
    );
  }

  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Driver</TableHead>
            {!compact && <TableHead>Wallet</TableHead>}
            {!compact && <TableHead>Paid / activity</TableHead>}
            {!compact && <TableHead>Gross payable</TableHead>}
            <TableHead>Cash commission recovered</TableHead>
            <TableHead>Net payout</TableHead>
            <TableHead>Payout status</TableHead>
            <TableHead>Driver settlement</TableHead>
            {!compact && <TableHead>Driver paid out</TableHead>}
            <TableHead>Failed amount</TableHead>
            {!compact && <TableHead>Returned to wallet</TableHead>}
            <TableHead>Provider</TableHead>
            <TableHead>Failure</TableHead>
            <TableHead>Failed at</TableHead>
            <TableHead>Reconciliation</TableHead>
            {onRetry && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.payout_item_id}
              className={
                row.settlement_status === "PARTIAL_SETTLEMENT"
                  ? "bg-amber-500/5"
                  : row.payout_status === "failed"
                  ? "bg-destructive/5"
                  : undefined
              }
            >
              <TableCell className="font-medium whitespace-nowrap">
                {row.driver_name ?? row.driver_id.slice(0, 8)}
              </TableCell>
              {!compact && (
                <TableCell className="text-xs">
                  {row.driver_wallet_balance_pence != null ? (
                    <span
                      className={
                        row.driver_wallet_balance_pence < 0
                          ? "text-destructive font-semibold"
                          : "text-foreground"
                      }
                    >
                      {formatPence(row.driver_wallet_balance_pence, currencyCode)}
                      {row.driver_debt_pence != null && row.driver_debt_pence > 0 && (
                        <span className="block text-destructive">In debt</span>
                      )}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
              )}
              {!compact && (
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                  {row.completed_at
                    ? format(new Date(row.completed_at), "d MMM yyyy HH:mm")
                    : row.failed_at
                    ? format(new Date(row.failed_at), "d MMM yyyy HH:mm")
                    : row.created_at
                    ? format(new Date(row.created_at), "d MMM yyyy HH:mm")
                    : "—"}
                </TableCell>
              )}
              {!compact && (
                <TableCell>{formatPence(row.gross_payable_pence, currencyCode)}</TableCell>
              )}
              <TableCell className="text-emerald-700">
                {formatPence(row.cash_commission_recovered_pence, currencyCode)}
              </TableCell>
              <TableCell>{formatPence(row.net_driver_payout_pence, currencyCode)}</TableCell>
              <TableCell>{statusBadge(row)}</TableCell>
              <TableCell>
                {row.settlement_status === "PARTIAL_SETTLEMENT" ? (
                  <span className="text-xs text-amber-700" title={PARTIAL_SETTLEMENT_MESSAGE}>
                    Partial
                  </span>
                ) : (
                  row.settlement_status ?? "—"
                )}
              </TableCell>
              {!compact && (
                <TableCell>{formatPence(row.driver_paid_out_pence, currencyCode)}</TableCell>
              )}
              <TableCell className="text-destructive">
                {row.failed_payout_amount_pence > 0
                  ? formatPence(row.failed_payout_amount_pence, currencyCode)
                  : "—"}
              </TableCell>
              {!compact && (
                <TableCell>
                  {row.returned_to_wallet_pence > 0
                    ? formatPence(row.returned_to_wallet_pence, currencyCode)
                    : "—"}
                </TableCell>
              )}
              <TableCell className="text-xs">
                <div>{row.provider_status ?? "—"}</div>
                {row.provider_reference && (
                  <div className="text-muted-foreground truncate max-w-[120px]" title={row.provider_reference}>
                    {row.provider_reference}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-xs max-w-[200px]">
                {row.failure_code && (
                  <div className="font-mono text-destructive">{row.failure_code}</div>
                )}
                {row.failure_reason ?? "—"}
              </TableCell>
              <TableCell className="text-xs whitespace-nowrap">
                {row.failed_at ? format(new Date(row.failed_at), "d MMM HH:mm") : "—"}
              </TableCell>
              <TableCell>
                {row.reconciliation_status === "RECONCILIATION_MISMATCH" ? (
                  <Badge variant="destructive" className="gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    MISMATCH
                  </Badge>
                ) : (
                  <Badge variant="outline">Balanced</Badge>
                )}
              </TableCell>
              {onRetry && (
                <TableCell>
                  {canRetryMondayPayoutItem(row) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={retryingId === row.payout_item_id}
                      onClick={() => onRetry(row)}
                    >
                      <RefreshCw className={`h-3 w-3 mr-1 ${retryingId === row.payout_item_id ? "animate-spin" : ""}`} />
                      Retry
                    </Button>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
