#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';

const tripHistoryTerminalOrFilter = () =>
  'financial_outcome.in.(COMPLETED,NO_SHOW,LATE_PASSENGER_CANCELLATION),status.in.(completed,no_show)';

const REF = 'thazislrdkjpvvghtvzo';
const url = `https://${REF}.supabase.co`;
const anon =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRoYXppc2xyZGtqcHZ2Z2h0dnpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4NzA1MjIsImV4cCI6MjA4MzQ0NjUyMn0.pXaycIz1t7JXuItyqvjNNrFsZpsaXbB5bV1OWSQLbWM';

async function adminClient() {
  const raw = execSync(`supabase projects api-keys --project-ref ${REF} -o json`, { encoding: 'utf8' });
  const sr = JSON.parse(raw).find((k: { name: string }) => k.name === 'service_role').api_key;
  const admin = createClient(url, sr, { auth: { persistSession: false } });
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: 'admin@onecab.net',
  });
  if (linkErr || !link?.properties?.hashed_token) throw linkErr ?? new Error('no admin link');
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { data: session, error: otpErr } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  });
  if (otpErr || !session.session?.access_token) throw otpErr ?? new Error('no session');
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${session.session.access_token}` } },
  });
}

async function main() {
  const sb = await adminClient();
  const mk = 'cb58f1bd-8b6f-45b9-ad31-b3140309892c';
  const start = new Date('2026-06-03T00:00:00.000Z');
  const end = new Date('2026-07-03T23:59:59.999Z');

  const selectFull = `
  id, trip_code, status, completed_at, service_area_id, refund_amount_pence, refunded_at,
  service_area_join:service_areas!trips_service_area_id_fkey(region_id, region:regions(currency_code, distance_unit))
`;

  const { data, error } = await sb
    .from('trips')
    .select(selectFull)
    .or(tripHistoryTerminalOrFilter())
    .not('completed_at', 'is', null)
    .gte('completed_at', start.toISOString())
    .lte('completed_at', end.toISOString())
    .eq('service_area_id', mk)
    .order('completed_at', { ascending: false })
    .limit(5);

  console.log(JSON.stringify({ error, count: data?.length, codes: data?.map((t) => t.trip_code) }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
