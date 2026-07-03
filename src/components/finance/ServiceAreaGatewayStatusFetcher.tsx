import { useCallback, useEffect, useState } from 'react';
import { invokePaymentProviders } from '@/hooks/usePaymentProviders';
import {
  ServiceAreaGatewayStatusPanel,
  type ServiceAreaGatewayStatusRow,
} from '@/components/finance/ServiceAreaGatewayStatusPanel';

/** Fetches backend gateway SSOT for a single service area (Driver Wallet Ledger scope). */
export function ServiceAreaGatewayStatusFetcher({
  serviceAreaId,
}: {
  serviceAreaId: string | null | undefined;
}) {
  const [rows, setRows] = useState<ServiceAreaGatewayStatusRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!serviceAreaId) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const res = await invokePaymentProviders('GET', {
        action: 'service-area-gateways',
        service_area_id: serviceAreaId,
      }) as {
        success?: boolean;
        service_area_id?: string;
        customer?: ServiceAreaGatewayStatusRow['customer'];
        driver?: ServiceAreaGatewayStatusRow['driver'];
        currency_code?: string | null;
        region_name?: string | null;
      };
      if (res.customer && res.driver) {
        setRows([{
          service_area_id: res.service_area_id ?? serviceAreaId,
          service_area_name: null,
          region_name: res.region_name ?? null,
          currency_code: res.currency_code ?? null,
          customer: res.customer,
          driver: res.driver,
          last_successful_payment_at: null,
          last_successful_payout_at: null,
        }]);
      } else {
        setRows([]);
      }
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [serviceAreaId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!serviceAreaId) return null;
  if (loading && rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading payout gateway status…</p>;
  }
  if (rows.length === 0) return null;

  return (
    <ServiceAreaGatewayStatusPanel
      rows={rows}
      title="Payout gateway (service area SSOT)"
      description="Driver payout provider operational status for the selected service area."
    />
  );
}
