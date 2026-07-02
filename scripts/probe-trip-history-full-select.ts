#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';

const REF = 'thazislrdkjpvvghtvzo';
const url = `https://${REF}.supabase.co`;
const anon =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRoYXppc2xyZGtqcHZ2Z2h0dnpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4NzA1MjIsImV4cCI6MjA4MzQ0NjUyMn0.pXaycIz1t7JXuItyqvjNNrFsZpsaXbB5bV1OWSQLbWM';

const TRIP_HISTORY_SELECT_BASE = `
  id, trip_code, trip_number, status, financial_outcome, passenger_name, passenger_phone,
  pickup_address, pickup_latitude, pickup_longitude, dropoff_address, dropoff_latitude, dropoff_longitude,
  estimated_fare, fare, gross_fare_pence, commission_pence, driver_net_pence, final_fare_pence,
  final_customer_fare_pence, capture_amount_pence,
  stripe_processing_fee_pence, onecab_net_pence,
  payment_status, payment_method, currency_code, estimated_distance_km, estimated_duration_minutes,
  refund_amount_pence, refunded_at,
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

async function adminClient() {
  const raw = execSync(`supabase projects api-keys --project-ref ${REF} -o json`, { encoding: 'utf8' });
  const sr = JSON.parse(raw).find((k: { name: string }) => k.name === 'service_role').api_key;
  const admin = createClient(url, sr, { auth: { persistSession: false } });
  const { data: link } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: 'admin@onecab.net',
  });
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { data: session } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link!.properties!.hashed_token,
  });
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${session!.session!.access_token}` } },
  });
}

async function trySelect(sb: ReturnType<typeof createClient>, select: string, label: string) {
  const mk = 'cb58f1bd-8b6f-45b9-ad31-b3140309892c';
  const start = new Date('2026-06-03T00:00:00.000Z');
  const end = new Date('2026-07-03T23:59:59.999Z');
  const orFilter =
    'financial_outcome.in.(COMPLETED,NO_SHOW,LATE_PASSENGER_CANCELLATION),status.in.(completed,no_show)';
  const { data, error } = await sb
    .from('trips')
    .select(select)
    .or(orFilter)
    .not('completed_at', 'is', null)
    .gte('completed_at', start.toISOString())
    .lte('completed_at', end.toISOString())
    .eq('service_area_id', mk)
    .order('completed_at', { ascending: false })
    .limit(5);
  console.log(label, { error: error?.message ?? null, count: data?.length ?? 0 });
}

async function main() {
  const sb = await adminClient();
  const corporate = `
  corporate_account:corporate_accounts!trips_corporate_account_id_fkey(id, company_name)
`;
  await trySelect(
    sb,
    `${TRIP_HISTORY_SELECT_BASE}, ${TRIP_HISTORY_SELECT_INVOICE}, ${corporate}`,
    'full+corp',
  );
  await trySelect(sb, `${TRIP_HISTORY_SELECT_BASE}, ${TRIP_HISTORY_SELECT_INVOICE}`, 'full+invoice');
  await trySelect(sb, TRIP_HISTORY_SELECT_BASE, 'base');
}

main();
