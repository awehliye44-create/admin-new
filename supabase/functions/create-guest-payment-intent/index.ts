/**
 * create-guest-payment-intent
 *
 * Guest (unauthenticated) Revolut web-checkout entry point for onecab.net/whatsapp-booking.
 *
 * Unlike create-payment-intent (Customer app, requires Supabase JWT + existing trip_id),
 * this function:
 *   - requires NO Supabase user session (public WhatsApp guest)
 *   - creates a Revolut order (manual capture, pre_authorisation) via the shared SSOT
 *   - creates an anonymous Supabase auth user so the webhook finalize path works unchanged
 *   - persists a payment_sessions row with booking_snapshot so revolut-webhook can call
 *     create-trip-after-payment via the internal finalize path after Revolut redirects
 *   - returns checkout_url for browser redirect
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
import {
  buildWhatsAppContinuationSigningMaterial,
  verifyWhatsAppContinuationToken,
} from "../_shared/whatsappContinuationToken.ts";

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
  customer_phone: string;
  client_request_id: string;
  return_url: string;
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
    amount,
    currency,
    payment_method = "card",
    pickup_address,
    pickup_lat,
    pickup_lng,
    dropoff_address,
    dropoff_lat,
    dropoff_lng,
    stops = [],
    waypoints = [],
    scheduled_at = null,
    customer_name,
    customer_phone,
    client_request_id,
    return_url,
    continuation_token,
  } = body;

  // === Input validation ===
  if (!service_area_id || !vehicle_type_id) {
    return json({ error: "service_area_id and vehicle_type_id are required" }, 400);
  }
  if (typeof amount !== "number" || amount < 50) {
    return json({ error: "amount must be an integer of at least 50 (pence)" }, 400);
  }
  if (!currency) return json({ error: "currency is required" }, 400);
  if (!customer_name?.trim()) return json({ error: "customer_name is required" }, 400);
  if (!customer_phone?.trim()) return json({ error: "customer_phone is required" }, 400);
  if (!client_request_id) return json({ error: "client_request_id is required" }, 400);
  if (!return_url) return json({ error: "return_url is required" }, 400);
  if (typeof pickup_lat !== "number" || typeof pickup_lng !== "number") {
    return json({ error: "pickup_lat / pickup_lng are required" }, 400);
  }
  if (typeof dropoff_lat !== "number" || typeof dropoff_lng !== "number") {
    return json({ error: "dropoff_lat / dropoff_lng are required" }, 400);
  }

  let resolvedWaId: string | null = null;
  if (typeof continuation_token === "string" && continuation_token.trim()) {
    const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
    const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "";
    if (verifyToken && phoneNumberId) {
      const claims = await verifyWhatsAppContinuationToken(
        continuation_token.trim(),
        buildWhatsAppContinuationSigningMaterial({ verifyToken, phoneNumberId }),
      );
      if (claims?.purpose === "book" && claims.waId) {
        resolvedWaId = claims.waId;
      }
    }
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
    return json({ error: "INVALID_FINANCIAL_CONFIG" }, 400);
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

  // === Create anonymous Supabase user so webhook finalize path works ===
  // revolut-webhook → finalizeBookingAfterPaymentFromSession → create-trip-after-payment
  // requires payment_sessions.user_id to be a valid auth.users row.
  // GoTrue requires email or phone — use a non-deliverable synthetic guest email.
  const safeRequestId = client_request_id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || crypto.randomUUID();
  const guestEmail = `wa-guest+${safeRequestId}@guest.onecab.internal`;
  const { data: anonUser, error: anonErr } = await supabase.auth.admin.createUser({
    email: guestEmail,
    email_confirm: true,
    app_metadata: {
      guest: true,
      booking_source: "whatsapp_booking",
      customer_name: customer_name.trim(),
      customer_phone: customer_phone.trim(),
      client_request_id,
      wa_id: resolvedWaId,
    },
    user_metadata: {
      full_name: customer_name.trim(),
      phone: customer_phone.trim(),
    },
  });

  if (anonErr || !anonUser?.user?.id) {
    console.error("[create-guest-payment-intent] failed to create anon user:", anonErr?.message, anonErr);
    return json({ error: "Failed to initialise guest session" }, 500);
  }

  const guestUserId = anonUser.user.id;
  const resolvedCurrency = (saRow.currency_code ?? currency).toUpperCase();

  // === Create Revolut order (manual capture, pre_authorisation) ===
  let order;
  try {
    const { environment, secretKey } = await getRevolutMerchantConfigFromVault(supabase);
    order = await createRevolutOrder({
      environment,
      secretKey,
      amountMinor: Math.round(amount),
      currency: resolvedCurrency,
      tripId: client_request_id,   // merchant_order_ext_ref — no trip yet
      description: `ONECAB WhatsApp booking – ${customer_name.trim()}`,
      metadata: {
        booking_source: "whatsapp_booking",
        service_area_id,
        vehicle_type_id,
        customer_name: customer_name.trim(),
        customer_phone: customer_phone.trim(),
        client_request_id,
        guest_user_id: guestUserId,
      },
      enableIncrementalAuthorisation: true,
    });
  } catch (err) {
    console.error("[create-guest-payment-intent] Revolut order creation failed:", err);
    // Clean up the guest user we just created
    await supabase.auth.admin.deleteUser(guestUserId).catch(() => {});
    return json({ error: "Payment provider order creation failed" }, 502);
  }

  if (!order.id || !order.checkout_url) {
    await supabase.auth.admin.deleteUser(guestUserId).catch(() => {});
    return json({ error: "The payment provider did not return a checkout link." }, 502);
  }

  // === Build booking snapshot (passed through to create-trip-after-payment by webhook) ===
  const bookingSnapshot: Record<string, unknown> = {
    booking_source: "whatsapp_booking",
    vehicle_type_id,
    service_area_id,
    estimated_fare_pence: Math.round(amount),
    currency: resolvedCurrency,
    payment_method_type: payment_method,
    pickup_address: pickup_address ?? null,
    pickup_lat,
    pickup_lng,
    dropoff_address: dropoff_address ?? null,
    dropoff_lat,
    dropoff_lng,
    stops: stops.map((s, i) => ({ sequence: i, address: s.address ?? null, lat: s.lat, lng: s.lng })),
    waypoints: waypoints.map((w) => ({ lat: w.lat, lng: w.lng })),
    scheduled_at: scheduled_at ?? null,
    customer_name: customer_name.trim(),
    customer_phone: customer_phone.trim(),
    client_action_id: client_request_id,
    return_url,
    wa_id: resolvedWaId,
    // Fields used by create-trip-after-payment
    pickup: { lat: pickup_lat, lng: pickup_lng, address: pickup_address ?? "" },
    dropoff: { lat: dropoff_lat, lng: dropoff_lng, address: dropoff_address ?? "" },
  };

  // === Persist payment session ===
  const { sessionId, error: sessionError } = await upsertPaymentSessionPending(supabase, {
    clientActionId: client_request_id,
    userId: guestUserId,
    serviceAreaId: service_area_id,
    paymentProvider: "revolut",
    providerOrderId: order.id,
    estimatedTotalPence: Math.round(amount),
    paymentMethod: payment_method,
    bookingSnapshot,
    fareSnapshot: {
      estimated_fare_pence: Math.round(amount),
      currency: resolvedCurrency,
      vehicle_type_id,
      service_area_id,
    },
    metadata: {
      booking_source: "whatsapp_booking",
      guest_user_id: guestUserId,
      customer_name: customer_name.trim(),
      customer_phone: customer_phone.trim(),
      wa_id: resolvedWaId,
    },
  });

  if (sessionError || !sessionId) {
    console.error("[create-guest-payment-intent] payment session persist failed:", sessionError);
    await supabase.auth.admin.deleteUser(guestUserId).catch(() => {});
    return json({ error: "Failed to persist payment session" }, 500);
  }

  console.log(
    `[create-guest-payment-intent] order=${order.id} sa=${service_area_id}` +
    ` amount=${Math.round(amount)}${resolvedCurrency} guest=${guestUserId} session=${sessionId}`,
  );

  return json({
    checkout_url: order.checkout_url,
    // Backwards-compat alias the website Vw function already reads:
    checkoutUrl: order.checkout_url,
    provider_order_id: order.id,
    session_id: sessionId,
  });
});
