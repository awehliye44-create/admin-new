import { format } from 'date-fns';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';
import {
  isCustomerBookingAdapterLive,
  providerNotImplementedMessage,
  resolveProviderBookingAdapterStatus,
} from '@/lib/customerPaymentWorkflow';

export type ServiceAreaGatewayStatusRow = {
  service_area_id: string;
  service_area_name: string | null;
  region_name: string | null;
  currency_code: string | null;
  payment_provider?: string | null;
  payment_gateway?: ServiceAreaGatewayStatusRow['customer'];
  payout_gateway?: ServiceAreaGatewayStatusRow['customer'];
  customer: {
    status: string;
    badge_label: string;
    badge_emoji: string;
    display_name: string | null;
    provider: string | null;
    configuration_error: string | null;
    ready_for_production?: boolean;
    booking_payment_health?: "healthy" | "degraded" | "down" | null;
    provider_health?: "healthy" | "degraded" | "down" | null;
    health?: {
      last_webhook_at?: string | null;
      last_connection_test_at?: string | null;
      webhook_healthy?: boolean | null;
      webhook_processing_health?: string | null;
      last_webhook_error?: string | null;
    };
  };
  driver: {
    status: string;
    badge_label: string;
    badge_emoji: string;
    display_name: string | null;
    provider: string | null;
    configuration_error: string | null;
    health?: {
      last_webhook_at?: string | null;
      last_connection_test_at?: string | null;
      webhook_healthy?: boolean | null;
    };
  };
  last_successful_payment_at: string | null;
  last_successful_payout_at: string | null;
};

function formatTs(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return format(new Date(iso), 'dd MMM yyyy HH:mm');
  } catch {
    return iso;
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'CONNECTED':
      return 'text-green-700 border-green-500/40 bg-green-50';
    case 'TEST_MODE':
      return 'text-blue-700 border-blue-500/40 bg-blue-50';
    case 'DISABLED':
      return 'text-amber-700 border-amber-500/40 bg-amber-50';
    case 'CONNECTION_FAILED':
      return 'text-red-700 border-red-500/40 bg-red-50';
    default:
      return '';
  }
}

function GatewayBadge({ snapshot }: { snapshot: ServiceAreaGatewayStatusRow['customer'] }) {
  return (
    <Badge variant="outline" className={statusClass(snapshot.status)}>
      {snapshot.badge_emoji} {snapshot.badge_label}
    </Badge>
  );
}

export function ServiceAreaGatewayStatusPanel({
  rows,
  title = 'Payment provider by service area',
  description = 'One provider per service area for both customer collection and driver payout.',
}: {
  rows: ServiceAreaGatewayStatusRow[];
  title?: string;
  description?: string;
}) {
  const hasNotConfigured = rows.some(
    (r) => r.customer.status === 'NOT_CONFIGURED' || r.driver.status === 'NOT_CONFIGURED',
  );

  const hasProviderNotImplemented = rows.some((r) => {
    const ready = r.customer.status === 'CONNECTED' || r.customer.status === 'TEST_MODE';
    return (
      r.customer.provider
      && ready
      && !isCustomerBookingAdapterLive(r.customer.provider)
    );
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasNotConfigured ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              One or more service areas have a gateway that is not configured. Customer booking will
              fail with PAYMENT_GATEWAY_NOT_CONFIGURED; driver wallet shows a payout warning.
            </AlertDescription>
          </Alert>
        ) : null}

        {hasProviderNotImplemented ? (
          <Alert className="border-amber-500/50 bg-amber-50">
            <AlertTriangle className="h-4 w-4 text-amber-700" />
            <AlertDescription className="text-amber-900">
              One or more service areas use a registered gateway without a live customer booking
              adapter (PROVIDER_NOT_IMPLEMENTED). Customer apps block booking until adapters are
              deployed.
            </AlertDescription>
          </Alert>
        ) : null}

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No service areas in this scope.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service area</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>Payment provider</TableHead>
                  <TableHead>Collection</TableHead>
                  <TableHead>Payout</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Booking adapter</TableHead>
                  <TableHead>Last payment</TableHead>
                  <TableHead>Last payout</TableHead>
                  <TableHead>Last webhook</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const provider =
                    row.payment_provider ??
                    row.customer.provider ??
                    row.driver.provider ??
                    null;
                  const displayName =
                    row.customer.display_name ??
                    row.driver.display_name ??
                    provider ??
                    '—';
                  const payoutName =
                    provider === 'stripe'
                      ? 'Provider'
                      : (row.driver.display_name ?? displayName);
                  return (
                  <TableRow key={row.service_area_id}>
                    <TableCell className="font-medium">
                      {row.service_area_name ?? row.service_area_id.slice(0, 8)}
                      {row.region_name ? (
                        <span className="block text-xs text-muted-foreground">{row.region_name}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>{row.currency_code ?? '—'}</TableCell>
                    <TableCell className="font-medium">{displayName}</TableCell>
                    <TableCell className="text-sm">{displayName}</TableCell>
                    <TableCell className="text-sm">{payoutName}</TableCell>
                    <TableCell>
                      <GatewayBadge snapshot={row.customer} />
                      {row.customer.configuration_error ? (
                        <span className="block text-xs text-destructive mt-1">
                          {row.customer.configuration_error}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {(() => {
                        // Booking adapter readiness uses payment API health, not webhook warnings.
                        const ready =
                          row.customer.ready_for_production === true
                          || row.customer.booking_payment_health === 'healthy'
                          || row.customer.booking_payment_health === 'degraded'
                          || row.customer.status === 'CONNECTED'
                          || row.customer.status === 'TEST_MODE';
                        const adapter = resolveProviderBookingAdapterStatus(
                          row.customer.provider,
                          ready,
                        );
                        if (adapter === 'live') {
                          return <Badge className="bg-green-600 text-white">Live</Badge>;
                        }
                        if (adapter === 'not_implemented') {
                          return (
                            <Badge variant="destructive" title={providerNotImplementedMessage(
                              row.customer.display_name,
                              row.customer.provider ?? '',
                            )}>
                              PROVIDER_NOT_IMPLEMENTED
                            </Badge>
                          );
                        }
                        return <Badge variant="secondary">Not ready</Badge>;
                      })()}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatTs(row.last_successful_payment_at)}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatTs(row.last_successful_payout_at)}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatTs(row.customer.health?.last_webhook_at)}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
