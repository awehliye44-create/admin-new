/**
 * create-guest-payment-intent
 *
 * Guest (unauthenticated) Revolut web-checkout entry point for onecab.net/whatsapp-booking.
 *
 * Unlike create-payment-intent (Customer app, requires Supabase JWT + existing trip_id),
 * this function:
 *   - requires NO Supabase user session (public WhatsApp guest)
 *   - creates a Revolut order (manual capture, pre_authorisation) via the shared SSOT
 *   - resolves the passenger from the signed WhatsApp continuation token (not a form phone)
 *   - links or creates a customers row that create-trip-after-payment can accept
 *   - persists a payment_sessions row so revolut-webhook calls create-trip-after-payment
 *   - returns checkout_url; Revolut returns the browser to redirect_url
 *
 * Payment model gate (hard rule):
 *   PLATFORM_COLLECTED / PLATFORM_PREPAID → proceed, create Revolut order
 *   DRIVER_COLLECTED_COMMISSION_WALLET    → fail closed (no platform payment)
 *   INVALID config                        → fail closed
 *
 * Called by: onecab.net/whatsapp-booking (Vw function in the Lovable bundle)
 *
 * Request (matches existing website Vw payload):
 *   POST {
 *     source, service_area_id, vehicle_type_id, amount (pence), currency,
 *     payment_method, pickup_address, pickup_lat, pickup_lng,
 *     dropoff_address, dropoff_lat, dropoff_lng,
 *     stops, waypoints, scheduled_at,
 *     customer_name, customer_phone, client_request_id, return_url
 *   }
 *
 * Response:
 *   { checkout_url }  — browser redirects to Revolut-hosted checkout
 *   { error }         — terminal failure
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders } from "../_shared/corsHeaders.ts";
import {
  classifyServiceAreaFinancialPairing,
  shouldSkipPlatformPreauthForCommissionWallet,
  type ServiceAreaCommissionWalletConfig,
} from "../_shared/commissionWalletSSOT.ts";
import {
  createRevolutOrder,
  getRevolutMerchantConfigFromVault,
} from "../_shared/revolutOrders.ts";
import { upsertPaymentSessionPending } from "../_shared/paymentSessionSSOT.ts";
import { evaluateCustomerOnboardingLogin } from "../_shared/onboardingLoginGuard.ts";
import { readWhatsAppPublicOrigin } from "../_shared/whatsappWorkflow.ts";
import {
  buildWhatsAppContinuationSigningMaterial,
  verifyWhatsAppContinuationToken,
} from "../_shared/whatsappContinuationToken.ts";
import { edgeFunctionInvokeHeaders } from "../_shared/edgeFunctionInvokeHeaders.ts";
import {
  buildWhatsAppCheckoutRedirectUrl,
  buildWhatsAppGuestBookingSnapshot,
  isBlockedRiderStatus,
  phonesExactlyMatch,
  resolveWhatsAppCheckoutPaymentMethod,
  splitPassengerName,
  whatsAppWaIdToE164,
  type ServiceAreaDigitalPaymentFlags,
} from "../_shared/whatsappGuestBookingSSOT.ts";
import { assertPickupCoveredByResolveServiceArea } from "../_shared/whatsappPickupCoverageSSOT.ts";

interface GuestPaymentRequest {
  source?: string;
  service_area_id: string;
  vehicle_type_id: string;
  amount: number;           // pence / minor units
  currency: string;
  payment_method?: string;
  pickup_address?: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address?: string;
  dropoff_lat: number;
  dropoff_lng: number;
  stops?: Array<{ sequence: number; address?: string; lat: number; lng: number }>;
  waypoints?: Array<{ lat: number; lng: number }>;
  scheduled_at?: string | null;
  customer_name: string;
  /** Ignored. Phone comes from the signed WhatsApp continuation token. */
  customer_phone?: string;
  client_request_id: string;
  return_url?: string;
  /** Optional signed WhatsApp continuation token (?wa=) — stamps wa_id into snapshot. */
  continuation_token?: string;
}

