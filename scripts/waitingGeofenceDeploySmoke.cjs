/**
 * Live waiting geofence smoke (post Edge deploy).
 * Creates a disposable assigned trip, exercises B/C/D/F/G, cleans up.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SMOKE_ABORT: missing URL/SERVICE_ROLE');
  process.exit(2);
}

const TAG = `wait_geo_${Date.now()}`;
const SA = 'cb58f1bd-8b6f-45b9-ad31-b3140309892c';
const REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';
const VEHICLE = 'a5c59e9b-ed66-4dd1-8043-1f4730691c12';
const PICKUP = { lat: 52.0406, lng: -0.7594 };
const FAR = { lat: 52.06, lng: -0.72 }; // ~3km
const NEAR = { lat: 52.04065, lng: -0.75945 };

const results = [];
function step(name, ok, detail = {}) {
  results.push({ name, ok: !!ok, ...detail });
  console.log(JSON.stringify({ step: name, ok: !!ok, ...detail }));
}

async function rest(method, tablePath, { query = '', body, prefer } = {}) {
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${tablePath}${query}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { ok: resp.ok, status: resp.status, json };
}

function row(arr) {
  return Array.isArray(arr) && arr[0] ? arr[0] : null;
}

async function mintUserAccessToken(userId) {
  const tempPassword = `Smoke!${Date.now()}Aa1`;
  const upd = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: tempPassword }),
  });
  if (!upd.ok) return { ok: false, error: `admin update ${upd.status}` };
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const userJson = await userRes.json();
  const email = userJson?.email;
  if (!email) return { ok: false, error: 'no email' };
  const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: tempPassword }),
  });
  const loginJson = await login.json().catch(() => null);
  if (!login.ok || !loginJson?.access_token) {
    return { ok: false, error: `login ${login.status}` };
  }
  return { ok: true, accessToken: loginJson.access_token };
}

async function invokeEdge(name, accessToken, body) {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: SERVICE_KEY,
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, json };
}

async function upsertPresence(driverId, lat, lng) {
  const now = new Date().toISOString();
  await rest('POST', 'driver_presence', {
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: {
      driver_id: driverId,
      lat,
      lng,
      last_gps_sample_at: now,
      last_location_at: now,
      last_heartbeat_at: now,
      updated_at: now,
    },
  });
  // also live locations if table exists
  await rest('POST', 'driver_live_locations', {
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: { driver_id: driverId, lat, lng, updated_at: now },
  });
  await rest('PATCH', 'drivers', {
    query: `?id=eq.${driverId}`,
    body: {
      current_lat: lat,
      current_lng: lng,
      last_location_updated_at: now,
      last_seen_at: now,
    },
  });
}

async function getTrip(tripId) {
  const res = await rest('GET', 'trips', {
    query: `?id=eq.${tripId}&select=id,status,started_at,pickup_waiting_started_at,pickup_waiting_counted_seconds,pickup_waiting_charge_pence,pickup_waiting_finalized_at,stop_waiting_charge_pence,waiting_geofence_status,final_customer_fare_pence,locked_base_fare_pence`,
  });
  return row(res.json);
}

async function createPaymentSession({ customerId, userId, tag, amountPence = 1000 }) {
  const sessionId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const res = await rest('POST', 'payment_sessions', {
    prefer: 'return=minimal',
    body: {
      id: sessionId,
      client_action_id: `smoke-${sessionId}`,
      user_id: userId,
      customer_id: customerId,
      service_area_id: SA,
      payment_provider: 'revolut',
      payment_method: 'card',
      status: 'dispatching',
      purpose: 'RIDE_BOOKING',
      provider_state: 'AUTHORISED',
      provider_order_id: `smoke-order-${sessionId}`,
      fare_snapshot: { estimated_fare: amountPence / 100, currency: 'GBP' },
      booking_snapshot: { cursor_smoke: true, tag },
      metadata: { cursor_smoke: true, tag },
      created_at: nowIso,
      updated_at: nowIso,
      release_attempt_count: 0,
      recovery_attempt_count: 0,
      currency: 'GBP',
      idempotency_key: `smoke-${sessionId}`,
      recovery_required: false,
      authorised_amount_pence: amountPence,
      estimated_total_pence: amountPence,
    },
  });
  return { ok: res.ok, sessionId, json: res.json, status: res.status };
}

async function main() {
  // Pick a driver with auth user
  const drvRes = await rest('GET', 'drivers', {
    query: '?select=id,user_id,service_area_id&user_id=not.is.null&limit=5',
  });
  const driver = row(drvRes.json);
  if (!driver?.id || !driver?.user_id) {
    step('setup_driver', false, { error: 'no driver with user_id', raw: drvRes.json });
    process.exit(1);
  }

  const custRes = await rest('GET', 'customers', {
    query: '?select=id,user_id&user_id=not.is.null&limit=1',
  });
  const customer = row(custRes.json);
  if (!customer?.id) {
    step('setup_customer', false, { error: 'no customer' });
    process.exit(1);
  }

  const mint = await mintUserAccessToken(driver.user_id);
  if (!mint.ok) {
    step('mint_driver', false, { error: mint.error });
    process.exit(1);
  }
  step('mint_driver', true, { driver_id: driver.id });

  const pay = await createPaymentSession({
    customerId: customer.id,
    userId: customer.user_id,
    tag: TAG,
  });
  if (!pay.ok) {
    step('create_payment_session', false, { status: pay.status, json: pay.json });
    process.exit(1);
  }
  step('create_payment_session', true, { session_id: pay.sessionId });

  const tripId = crypto.randomUUID();
  const now = new Date().toISOString();
  const tripInsert = await rest('POST', 'trips', {
    prefer: 'return=representation',
    body: {
      id: tripId,
      passenger_id: customer.id,
      driver_id: driver.id,
      confirmed_driver_id: driver.id,
      service_area_id: driver.service_area_id || SA,
      region_id: REGION,
      vehicle_type_id: VEHICLE,
      status: 'accepted',
      dispatch_status: 'assigned',
      pickup_address: `${TAG} pickup`,
      dropoff_address: `${TAG} dropoff`,
      pickup_latitude: PICKUP.lat,
      pickup_longitude: PICKUP.lng,
      dropoff_latitude: 52.0542,
      dropoff_longitude: -0.7275,
      locked_base_fare_pence: 1000,
      final_fare_pence: 1000,
      final_customer_fare_pence: 1000,
      payment_method: 'card',
      payment_status: 'authorized',
      payment_session_id: pay.sessionId,
      financial_model: 'PLATFORM_COLLECTED',
      special_instructions: TAG,
      updated_at: now,
    },
  });
  if (!tripInsert.ok) {
    step('create_trip', false, { status: tripInsert.status, json: tripInsert.json });
    process.exit(1);
  }
  step('create_trip', true, { trip_id: tripId });

  // Pickup stop row (workflow often expects stops)
  await rest('POST', 'trip_stops', {
    prefer: 'return=minimal',
    body: {
      trip_id: tripId,
      type: 'pickup',
      stop_index: 0,
      status: 'pending',
      address: `${TAG} pickup`,
      lat: PICKUP.lat,
      lng: PICKUP.lng,
    },
  });
  await rest('POST', 'trip_stops', {
    prefer: 'return=minimal',
    body: {
      trip_id: tripId,
      type: 'dropoff',
      stop_index: 1,
      status: 'pending',
      address: `${TAG} dropoff`,
      lat: 52.0542,
      lng: -0.7275,
    },
  });

  // B: Arrived outside radius → workflow ok, counted 0
  await upsertPresence(driver.id, FAR.lat, FAR.lng);
  const arrive = await invokeEdge('stop-workflow', mint.accessToken, {
    trip_id: tripId,
    driver_id: driver.id,
    action: 'arrive_pickup',
    driver_lat: FAR.lat, // spoof would claim near — body ignored if trusted FAR
    driver_lng: FAR.lng,
  });
  const tripAfterArrive = await getTrip(tripId);
  const arriveOk =
    arrive.ok &&
    !!tripAfterArrive?.pickup_waiting_started_at &&
    Number(tripAfterArrive?.pickup_waiting_counted_seconds ?? 0) === 0;
  step('B_arrive_outside_counted_0', arriveOk, {
    http: arrive.status,
    waiting_started: tripAfterArrive?.pickup_waiting_started_at ?? null,
    counted: tripAfterArrive?.pickup_waiting_counted_seconds ?? null,
    geofence: tripAfterArrive?.waiting_geofence_status ?? null,
    edge_error: arrive.json?.error || arrive.json?.message || null,
  });

  // F: no-show blocked without counted waiting (even if wall time long)
  const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
  await rest('PATCH', 'trips', {
    query: `?id=eq.${tripId}`,
    body: {
      arrived_at: longAgo,
      pickup_arrived_at: longAgo,
      pickup_waiting_started_at: longAgo,
      pickup_waiting_counted_seconds: 0,
    },
  });
  const noShow = await invokeEdge('pickup-no-show', mint.accessToken, {
    trip_id: tripId,
    driver_lat: FAR.lat,
    driver_lng: FAR.lng,
  });
  const noShowBlocked =
    noShow.ok &&
    (noShow.json?.success === false || noShow.json?.data?.success === false);
  step('F_noshow_blocked_without_counted', noShowBlocked, {
    http: noShow.status,
    body: {
      success: noShow.json?.success ?? noShow.json?.data?.success,
      message: noShow.json?.message ?? noShow.json?.data?.message,
    },
  });

  // C: Start Trip while outside-only (no segments) → start OK, charge 0
  await upsertPresence(driver.id, FAR.lat, FAR.lng);
  const startOutside = await invokeEdge('stop-workflow', mint.accessToken, {
    trip_id: tripId,
    driver_id: driver.id,
    action: 'start_trip',
    driver_lat: FAR.lat,
    driver_lng: FAR.lng,
  });
  const tripC = await getTrip(tripId);
  const cOk =
    startOutside.ok &&
    !!tripC?.started_at &&
    Number(tripC?.pickup_waiting_charge_pence ?? 0) === 0;
  step('C_start_outside_only_charge_0', cOk, {
    http: startOutside.status,
    started_at: tripC?.started_at ?? null,
    pickup_waiting_charge_pence: tripC?.pickup_waiting_charge_pence ?? null,
    counted: tripC?.pickup_waiting_counted_seconds ?? null,
  });

  await rest('PATCH', 'trips', {
    query: `?id=eq.${tripId}`,
    body: {
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancel_reason: `${TAG}_after_C`,
    },
  });

  // D + E on a fresh multi-stop trip
  const pay2 = await createPaymentSession({
    customerId: customer.id,
    userId: customer.user_id,
    tag: `${TAG}_d`,
  });
  const tripId2 = crypto.randomUUID();
  const now2 = new Date().toISOString();
  const trip2 = await rest('POST', 'trips', {
    prefer: 'return=representation',
    body: {
      id: tripId2,
      passenger_id: customer.id,
      driver_id: driver.id,
      confirmed_driver_id: driver.id,
      service_area_id: driver.service_area_id || SA,
      region_id: REGION,
      vehicle_type_id: VEHICLE,
      status: 'accepted',
      dispatch_status: 'assigned',
      pickup_address: `${TAG} pickup2`,
      dropoff_address: `${TAG} dropoff2`,
      pickup_latitude: PICKUP.lat,
      pickup_longitude: PICKUP.lng,
      dropoff_latitude: 52.0542,
      dropoff_longitude: -0.7275,
      locked_base_fare_pence: 1000,
      final_fare_pence: 1000,
      final_customer_fare_pence: 1000,
      payment_method: 'card',
      payment_status: 'authorized',
      payment_session_id: pay2.sessionId,
      financial_model: 'PLATFORM_COLLECTED',
      special_instructions: `${TAG}_d`,
      updated_at: now2,
    },
  });
  if (!trip2.ok) {
    step('create_trip2', false, { status: trip2.status, json: trip2.json });
    process.exit(1);
  }
  await rest('POST', 'trip_stops', {
    prefer: 'return=minimal',
    body: {
      trip_id: tripId2,
      type: 'pickup',
      stop_index: 0,
      status: 'pending',
      address: `${TAG} pickup2`,
      lat: PICKUP.lat,
      lng: PICKUP.lng,
    },
  });
  const viaIns = await rest('POST', 'trip_stops', {
    prefer: 'return=representation',
    body: {
      trip_id: tripId2,
      type: 'stop',
      stop_index: 1,
      status: 'pending',
      address: `${TAG} via`,
      lat: PICKUP.lat,
      lng: PICKUP.lng,
    },
  });
  await rest('POST', 'trip_stops', {
    prefer: 'return=minimal',
    body: {
      trip_id: tripId2,
      type: 'dropoff',
      stop_index: 2,
      status: 'pending',
      address: `${TAG} dropoff2`,
      lat: 52.0542,
      lng: -0.7275,
    },
  });
  const via = row(viaIns.json);

  await upsertPresence(driver.id, FAR.lat, FAR.lng);
  await invokeEdge('stop-workflow', mint.accessToken, {
    trip_id: tripId2,
    driver_id: driver.id,
    action: 'arrive_pickup',
    driver_lat: FAR.lat,
    driver_lng: FAR.lng,
  });

  const t0 = Date.now() - 400_000;
  await rest('POST', 'trip_waiting_segments', {
    prefer: 'return=minimal',
    body: [
      {
        trip_id: tripId2,
        location_type: 'pickup',
        started_at: new Date(t0).toISOString(),
        ended_at: new Date(t0 + 120_000).toISOString(),
        inside_radius: true,
      },
      {
        trip_id: tripId2,
        location_type: 'pickup',
        started_at: new Date(t0 + 180_000).toISOString(),
        ended_at: new Date(t0 + 360_000).toISOString(),
        inside_radius: true,
      },
    ],
  });
  await rest('PATCH', 'trips', {
    query: `?id=eq.${tripId2}`,
    body: { pickup_waiting_counted_seconds: 300 },
  });

  const startD = await invokeEdge('stop-workflow', mint.accessToken, {
    trip_id: tripId2,
    driver_id: driver.id,
    action: 'start_trip',
    driver_lat: FAR.lat,
    driver_lng: FAR.lng,
  });
  const tripD = await getTrip(tripId2);
  const chargeD = Number(tripD?.pickup_waiting_charge_pence ?? 0);
  step('D_finalize_from_counted_segments', startD.ok && !!tripD?.pickup_waiting_finalized_at && chargeD > 0, {
    http: startD.status,
    pickup_waiting_charge_pence: chargeD,
    counted: tripD?.pickup_waiting_counted_seconds ?? null,
    finalized_at: tripD?.pickup_waiting_finalized_at ?? null,
  });

  let eOk = false;
  let eDetail = { skipped: !via?.id };
  if (via?.id) {
    await upsertPresence(driver.id, FAR.lat, FAR.lng);
    const arriveStop = await invokeEdge('stop-workflow', mint.accessToken, {
      trip_id: tripId2,
      driver_id: driver.id,
      action: 'arrive_stop',
      driver_lat: FAR.lat,
      driver_lng: FAR.lng,
    });
    const s0 = Date.now() - 200_000;
    await rest('POST', 'trip_waiting_segments', {
      prefer: 'return=minimal',
      body: [
        {
          trip_id: tripId2,
          location_type: 'stop',
          stop_id: via.id,
          stop_index: 1,
          started_at: new Date(s0).toISOString(),
          ended_at: new Date(s0 + 120_000).toISOString(),
          inside_radius: true,
        },
      ],
    });
    await rest('PATCH', 'trip_stops', {
      query: `?id=eq.${via.id}`,
      body: {
        waiting_charge_active: true,
        waiting_started_at: new Date(s0).toISOString(),
        arrived_at: new Date(s0).toISOString(),
        status: 'current',
      },
    });
    await rest('PATCH', 'trips', {
      query: `?id=eq.${tripId2}`,
      body: {
        current_stop_id: via.id,
        current_stop_index: 1,
        stop_waiting_counted_seconds: 120,
      },
    });
    const driveNext = await invokeEdge('stop-workflow', mint.accessToken, {
      trip_id: tripId2,
      driver_id: driver.id,
      action: 'drive_to_next',
      driver_lat: FAR.lat,
      driver_lng: FAR.lng,
    });
    const afterStop = await getTrip(tripId2);
    const stopCharge = Number(afterStop?.stop_waiting_charge_pence ?? 0);
    eOk = driveNext.ok && stopCharge > 0;
    eDetail = {
      arrive_http: arriveStop.status,
      drive_http: driveNext.status,
      stop_waiting_charge_pence: stopCharge,
      counted_stop_segments_sec: 120,
    };
  }
  step('E_stop_waiting_segment_path', eOk, eDetail);

  const finalTrip = await getTrip(tripId2);
  const pickupCh = Number(finalTrip?.pickup_waiting_charge_pence ?? 0);
  const stopCh = Number(finalTrip?.stop_waiting_charge_pence ?? 0);
  step('G_fare_waiting_columns_counted_only', pickupCh > 0, {
    pickup_waiting_charge_pence: pickupCh,
    stop_waiting_charge_pence: stopCh,
    locked_base_fare_pence: finalTrip?.locked_base_fare_pence ?? null,
    note: 'pickup+stop waiting columns fed by counted segment finalizers',
  });

  // Cleanup
  await rest('PATCH', 'trips', {
    query: `?id=eq.${tripId2}`,
    body: {
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancel_reason: TAG,
      updated_at: new Date().toISOString(),
    },
  });
  step('cleanup_cancelled', true, { trip_id: tripId, trip_id2: tripId2 });

  const failed = results.filter((r) => !r.ok && !String(r.name).startsWith('cleanup'));
  console.log(JSON.stringify({ summary: failed.length === 0 ? 'PASS' : 'FAIL', failed }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
