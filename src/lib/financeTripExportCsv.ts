import {
  getServiceAreaTripCustomerPaidPence,
  getServiceAreaTripDriverNetPence,
  type ServiceAreaTripFinanceContext,
  type ServiceAreaTripFinanceRow,
} from '@/lib/serviceAreaTripFinance';

/** SSOT column headers for completed-trip finance CSV exports. */
export const TRIP_FINANCE_EXPORT_HEADERS = [
  'Trip Code',
  'Completed At',
  'Payment Method',
  'Payment Status',
  'Customer Paid',
  'Driver Net',
  'Commission',
] as const;

export type TripFinanceExportInput = ServiceAreaTripFinanceRow & {
  trip_code?: string | null;
  trip_number?: string | null;
  completed_at?: string | null;
  commission_pence?: number | null;
};

function formatPenceCsv(pence: number): string {
  return (pence / 100).toFixed(2);
}

function formatDriverNetCsv(pence: number | null): string {
  if (pence == null) return 'Unknown';
  return formatPenceCsv(pence);
}

export function buildTripFinanceExportRow(
  trip: TripFinanceExportInput,
  context: ServiceAreaTripFinanceContext,
  tripCode: string,
): string[] {
  const customerPaid = getServiceAreaTripCustomerPaidPence(trip, context);
  const driverNet = getServiceAreaTripDriverNetPence(trip, context);

  return [
    tripCode,
    trip.completed_at ?? '',
    trip.payment_method ?? '',
    trip.payment_status ?? '',
    formatPenceCsv(customerPaid),
    formatDriverNetCsv(driverNet),
    trip.commission_pence != null ? formatPenceCsv(trip.commission_pence) : '',
  ];
}

export function escapeCsvCell(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function buildTripFinanceExportCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n');
}

export function buildTripFinanceExportCsvDocument(dataRows: string[][]): string {
  return buildTripFinanceExportCsv([
    [...TRIP_FINANCE_EXPORT_HEADERS],
    ...dataRows,
  ]);
}
