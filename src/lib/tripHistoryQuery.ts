import { supabase } from '@/integrations/supabase/client';

/** Terminal trips — aligned with Financial Reconciliation COUNTABLE_FINANCIAL_OUTCOMES. */
export const TRIP_HISTORY_FINANCIAL_OUTCOMES = [
  'COMPLETED',
  'NO_SHOW',
  'LATE_PASSENGER_CANCELLATION',
] as const;

export const TRIP_HISTORY_STATUSES = ['completed', 'no_show'] as const;

export function tripHistoryTerminalOrFilter(): string {
  return `financial_outcome.in.(${TRIP_HISTORY_FINANCIAL_OUTCOMES.join(',')}),status.in.(${TRIP_HISTORY_STATUSES.join(',')})`;
}

const TRIP_HISTORY_SELECT_BASE = `
  id, trip_code, trip_number, status, financial_outcome, passenger_name, passenger_phone,
  pickup_address, pickup_latitude, pickup_longitude, dropoff_address, dropoff_latitude, dropoff_longitude,
  estimated_fare, fare, gross_fare_pence, commission_pence, driver_net_pence, final_fare_pence,
  final_customer_fare_pence, capture_amount_pence,
  stripe_processing_fee_pence, onecab_net_pence,
  payment_status, payment_method, currency_code, estimated_distance_km, estimated_duration_minutes,
  total_stops, created_at, started_at, completed_at, surge_multiplier, driver_id,
  driver_location_lat, driver_location_lng, stripe_payment_intent_id, stacked_trip_id,
  corporate_account_id, region_id, service_area_id,
  pricing_mode, fare_locked, vehicle_type_id, vehicle_type, fare_engine_config_id,
  waiting_charge_pence, pickup_waiting_charge_pence, total_waiting_charge_pence, waiting_minutes, fare_breakdown,
  tip_pence, tip_amount_pence,
  arrival_cancellation_applied, arrival_cancellation_fee,
  driver:drivers!trips_driver_id_fkey(id, first_name, last_name, phone, driver_code, region_id),
  service_area_join:service_areas!trips_service_area_id_fkey(region_id, region:regions(currency_code, distance_unit))
`;

const TRIP_HISTORY_SELECT_INVOICE = `
  invoice_no, invoice_pdf_url, invoice_generated_at, invoice_email_sent,
  invoice_email_sent_at, invoice_email_status, invoice_email_error,
  invoice_pdf_error, invoice_total_paid_pence, invoice_regenerated_at
`;

const TRIP_HISTORY_SELECT_CORPORATE = `
  corporate_account:corporate_accounts!trips_corporate_account_id_fkey(id, company_name)
`;

function isRecoverableTripHistoryQueryError(error: { message?: string; code?: string }): boolean {
  const msg = (error.message ?? '').toLowerCase();
  return (
    msg.includes('column')
    || msg.includes('does not exist')
    || msg.includes('could not find')
    || msg.includes('relationship')
    || error.code === '42703'
    || error.code === 'PGRST204'
    || error.code === 'PGRST200'
  );
}

export type TripHistoryRow = Record<string, unknown> & { id: string };

export async function fetchTripHistoryRows(args: {
  start: Date;
  end: Date;
  regionId?: string;
  serviceAreaId?: string;
}): Promise<TripHistoryRow[]> {
  const selectVariants = [
    `${TRIP_HISTORY_SELECT_BASE}, ${TRIP_HISTORY_SELECT_INVOICE}, ${TRIP_HISTORY_SELECT_CORPORATE}`,
    `${TRIP_HISTORY_SELECT_BASE}, ${TRIP_HISTORY_SELECT_INVOICE}`,
    TRIP_HISTORY_SELECT_BASE,
  ];

  let lastError: { message?: string; code?: string } | null = null;

  for (const select of selectVariants) {
    let query = supabase
      .from('trips')
      .select(select)
      .or(tripHistoryTerminalOrFilter())
      .not('completed_at', 'is', null)
      .gte('completed_at', args.start.toISOString())
      .lte('completed_at', args.end.toISOString())
      .order('completed_at', { ascending: false })
      .limit(2000);

    if (args.serviceAreaId && args.serviceAreaId !== 'all') {
      query = query.eq('service_area_id', args.serviceAreaId);
    } else if (args.regionId && args.regionId !== 'all') {
      query = query.eq('region_id', args.regionId);
    }

    const { data, error } = await query;
    if (!error) {
      return (data ?? []) as TripHistoryRow[];
    }
    lastError = error;
    if (!isRecoverableTripHistoryQueryError(error)) {
      throw error;
    }
  }

  throw lastError ?? new Error('Failed to load trip history');
}