const RATE_LIMIT_MAP = new Map<string, { count: number; reset: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = RATE_LIMIT_MAP.get(ip);
  if (!entry || now > entry.reset) {
    RATE_LIMIT_MAP.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

function getClientIP(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

async function resolveAuthoritativeFare(
  supabaseUrl: string,
  invokeHeaders: Record<string, string>,
  input: {
    serviceAreaId: string;
    vehicleTypeId: string;
    pickupLat: number;
    pickupLng: number;
    dropoffLat: number;
    dropoffLng: number;
    stops: Array<{ lat: number; lng: number }>;
  },
): Promise<{ amountPence: number; distanceKm: number; durationMin: number } | { error: string }> {
  const routeRes = await fetch(`${supabaseUrl}/functions/v1/calculate-route`, {
    method: "POST",
    headers: invokeHeaders,
    body: JSON.stringify({
      originLat: input.pickupLat,
      originLng: input.pickupLng,
      destLat: input.dropoffLat,
      destLng: input.dropoffLng,
      intermediateStops: input.stops,
    }),
  });
  const route = await routeRes.json().catch(() => ({})) as {
    success?: boolean;
    distanceKm?: number;
    durationMinutes?: number;
    error?: string;
  };
  if (!routeRes.ok || route.success === false || typeof route.distanceKm !== "number") {
    return { error: route.error || "Route could not be priced" };
  }
  const fareRes = await fetch(`${supabaseUrl}/functions/v1/calculate-fare`, {
    method: "POST",
    headers: invokeHeaders,
    body: JSON.stringify({
      service_area_id: input.serviceAreaId,
      estimated_distance_km: route.distanceKm,
      estimated_duration_min: route.durationMinutes ?? 0,
      vehicle_type_id: input.vehicleTypeId,
      pickup: { lat: input.pickupLat, lng: input.pickupLng },
      dropoff: { lat: input.dropoffLat, lng: input.dropoffLng },
      stops: input.stops,
    }),
  });
  const fare = await fareRes.json().catch(() => ({})) as {
    success?: boolean;
    error?: string;
    vehicleFares?: Array<{
      vehicleTypeId?: string;
      fare?: { totalFarePence?: number };
    }>;
  };
  if (!fareRes.ok || fare.success === false) {
    return { error: fare.error || "Fare could not be calculated" };
  }
  const match = (fare.vehicleFares ?? []).find((row) => row.vehicleTypeId === input.vehicleTypeId);
  const amountPence = match?.fare?.totalFarePence;
  if (typeof amountPence !== "number" || amountPence < 50) {
    return { error: "Selected vehicle has no payable fare" };
  }
  return {
    amountPence: Math.round(amountPence),
    distanceKm: route.distanceKm,
    durationMin: route.durationMinutes ?? 0,
  };
}

type GuestIdentity =
  | { ok: true; userId: string; customerId: string; createdGuestUser: boolean }
  | { ok: false; error: string; status: number; code: string };

function isPhoneAlreadyRegistered(message: string | undefined): boolean {
  const text = (message ?? "").toLowerCase();
  return text.includes("already registered") || text.includes("phone_exists");
}

async function findAuthUserIdByPhone(
  supabase: { rpc: (fn: string, args: Record<string, string>) => Promise<{ data: unknown; error: { message?: string } | null }> },
  phone: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("auth_user_id_by_exact_phone", { p_phone: phone });
  if (error || typeof data !== "string" || data.length === 0) return null;
  return data;
}

async function reuseRegisteredPhoneOwner(
  supabase: any,
  input: { phone: string; displayName: string },
): Promise<GuestIdentity> {
  const userId = await findAuthUserIdByPhone(supabase, input.phone);
  if (!userId) {
    console.error(JSON.stringify({
      event: "PHONE_ALREADY_REGISTERED",
      outcome: "auth_user_not_found",
    }));
    return {
      ok: false,
      error: "This number already has a ONECAB account. Open the app to finish booking.",
      status: 409,
      code: "PHONE_ALREADY_REGISTERED",
    };
  }

  const { data: existingCustomer } = await supabase
    .from("customers")
    .select("id, rider_status")
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  let customerId = existingCustomer?.id as string | undefined;
  let createdCustomer = false;
  if (existingCustomer && isBlockedRiderStatus(existingCustomer.rider_status)) {
    return { ok: false, error: "This account cannot book a ride", status: 403, code: "PHONE_ALREADY_REGISTERED" };
  }
  if (!customerId) {
    const names = splitPassengerName(input.displayName);
    const nowIso = new Date().toISOString();
    const { data: inserted, error: insertErr } = await supabase
      .from("customers")
      .insert({
        user_id: userId,
        first_name: names.firstName,
        last_name: names.lastName,
        phone: input.phone,
        phone_verified: true,
        phone_verified_at: nowIso,
        email_verified: true,
        email_verified_at: nowIso,
        rider_status: "active",
      })
      .select("id")
      .single();
    if (insertErr || !inserted?.id) {
      const insertReason = insertErr?.message === "phone_already_in_use"
        ? "phone_already_in_use"
        : "customer_insert_failed";
      console.error(JSON.stringify({
        event: "PHONE_ALREADY_REGISTERED",
        outcome: "customer_insert_failed",
        reason: insertReason,
      }));
      return {
        ok: false,
        error: "This number already has a ONECAB account. Open the app to finish booking.",
        status: 409,
        code: "PHONE_ALREADY_REGISTERED",
      };
    }
    customerId = inserted.id;
    createdCustomer = true;
  }

  const guard = await evaluateCustomerOnboardingLogin(supabase, userId);
  if (!guard.app_access_allowed) {
    if (createdCustomer) {
      await supabase.from("customers").delete().eq("id", customerId);
    }
    console.error(JSON.stringify({
      event: "PHONE_ALREADY_REGISTERED",
      outcome: "guard_blocked",
      block_code: guard.block_code,
    }));
    return {
      ok: false,
      error: "This number already has a ONECAB account. Open the app to finish booking.",
      status: 409,
      code: "PHONE_ALREADY_REGISTERED",
    };
  }

  console.info(JSON.stringify({
    event: "PHONE_ALREADY_REGISTERED",
    outcome: "reused_existing_auth_user",
  }));
  return { ok: true, userId, customerId, createdGuestUser: false };
}

async function ensureWhatsAppGuestCustomer(
  supabase: any,
  supabaseUrl: string,
  serviceRoleKey: string,
  input: { phone: string; waId: string; displayName: string; clientRequestId: string },
): Promise<GuestIdentity> {
  const digits = input.phone.replace(/\D/g, "");
  const { data: candidates } = await supabase
    .from("customers")
    .select("id, user_id, phone, rider_status")
    .ilike("phone", `%${digits.slice(-10)}`)
    .is("deleted_at", null)
    .limit(8);

  const existing = (candidates ?? []).find((row: {
    id: string;
    user_id: string;
    phone: string | null;
    rider_status: string | null;
  }) => phonesExactlyMatch(row.phone, input.phone));
  if (existing) {
    if (isBlockedRiderStatus(existing.rider_status)) {
      return { ok: false, error: "This account cannot book a ride", status: 403, code: "PHONE_ALREADY_REGISTERED" };
    }
    const guard = await evaluateCustomerOnboardingLogin(supabase, existing.user_id);
    if (!guard.app_access_allowed) {
      return {
        ok: false,
        error: "This number already has a ONECAB account. Open the app to finish booking.",
        status: 409,
        code: "PHONE_ALREADY_REGISTERED",
      };
    }
    return {
      ok: true,
      userId: existing.user_id,
      customerId: existing.id,
      createdGuestUser: false,
    };
  }

  const safeRequestId = input.clientRequestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || crypto.randomUUID();
  const names = splitPassengerName(input.displayName);
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: `wa-guest+${safeRequestId}@guest.onecab.internal`,
    phone: input.phone,
    email_confirm: true,
    phone_confirm: true,
    app_metadata: {
      guest: true,
      booking_source: "whatsapp_booking",
      wa_id: input.waId,
    },
    user_metadata: {
      full_name: input.displayName,
      phone: input.phone,
    },
  });
  if (createErr || !created.user?.id) {
    if (isPhoneAlreadyRegistered(createErr?.message)) {
      return await reuseRegisteredPhoneOwner(supabase, input);
    }
    console.error(JSON.stringify({
      event: "GUEST_IDENTITY_CREATE_FAILED",
      code: "PAYMENT_SESSION_CREATE_FAILED",
    }));
    return { ok: false, error: "Failed to initialise guest session", status: 500, code: "PAYMENT_SESSION_CREATE_FAILED" };
  }

  const nowIso = new Date().toISOString();
  const { data: customer, error: customerErr } = await supabase
    .from("customers")
    .insert({
      user_id: created.user.id,
      first_name: names.firstName,
      last_name: names.lastName,
      phone: input.phone,
      phone_verified: true,
      phone_verified_at: nowIso,
      email_verified: true,
      email_verified_at: nowIso,
      rider_status: "active",
    })
    .select("id")
    .single();

  if (customerErr || !customer?.id) {
    await supabase.auth.admin.deleteUser(created.user.id).catch(() => {});
    console.error(JSON.stringify({
      event: "GUEST_CUSTOMER_INSERT_FAILED",
      code: "PAYMENT_SESSION_CREATE_FAILED",
    }));
    return { ok: false, error: "Failed to initialise guest session", status: 500, code: "PAYMENT_SESSION_CREATE_FAILED" };
  }

  const guard = await evaluateCustomerOnboardingLogin(supabase, created.user.id);
  if (!guard.app_access_allowed) {
    await supabase.from("customers").delete().eq("id", customer.id);
    await supabase.auth.admin.deleteUser(created.user.id).catch(() => {});
    return { ok: false, error: "WhatsApp booking could not be verified", status: 403, code: "PHONE_ALREADY_REGISTERED" };
  }

  return {
    ok: true,
    userId: created.user.id,
    customerId: customer.id,
    createdGuestUser: true,
  };
}

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const clientIP = getClientIP(req);
  if (!checkRateLimit(clientIP)) {
    return json({ error: "Too many requests" }, 429);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  let body: GuestPaymentRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const {
    service_area_id,
    vehicle_type_id,
    currency,
    payment_method = "card",
    pickup_address,
    pickup_lat,
    pickup_lng,
    dropoff_address,
    dropoff_lat,
    dropoff_lng,
    stops = [],
    customer_name,
    client_request_id,
    continuation_token,
  } = body;

  // === Input validation ===
  if (!service_area_id || !vehicle_type_id) {
    return json({ error: "service_area_id and vehicle_type_id are required" }, 400);
  }
  if (!currency) return json({ error: "currency is required" }, 400);
  if (!customer_name?.trim() || customer_name.trim().length < 2) {
    return json({ error: "customer_name is required" }, 400);
  }
  if (!client_request_id) return json({ error: "client_request_id is required" }, 400);
  if (!pickup_address?.trim() || !dropoff_address?.trim()) {
    return json({ error: "pickup and dropoff addresses are required" }, 400);
  }
  if (typeof pickup_lat !== "number" || typeof pickup_lng !== "number") {
    return json({ error: "pickup_lat / pickup_lng are required" }, 400);
  }
  if (typeof dropoff_lat !== "number" || typeof dropoff_lng !== "number") {
    return json({ error: "dropoff_lat / dropoff_lng are required" }, 400);
  }
  if (typeof continuation_token !== "string" || !continuation_token.trim()) {
    return json({ error: "A secure WhatsApp booking link is required" }, 401);
  }

  const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "";
  if (!verifyToken || !phoneNumberId) {
    return json({ error: "WhatsApp booking is unavailable" }, 503);
  }
  const claims = await verifyWhatsAppContinuationToken(
    continuation_token.trim(),
    buildWhatsAppContinuationSigningMaterial({ verifyToken, phoneNumberId }),
  );
  if (!claims || claims.purpose !== "book" || !claims.waId) {
    return json({ error: "Invalid or expired WhatsApp booking link", code: "INVALID_CONTINUATION_TOKEN" }, 401);
  }
  const resolvedWaId = claims.waId;
  const passengerPhone = whatsAppWaIdToE164(resolvedWaId);
  if (!passengerPhone) {
    return json({ error: "WhatsApp identity could not be resolved" }, 401);
  }
  const redirectUrl = buildWhatsAppCheckoutRedirectUrl(
    readWhatsAppPublicOrigin(),
    continuation_token.trim(),
  );
  if (!redirectUrl) {
    return json({ error: "Booking return URL is not configured" }, 503);
  }

  const invokeHeaders = edgeFunctionInvokeHeaders(req);
  if (!invokeHeaders) {
    return json({ error: "Fare service is unavailable" }, 503);
  }

  // === Pickup coverage gate — before idempotent checkout return, Revolut, or session ===
  const coverage = await assertPickupCoveredByResolveServiceArea(supabaseUrl, invokeHeaders, {
    pickupLat: pickup_lat,
    pickupLng: pickup_lng,
    serviceAreaId: service_area_id,
  });
  if (!coverage.ok) {
    console.warn(JSON.stringify({
      event: "GUEST_PICKUP_COVERAGE_REJECTED",
      code: coverage.code,
      service_area_id,
    }));
    return json({ error: coverage.error, code: coverage.code }, coverage.status);
  }

  // === Idempotency: check for existing session with same client_request_id ===
  const { data: existingSession } = await supabase
    .from("payment_sessions")
    .select("id, provider_order_id, status, metadata")
    .eq("client_action_id", client_request_id)
    .maybeSingle();

  if (existingSession?.provider_order_id) {
    // Retrieve the existing Revolut order to return its checkout_url
    try {
      const { environment, secretKey } = await getRevolutMerchantConfigFromVault(supabase);
      const { retrieveRevolutOrder } = await import("../_shared/revolutOrders.ts");
      const order = await retrieveRevolutOrder(environment, secretKey, existingSession.provider_order_id);
      const checkoutUrl = order.checkout_url;
      if (checkoutUrl) {
        console.log(`[create-guest-payment-intent] idempotent return order=${existingSession.provider_order_id}`);
        return json({ checkout_url: checkoutUrl, checkoutUrl, idempotent: true });
      }
    } catch (e) {
      console.warn("[create-guest-payment-intent] idempotent retrieval failed:", e);
      // Fall through to create new order
    }
  }

  // === Financial model gate — fail closed for DRIVER_COLLECTED / INVALID ===
  const { data: saRow, error: saErr } = await supabase
    .from("service_areas")
    .select("id, financial_model, commission_wallet_enabled, customer_payment_policy, currency_code")
    .eq("id", service_area_id)
    .eq("is_active", true)
    .maybeSingle();

  if (saErr) {
    console.error("[create-guest-payment-intent] SA lookup error:", saErr.message);
    return json({ error: "Service area lookup failed" }, 500);
  }
  if (!saRow) {
    return json({ error: "Service area not found or inactive" }, 400);
  }

  const saConfig: ServiceAreaCommissionWalletConfig = {
    financial_model: saRow.financial_model,
    commission_wallet_enabled: saRow.commission_wallet_enabled,
    customer_payment_policy: saRow.customer_payment_policy,
  };
  const pairing = classifyServiceAreaFinancialPairing(saConfig);

  if (!pairing.ok) {
    console.error(
      `[create-guest-payment-intent] INVALID_FINANCIAL_CONFIG sa=${service_area_id}`,
      saRow.financial_model, saRow.customer_payment_policy, saRow.commission_wallet_enabled,
    );
    return json({ error: "INVALID_FINANCIAL_CONFIG", code: "FINANCIAL_MODEL_VIOLATION" }, 400);
  }

  const skipPreauth = shouldSkipPlatformPreauthForCommissionWallet(saConfig);
  if (skipPreauth) {
    // DRIVER_COLLECTED: no platform payment session / preauth — fail closed for web checkout
    console.warn(`[create-guest-payment-intent] DRIVER_COLLECTED sa=${service_area_id} — no platform checkout`);
    return json({
      error: "DRIVER_COLLECTED",
      message: "This service area uses driver-collected payments. No platform checkout is available.",
    }, 400);
  }

  const { data: pmRow } = await supabase
    .from("service_area_payment_methods")
    .select("card_enabled, apple_pay_enabled, google_pay_enabled")
    .eq("service_area_id", service_area_id)
    .maybeSingle();
  const paymentFlags: ServiceAreaDigitalPaymentFlags = {
    card: pmRow?.card_enabled ?? true,
    applePay: pmRow?.apple_pay_enabled ?? false,
    googlePay: pmRow?.google_pay_enabled ?? false,
  };
  const resolvedPaymentMethod = resolveWhatsAppCheckoutPaymentMethod(payment_method, paymentFlags);
  if (!resolvedPaymentMethod) {
    return json({ error: "That payment method is not available in this area" }, 400);
  }

  const priced = await resolveAuthoritativeFare(supabaseUrl, invokeHeaders, {
    serviceAreaId: service_area_id,
    vehicleTypeId: vehicle_type_id,
    pickupLat: pickup_lat,
    pickupLng: pickup_lng,
    dropoffLat: dropoff_lat,
    dropoffLng: dropoff_lng,
    stops: stops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
  });
  if ("error" in priced) {
    return json({ error: priced.error, code: "FARE_REVALIDATION_FAILED" }, 422);
  }

  const identity = await ensureWhatsAppGuestCustomer(supabase, supabaseUrl, serviceRoleKey, {
    phone: passengerPhone,
    waId: resolvedWaId,
    displayName: customer_name.trim(),
    clientRequestId: client_request_id,
  });
  if (!identity.ok) {
    console.error(JSON.stringify({
      event: "GUEST_IDENTITY_REJECTED",
      code: identity.code,
      status: identity.status,
    }));
    return json({ error: identity.error, code: identity.code }, identity.status);
  }

  const guestUserId = identity.userId;
  const guestCustomerId = identity.customerId;
  let createdGuestUser = identity.createdGuestUser;

  // Prefer service-area SSOT currency — never charge in a client-supplied currency.
  const saCurrency = typeof saRow.currency_code === "string" ? saRow.currency_code.trim() : "";
  if (!saCurrency) {
    return json({ error: "Service area currency is not configured", code: "CURRENCY_UNAVAILABLE" }, 503);
  }
  if (currency.toUpperCase() !== saCurrency.toUpperCase()) {
    return json({
      error: "Currency does not match the pickup service area",
      code: "CURRENCY_MISMATCH",
    }, 400);
  }
  const resolvedCurrency = saCurrency.toUpperCase();
  const discardNewGuest = async () => {
    if (!createdGuestUser) return;
    await supabase.from("customers").delete().eq("id", guestCustomerId);
    await supabase.auth.admin.deleteUser(guestUserId).catch(() => {});
  };

  let order;
  try {
    const { environment, secretKey } = await getRevolutMerchantConfigFromVault(supabase);
    order = await createRevolutOrder({
      environment,
      secretKey,
      amountMinor: priced.amountPence,
      currency: resolvedCurrency,
      tripId: client_request_id,
      description: `ONECAB WhatsApp booking – ${customer_name.trim()}`,
      metadata: {
        booking_source: "whatsapp_booking",
        service_area_id,
        vehicle_type_id,
        customer_name: customer_name.trim(),
        client_request_id,
        guest_user_id: guestUserId,
      },
      enableIncrementalAuthorisation: true,
      redirectUrl,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "REVOLUT_ORDER_CREATE_FAILED", code: "REVOLUT_ORDER_CREATE_FAILED" }));
    await discardNewGuest();
    return json({ error: "Payment provider order creation failed", code: "REVOLUT_ORDER_CREATE_FAILED" }, 502);
  }

  if (!order.id || !order.checkout_url) {
    await discardNewGuest();
    return json({ error: "The payment provider did not return a checkout link.", code: "CHECKOUT_URL_MISSING" }, 502);
  }

  const bookingSnapshot = buildWhatsAppGuestBookingSnapshot({
    serviceAreaId: service_area_id,
    vehicleTypeId: vehicle_type_id,
    amountPence: priced.amountPence,
    currency: resolvedCurrency,
    paymentMethod: resolvedPaymentMethod,
    pickupAddress: pickup_address.trim(),
    pickupLat: pickup_lat,
    pickupLng: pickup_lng,
    dropoffAddress: dropoff_address.trim(),
    dropoffLat: dropoff_lat,
    dropoffLng: dropoff_lng,
    stops,
    estimatedDistanceKm: priced.distanceKm,
    estimatedDurationMin: priced.durationMin,
    passengerName: customer_name.trim(),
    passengerPhone,
    customerId: guestCustomerId,
    clientActionId: client_request_id,
    providerOrderId: order.id,
    continuationToken: continuation_token.trim(),
    waId: resolvedWaId,
    redirectUrl,
  });

  const { sessionId, error: sessionError } = await upsertPaymentSessionPending(supabase, {
    clientActionId: client_request_id,
    userId: guestUserId,
    customerId: guestCustomerId,
    serviceAreaId: service_area_id,
    paymentProvider: "revolut",
    providerOrderId: order.id,
    estimatedTotalPence: priced.amountPence,
    paymentMethod: resolvedPaymentMethod,
    bookingSnapshot,
    fareSnapshot: {
      estimated_fare_pence: priced.amountPence,
      currency: resolvedCurrency,
      vehicle_type_id,
      service_area_id,
    },
    metadata: {
      booking_source: "whatsapp_booking",
      guest_user_id: guestUserId,
      customer_id: guestCustomerId,
      customer_name: customer_name.trim(),
      wa_id: resolvedWaId,
    },
  });

  if (sessionError || !sessionId) {
    console.error("[create-guest-payment-intent] payment session persist failed:", sessionError);
    await discardNewGuest();
    return json({ error: "Failed to persist payment session", code: "PAYMENT_SESSION_CREATE_FAILED" }, 500);
  }

  console.log(
    `[create-guest-payment-intent] order=${order.id} sa=${service_area_id}` +
    ` amount=${priced.amountPence}${resolvedCurrency} guest=${guestUserId} session=${sessionId}`,
  );

  return json({
    checkout_url: order.checkout_url,
    // Backwards-compat alias the website Vw function already reads:
    checkoutUrl: order.checkout_url,
    provider_order_id: order.id,
    session_id: sessionId,
  });
});
