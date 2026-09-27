import { serveWithEdgeTiming } from "../_shared/edgeFunctionTiming.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveBestOfferForTrip } from "../_shared/resolve-offer.ts";
import {
  PERSONAL_VOUCHER_ERROR_MESSAGES,
  resolvePersonalVoucherForTrip,
} from "../_shared/resolve-personal-voucher.ts";
import {
  nonNegInt,
  resolveCustomerPreauthBasePence,
  tripHasLockedCustomerFare,
} from "../_shared/customerDisplayFare.ts";
import {
  buildPreauthIdempotencyKey,
  buildTripPaymentSyncPatch,
  recordPaymentAuthorizationEvent,
} from "../_shared/dynamicPaymentWorkflow.ts";
import {
  assertCanBookRide,
  logPassengerBookingBlocked,
  passengerNotEligibleResponse,
} from "../_shared/passengerEligibility.ts";
import {
  assertGatewayExecutable,
  checkServiceAreaGatewayForBooking,
  gatewayNotConfiguredResponse,
  type ServiceAreaBookingGatewayBundle,
} from "../_shared/paymentGatewayGuard.ts";
import {
  extractBookingPaymentQuoteIdFromBody,
  loadBookingPaymentQuote,
} from "../_shared/bookingPaymentQuoteSSOT.ts";
import { createRevolutPreauthResponse } from "../_shared/revolutPreauth.ts";
import { extractReceivableConsentFromPreauthBody } from "../_shared/customerReceivableConsentSSOT.ts";
import { createPreauthEdgeTiming } from "../_shared/preauthEdgeTimingSSOT.ts";
import {
  citBrowserEnvironmentErrorResponse,
  extractBrowserEnvironmentFromPreauthBody,
  parseAndValidateCitBrowserEnvironment,
  type RevolutCitBrowserEnvironment,
} from "../_shared/revolutCitBrowserEnvironmentSSOT.ts";
import {
  classifyServiceAreaFinancialPairing,
  FINANCIAL_MODEL_VIOLATION,
  INVALID_CONFIGURATION,
  SERVICE_AREA_FINANCIAL_MODEL,
  shouldSkipPlatformPreauthForCommissionWallet,
  type ServiceAreaCommissionWalletConfig,
} from "../_shared/commissionWalletSSOT.ts";
import { quoteFareServerSide } from "../_shared/serverFareQuote.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CREATE-PREAUTH] ${step}${detailsStr}`);
};

/**
 * Resolve the Pre-Authorization Buffer from the per-service-area admin config
 * (service_area_preauth_settings). This is the SOLE source of truth — the old
 * hardcoded 20% policy has been removed.
 *
 * Returns the computed buffer in pence plus the config snapshot used so it
 * can be logged/persisted for auditability.
 */
async function resolvePreauthBuffer(
  supabaseClient: any,
  estimatedTotalPence: number,
  serviceAreaId: string | null,
  options?: { skipMinHoldWhenDiscounted?: boolean },
): Promise<{
  bufferPence: number;
  source: {
    service_area_id: string | null;
    enable_preauth_buffer: boolean;
    buffer_type: string;
    buffer_value: number;
    min_hold_pence: number | null;
    max_hold_pence: number | null;
    config_table: string;
  };
}> {
  const sourceBase = {
    service_area_id: serviceAreaId,
    config_table: "public.service_area_preauth_settings",
  };

  if (!serviceAreaId) {
    // No service area context — cannot apply admin config; default to no buffer.
    return {
      bufferPence: 0,
      source: {
        ...sourceBase,
        enable_preauth_buffer: false,
        buffer_type: "none",
        buffer_value: 0,
        min_hold_pence: null,
        max_hold_pence: null,
      },
    };
  }

  const { data: rawCfg, error } = await supabaseClient
    .from("service_area_preauth_settings")
    .select("enable_preauth_buffer, buffer_type, buffer_value, min_hold_pence, max_hold_pence")
    .eq("service_area_id", serviceAreaId)
    .maybeSingle();

  if (error) {
    console.warn("[CREATE-PREAUTH] Failed to load preauth settings", error);
  }

  const cfg = rawCfg as Record<string, unknown> | null;
  const enabled = !!cfg?.enable_preauth_buffer;
  const bufferType = (cfg?.buffer_type as string) ?? "none";
  const bufferValue = Number(cfg?.buffer_value ?? 0);
  const minHold = cfg?.min_hold_pence == null ? null : Number(cfg.min_hold_pence);
  const maxHold = cfg?.max_hold_pence == null ? null : Number(cfg.max_hold_pence);

  let rawBufferPence = 0;
  if (enabled && bufferValue > 0) {
    if (bufferType === "fixed") {
      // buffer_value is stored in the major currency unit (e.g. £1.00)
      rawBufferPence = Math.round(bufferValue * 100);
    } else if (bufferType === "percentage") {
      // e.g. buffer_value = 20 → 20%
      rawBufferPence = Math.ceil((estimatedTotalPence * bufferValue) / 100);
    }
  }

  // Apply optional min / max hold clamps to the FINAL hold (estimate + buffer).
  // When a promo discount applies, skip min_hold so we do not bump the hold up
  // to a "minimum fare" floor (customer should be authorised at discounted + buffer only).
  const skipMin = options?.skipMinHoldWhenDiscounted === true;
  let finalHoldPence = estimatedTotalPence + rawBufferPence;
  if (!skipMin && minHold != null && finalHoldPence < minHold) finalHoldPence = minHold;
  if (maxHold != null && finalHoldPence > maxHold) finalHoldPence = maxHold;
  const bufferPence = Math.max(0, finalHoldPence - estimatedTotalPence);

  return {
    bufferPence,
    source: {
      ...sourceBase,
      enable_preauth_buffer: enabled,
      buffer_type: bufferType,
      buffer_value: bufferValue,
      min_hold_pence: minHold,
      max_hold_pence: maxHold,
    },
  };
}

/**
 * Resolve the Region currency for validation and logging.
 * Ride pre-auth PaymentIntents are always created with `currency: "gbp"` per product spec.
 */
async function resolveRegionCurrency(
  supabaseClient: any,
  tripId: string | null,
  serviceAreaId: string | null,
): Promise<string> {
  // 1. Try from trip record (already persisted at booking time)
  if (tripId) {
    const { data: rawTrip } = await supabaseClient
      .from("trips")
      .select("currency_code")
      .eq("id", tripId)
      .maybeSingle();
    const trip = rawTrip as Record<string, unknown> | null;
    if (trip?.currency_code) return String(trip.currency_code).toLowerCase();
  }

  // 2. Try from service area → region join
  if (serviceAreaId) {
    const { data: sa } = await supabaseClient
      .from("service_areas")
      .select("regions!inner(currency_code)")
      .eq("id", serviceAreaId)
      .maybeSingle();
    const joinedRegion = (sa as Record<string, unknown> | null)?.regions;
    const region = (Array.isArray(joinedRegion) ? joinedRegion[0] : joinedRegion) as Record<string, unknown> | undefined;
    if (region?.currency_code) return (region.currency_code as string).toLowerCase();
  }

  throw new Error("Region configuration incomplete — cannot resolve currency. Please contact support.");
}

serveWithEdgeTiming("create-preauth-payment-intent", corsHeaders, async (req) => {
  const edgeTiming = createPreauthEdgeTiming();
  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    // Authenticate user — MUST use anon key + Authorization on the client, then
    // getUser() with no args. service_role client's getUser(jwt) often returns
    // "Auth session missing!" for valid user JWTs (GoTrue mismatch). Same pattern
    // as validate-customer / request-trip-modification.
    edgeTiming.markAuthStart();
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseAnonKey) throw new Error("SUPABASE_ANON_KEY is not configured");

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      supabaseAnonKey,
      {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false },
      },
    );
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    edgeTiming.markAuthEnd();
    logStep("User authenticated", { userId: user.id, email: user.email });

    edgeTiming.markEligibilityStart();
    const bookingEligibility = await assertCanBookRide(supabaseClient, user.id);
    edgeTiming.markEligibilityEnd();
    if (!bookingEligibility.allowed) {
      logPassengerBookingBlocked("create-preauth-payment-intent", user.id, bookingEligibility);
      return passengerNotEligibleResponse(bookingEligibility, corsHeaders);
    }

    const body = await req.json();
    logStep("Request body", body);

    // Saved-card / platform PM path: require CIT browser_environment before any
    // Revolut order create / pay. Never invent defaults.
    const platformPmId =
      typeof body.payment_method_id === "string" ? body.payment_method_id.trim() : "";
    let validatedBrowserEnvironment: RevolutCitBrowserEnvironment | null = null;
    if (platformPmId) {
      const parsedEnv = parseAndValidateCitBrowserEnvironment(
        extractBrowserEnvironmentFromPreauthBody(body as Record<string, unknown>),
      );
      if (!parsedEnv.ok) {
        logStep("BROWSER_ENVIRONMENT_REJECTED", { code: parsedEnv.code });
        return citBrowserEnvironmentErrorResponse(parsedEnv, corsHeaders);
      }
      validatedBrowserEnvironment = parsedEnv.environment;
    }

    // ------------------------------------------------------------------
    // MODE A: Legacy — trip_id already exists (for existing preauth flows)
    // MODE B: Quote-based — no trip yet, just quote metadata
    // ------------------------------------------------------------------
    let estimatedTotalPence: number;
    let tripId: string | null = null;
    let tripFinancialModel: string | null = null;
    let idempotencyKeySuffix: string;
    let metadataExtra: Record<string, string> = {};
    let resolvedServiceAreaId: string | null = null;
    /** Used to skip min-hold floor when a promo reduced the fare */
    let offerDiscountPenceForBuffer = 0;
    /** Quote-path customer row — avoids duplicate customers SELECT before Revolut. */
    let quotePathCustomerId: string | null = null;
    let quotePathCustomerFullName: string | null = null;
    let prefetchedBookingGateway: ServiceAreaBookingGatewayBundle | null = null;

    if (body.trip_id) {
      // Legacy path: trip already exists
      tripId = body.trip_id;
      idempotencyKeySuffix = tripId!;

      const { data: trip, error: tripError } = await supabaseClient
        .from("trips")
        .select("*")
        .eq("id", tripId)
        .single();

      if (tripError || !trip) throw new Error(`Trip not found: ${tripError?.message}`);
      resolvedServiceAreaId = (trip as any).service_area_id ?? null;
      tripFinancialModel = String((trip as any).financial_model ?? "").trim() || null;

      // Validate ownership
      const { data: customer } = await supabaseClient
        .from("customers")
        .select("id, user_id")
        .eq("user_id", user.id)
        .single();

      const isOwner = trip.passenger_id === user.id ||
                      (customer && trip.passenger_id === customer.id);
      if (!isOwner) throw new Error("Unauthorized: You do not own this trip");

      estimatedTotalPence = resolveCustomerPreauthBasePence(trip as Record<string, unknown>);
      offerDiscountPenceForBuffer = Math.max(
        0,
        Number((trip as any).discount_pence ?? (trip as any).offer_discount_pence ?? 0),
      );

      const tripGrossPence = Math.max(
        nonNegInt((trip as any).gross_fare_pence),
        estimatedTotalPence + offerDiscountPenceForBuffer,
      );

      logStep("PAYMENT_CONFIRM_FARE_SOURCE", {
        trip_id: tripId,
        estimated_total_pence: estimatedTotalPence,
        gross_fare_pence: tripGrossPence,
        fare_locked: tripHasLockedCustomerFare(trip as Record<string, unknown>),
        locked_base_fare_pence: (trip as any).locked_base_fare_pence ?? null,
      });

      metadataExtra = {
        trip_id: tripId!,
        gross_fare_pence: String(tripGrossPence),
        offer_discount_pence: String(offerDiscountPenceForBuffer),
        final_fare_pence: String(estimatedTotalPence),
      };
    } else {
      // Quote-based path: no trip yet.
      // When an opaque booking-payment quote id is present, the persisted row
      // is the admission amount (NO_REPRICE_AFTER_BOOK_TAP). The nested
      // estimate-fare call is skipped because revolutPreauth discards it.
      // body.estimated_fare is never the charge amount.
      // Ownership, fingerprint, expiry, and single-use consume still run
      // before any provider order.
      resolvedServiceAreaId = body.service_area_id || null;
      const opaqueQuoteId = extractBookingPaymentQuoteIdFromBody(
        body as Record<string, unknown>,
      );
      idempotencyKeySuffix = body.client_action_id || crypto.randomUUID();

      const parallelStart = Date.now();
      const [fareSettled, customerSettled, gatewaySettled] = await Promise.all([
        (async () => {
          const started = Date.now();
          if (opaqueQuoteId) {
            const row = await loadBookingPaymentQuote(supabaseClient, opaqueQuoteId);
            const ms = Date.now() - started;
            return { kind: "opaque" as const, row, ms };
          }
          const serverQuote = await quoteFareServerSide({
            serviceAreaId: resolvedServiceAreaId,
            vehicleTypeId: typeof body.vehicle_type_id === "string" ? body.vehicle_type_id : null,
            bookingSnapshot:
              body.booking_snapshot && typeof body.booking_snapshot === "object"
                ? body.booking_snapshot as Record<string, unknown>
                : null,
          });
          return { kind: "estimate" as const, serverQuote, ms: Date.now() - started };
        })(),
        (async () => {
          const started = Date.now();
          const { data } = await supabaseClient
            .from("customers")
            .select("id, first_name, last_name")
            .eq("user_id", user.id)
            .maybeSingle();
          return { data, ms: Date.now() - started };
        })(),
        (async () => {
          const started = Date.now();
          if (!resolvedServiceAreaId) {
            return { bundle: null as ServiceAreaBookingGatewayBundle | null, ms: 0 };
          }
          const bundle = await checkServiceAreaGatewayForBooking(
            supabaseClient,
            resolvedServiceAreaId,
            "customer",
          );
          return { bundle, ms: Date.now() - started };
        })(),
      ]);
      const parallelEnd = Date.now();
      edgeTiming.stampMeasured("fareQuote", parallelStart, parallelStart + fareSettled.ms);
      edgeTiming.stampMeasured(
        "customerLookup",
        parallelStart,
        parallelStart + customerSettled.ms,
      );
      if (gatewaySettled.bundle) {
        const saMs = gatewaySettled.bundle.diagnostics.service_area_ms;
        edgeTiming.stampMeasured("financialModel", parallelStart, parallelStart + saMs);
        edgeTiming.stampMeasured("gateway", parallelStart, parallelStart + gatewaySettled.ms);
        edgeTiming.recordDiagnostic(
          "edge_gateway_service_area_ms",
          gatewaySettled.bundle.diagnostics.service_area_ms,
        );
        edgeTiming.recordDiagnostic(
          "edge_gateway_provider_config_ms",
          gatewaySettled.bundle.diagnostics.provider_config_ms,
        );
        edgeTiming.recordDiagnostic(
          "edge_gateway_credentials_ms",
          gatewaySettled.bundle.diagnostics.credentials_ms,
        );
        edgeTiming.recordDiagnostic(
          "edge_gateway_probe_ms",
          gatewaySettled.bundle.diagnostics.probe_ms,
        );
        edgeTiming.recordDiagnostic(
          "edge_gateway_probe_deferred",
          gatewaySettled.bundle.diagnostics.probe_deferred,
        );
      }
      edgeTiming.recordParallelGroupWall(parallelStart, parallelEnd);
      prefetchedBookingGateway = gatewaySettled.bundle;

      let grossFarePence: number;
      if (fareSettled.kind === "opaque") {
        edgeTiming.recordDiagnostic("edge_quote_source", "opaque_row");
        edgeTiming.recordDiagnostic("edge_quote_load_ms", fareSettled.ms);
        edgeTiming.recordDiagnostic("edge_estimate_fare_ms", 0);
        if (!fareSettled.row || fareSettled.row.trip_fare_pence <= 0) {
          logStep("OPAQUE_QUOTE_ROW_UNUSABLE", { quote_id: opaqueQuoteId });
          return new Response(JSON.stringify({
            error: "We couldn't verify this payment total. Please refresh and try again.",
            error_code: "BOOKING_QUOTE_INVALID",
            code: "BOOKING_QUOTE_INVALID",
            charge_state: "no_charge",
          }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        grossFarePence = fareSettled.row.trip_fare_pence;
        logStep("OPAQUE_QUOTE_ROW_FARE", {
          quote_id: opaqueQuoteId,
          trip_fare_pence: grossFarePence,
          client_estimate_ignored: true,
        });
      } else {
        edgeTiming.recordDiagnostic("edge_quote_source", "estimate_fare");
        edgeTiming.recordDiagnostic("edge_estimate_fare_ms", fareSettled.ms);
        edgeTiming.recordDiagnostic("edge_quote_load_ms", 0);
        if (!fareSettled.serverQuote.ok) {
          logStep("SERVER_FARE_QUOTE_FAILED", { reason: fareSettled.serverQuote.reason });
          return new Response(JSON.stringify({
            error: "We couldn't confirm the fare for this trip. Please refresh and try again.",
            error_code: "FARE_QUOTE_UNAVAILABLE",
          }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        grossFarePence = fareSettled.serverQuote.totalFarePence;
        logStep("SERVER_FARE_QUOTE", {
          server_total_pence: grossFarePence,
          client_estimate_pence: Math.round(Number(body.estimated_fare ?? 0) * 100) || null,
        });
      }

      const customerRowOnce = customerSettled.data;
      quotePathCustomerId = customerRowOnce?.id ?? null;
      const cachedCustomerId = quotePathCustomerId ?? user.id;
      quotePathCustomerFullName = [
        customerRowOnce?.first_name,
        customerRowOnce?.last_name,
      ]
        .filter((part) => typeof part === "string" && part.trim())
        .join(" ")
        .trim() || null;

      // ── Server-side offer resolution (Single Source of Truth) ─────────────
      // Apply the same discount the customer was previewed in SelectVehicle so
      // that the provider authorises the DISCOUNTED amount + buffer — not the gross
      // fare. Never trust client-supplied discount values.
      let appliedOfferId: string | null = null;
      let appliedOfferCode: string | null = null;
      let offerDiscountPence = 0;
      if (resolvedServiceAreaId) {
        try {
          edgeTiming.markOfferResolveStart();
          const resolvedOffer = await resolveBestOfferForTrip({
            admin: supabaseClient,
            serviceAreaId: resolvedServiceAreaId,
            estimatedFarePence: grossFarePence,
            userId: user.id,
            customerId: cachedCustomerId,
          });
          edgeTiming.markOfferResolveEnd();
          if (resolvedOffer && resolvedOffer.discountPence > 0) {
            appliedOfferId = resolvedOffer.offerId;
            appliedOfferCode = resolvedOffer.offerCode;
            offerDiscountPence = Math.min(resolvedOffer.discountPence, grossFarePence);
          }
        } catch (offerErr) {
          edgeTiming.markOfferResolveEnd();
          // Non-fatal: if offer resolution fails we authorise the gross fare
          // (over-authorise, then capture corrects). Better than blocking the
          // booking entirely on a transient lookup error.
          logStep("Offer resolution warning (non-fatal)", { error: String(offerErr) });
        }
      }

      let appliedPersonalVoucherId: string | null = null;
      let appliedPersonalVoucherCode: string | null = null;
      let personalVoucherDiscountPence = 0;
      if (body.personal_voucher_code?.trim()) {
        const voucherResult = await resolvePersonalVoucherForTrip({
          admin: supabaseClient,
          code: body.personal_voucher_code,
          customerId: cachedCustomerId,
          estimatedFarePence: grossFarePence,
        });
        if (!voucherResult.ok) {
          return new Response(
            JSON.stringify({ error: PERSONAL_VOUCHER_ERROR_MESSAGES[voucherResult.error] }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        appliedPersonalVoucherId = voucherResult.resolved.voucherId;
        appliedPersonalVoucherCode = voucherResult.resolved.voucherCode;
        personalVoucherDiscountPence = voucherResult.resolved.discountPence;
        appliedOfferId = null;
        appliedOfferCode = null;
        offerDiscountPence = personalVoucherDiscountPence;
      }

      estimatedTotalPence = Math.max(0, grossFarePence - offerDiscountPence);

      offerDiscountPenceForBuffer = offerDiscountPence;

      metadataExtra = {
        customer_user_id: user.id,
        client_action_id: body.client_action_id || "",
        pickup_address: body.pickup_address || "",
        dropoff_address: body.dropoff_address || "",
        vehicle_type_id: body.vehicle_type_id || "",
        service_area_id: body.service_area_id || "",
        gross_fare_pence: String(grossFarePence),
        offer_discount_pence: String(offerDiscountPence),
        applied_offer_id: appliedOfferId || "",
        applied_offer_code: appliedOfferCode || "",
        applied_personal_voucher_id: appliedPersonalVoucherId || "",
        applied_personal_voucher_code: appliedPersonalVoucherCode || "",
        final_fare_pence: String(estimatedTotalPence),
      };
    }

    logStep("Estimated total", { estimatedTotalPence, service_area_id: resolvedServiceAreaId });

    if (
      String(tripFinancialModel ?? "").toUpperCase()
      === SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
    ) {
      return new Response(JSON.stringify({
        error: "Payment Session is forbidden for DRIVER_COLLECTED_COMMISSION_WALLET",
        error_code: FINANCIAL_MODEL_VIOLATION,
        code: FINANCIAL_MODEL_VIOLATION,
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (resolvedServiceAreaId && !tripFinancialModel) {
      let saFinancialRow = prefetchedBookingGateway?.financialRow ?? null;
      if (!prefetchedBookingGateway) {
        edgeTiming.markFinancialModelStart();
        const loaded = await supabaseClient
          .from("service_areas")
          .select("financial_model, commission_wallet_enabled, customer_payment_policy")
          .eq("id", resolvedServiceAreaId)
          .maybeSingle();
        edgeTiming.markFinancialModelEnd();
        if (loaded.error) {
          throw new Error(`Service area financial config failed: ${loaded.error.message}`);
        }
        const raw = loaded.data as {
          financial_model?: string | null;
          commission_wallet_enabled?: boolean | null;
          customer_payment_policy?: string | null;
        } | null;
        saFinancialRow = raw
          ? {
            financial_model: raw.financial_model ?? null,
            commission_wallet_enabled: raw.commission_wallet_enabled ?? null,
            customer_payment_policy: raw.customer_payment_policy ?? null,
          }
          : null;
      }
      const saFinancialConfig: ServiceAreaCommissionWalletConfig = {
        financial_model: saFinancialRow?.financial_model,
        commission_wallet_enabled: saFinancialRow?.commission_wallet_enabled,
        customer_payment_policy: saFinancialRow?.customer_payment_policy,
      };
      const saPairing = classifyServiceAreaFinancialPairing(saFinancialConfig);
      if (!saPairing.ok) {
        return new Response(JSON.stringify({
          error: saPairing.error,
          error_code: INVALID_CONFIGURATION,
          code: INVALID_CONFIGURATION,
        }), {
          status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (shouldSkipPlatformPreauthForCommissionWallet(saFinancialConfig)) {
        return new Response(JSON.stringify({
          error: "Payment Session is forbidden for DRIVER_COLLECTED_COMMISSION_WALLET",
          error_code: FINANCIAL_MODEL_VIOLATION,
          code: FINANCIAL_MODEL_VIOLATION,
        }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (!tripId && !resolvedServiceAreaId) {
      return new Response(JSON.stringify({
        error: "service_area_id is required for new bookings",
        error_code: "SERVICE_AREA_REQUIRED",
      }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let customerGatewayCheck: ServiceAreaBookingGatewayBundle["check"] | null = null;
    if (resolvedServiceAreaId) {
      if (prefetchedBookingGateway) {
        customerGatewayCheck = assertGatewayExecutable(prefetchedBookingGateway.check);
      } else {
        edgeTiming.markGatewayStart();
        const bundle = await checkServiceAreaGatewayForBooking(
          supabaseClient,
          resolvedServiceAreaId,
          "customer",
        );
        edgeTiming.markGatewayEnd();
        edgeTiming.recordDiagnostic(
          "edge_gateway_service_area_ms",
          bundle.diagnostics.service_area_ms,
        );
        edgeTiming.recordDiagnostic(
          "edge_gateway_provider_config_ms",
          bundle.diagnostics.provider_config_ms,
        );
        edgeTiming.recordDiagnostic(
          "edge_gateway_credentials_ms",
          bundle.diagnostics.credentials_ms,
        );
        edgeTiming.recordDiagnostic("edge_gateway_probe_ms", bundle.diagnostics.probe_ms);
        edgeTiming.recordDiagnostic(
          "edge_gateway_probe_deferred",
          bundle.diagnostics.probe_deferred,
        );
        customerGatewayCheck = assertGatewayExecutable(bundle.check);
      }
      if (!customerGatewayCheck.ok) {
        logStep("Customer payment gateway not configured", customerGatewayCheck);
        return gatewayNotConfiguredResponse(customerGatewayCheck, corsHeaders);
      }
      logStep("Customer payment gateway", {
        provider: customerGatewayCheck.provider,
        environment: customerGatewayCheck.environment,
      });
    }

    // Quote-based legacy PaymentIntent search is unavailable — Revolut only.

    // Buffer + currency are independent after fare freeze — parallelize (P1).
    edgeTiming.markBufferStart();
    edgeTiming.markCurrencyStart();
    const [{ bufferPence, source: bufferSource }, regionCurrency] = await Promise.all([
      resolvePreauthBuffer(
        supabaseClient,
        estimatedTotalPence,
        resolvedServiceAreaId,
        { skipMinHoldWhenDiscounted: offerDiscountPenceForBuffer > 0 },
      ),
      resolveRegionCurrency(
        supabaseClient,
        tripId,
        body.service_area_id || metadataExtra.service_area_id || null,
      ),
    ]);
    edgeTiming.markBufferEnd();
    edgeTiming.markCurrencyEnd();
    const authorisedAmountPence = estimatedTotalPence + bufferPence;
    logStep("Buffer calculated", {
      estimated_fare_pence: estimatedTotalPence,
      discount_amount_pence: offerDiscountPenceForBuffer,
      skip_min_hold_due_to_discount: offerDiscountPenceForBuffer > 0,
      buffer_type: bufferSource.buffer_type,
      buffer_value: bufferSource.buffer_value,
      min_hold_pence: bufferSource.min_hold_pence,
      max_hold_pence: bufferSource.max_hold_pence,
      computed_buffer_pence: bufferPence,
      final_preauth_hold_pence: authorisedAmountPence,
      service_area_id: bufferSource.service_area_id,
      source_config: bufferSource.config_table,
      enable_preauth_buffer: bufferSource.enable_preauth_buffer,
    });
    /** Ride pre-auth product spec: GBP manual-capture PaymentIntent (amount in pence). */
    const paymentCurrency = "gbp";
    if (regionCurrency !== paymentCurrency) {
      logStep("Region currency differs from payment currency (using GBP)", {
        regionCurrency,
        paymentCurrency,
      });
    }

    if (customerGatewayCheck?.ok && customerGatewayCheck.provider === "revolut") {
      let dbCustomerForSessionId = quotePathCustomerId;
      let customerFullName = quotePathCustomerFullName;
      if (!dbCustomerForSessionId) {
        edgeTiming.markCustomerLookupStart();
        const { data: dbCustomerForSession } = await supabaseClient
          .from("customers")
          .select("id, first_name, last_name")
          .eq("user_id", user.id)
          .maybeSingle();
        edgeTiming.markCustomerLookupEnd();
        dbCustomerForSessionId = dbCustomerForSession?.id ?? null;
        customerFullName = [
          dbCustomerForSession?.first_name,
          dbCustomerForSession?.last_name,
        ]
          .filter((part) => typeof part === "string" && part.trim())
          .join(" ")
          .trim() || null;
      }

      // Receivable fold: createRevolutPreauthResponse creates the pending
      // payment session, reserves OPEN receivables, then calls Revolut
      // (PREAUTH_RECEIVABLE_ORDERING). Pass ride+buffer only here.
      logStep("Preauth base amount before receivable reserve", {
        estimated_total_pence: estimatedTotalPence,
        buffer_pence: bufferPence,
        authorised_amount_pence: authorisedAmountPence,
        customer_id: dbCustomerForSessionId ?? null,
      });

      return await createRevolutPreauthResponse({
        supabase: supabaseClient,
        environment: customerGatewayCheck.environment === "test" ? "test" : "live",
        authorisedAmountPence,
        estimatedTotalPence,
        bufferPence,
        paymentCurrency,
        tripId,
        clientActionId: body.client_action_id ?? null,
        idempotencyKeySuffix,
        metadataExtra,
        paymentMethodType: body.payment_method_type ?? null,
        userId: user.id,
        customerId: dbCustomerForSessionId ?? null,
        customerEmail: user.email,
        customerName: customerFullName,
        platformPaymentMethodId: body.payment_method_id ?? null,
        savePaymentMethod: body.save_payment_method === true,
        browserEnvironment: validatedBrowserEnvironment,
        bookingSnapshot:
          body.booking_snapshot && typeof body.booking_snapshot === "object"
            ? body.booking_snapshot as Record<string, unknown>
            : null,
        fareSnapshot:
          body.fare_snapshot && typeof body.fare_snapshot === "object"
            ? body.fare_snapshot as Record<string, unknown>
            : {
              estimated_total_pence: estimatedTotalPence,
              authorised_amount_pence: authorisedAmountPence,
              buffer_pence: bufferPence,
              ...metadataExtra,
            },
        receivableConsent: extractReceivableConsentFromPreauthBody(
          body as Record<string, unknown>,
        ),
        corsHeaders,
        logStep,
        edgeTiming,
      });
    }

    if (!customerGatewayCheck?.ok) {
      return new Response(JSON.stringify({
        error: "Card payments require Revolut.",
        error_code: "PAYMENT_PROVIDER_UNAVAILABLE",
        message: "Card payments require Revolut.",
      }), {
        status: 410,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      error: "Card payments require Revolut.",
      error_code: "PAYMENT_PROVIDER_UNAVAILABLE",
      message: "Card payments require Revolut.",
      payment_provider: customerGatewayCheck.provider,
    }), {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message });
    return new Response(JSON.stringify({
      error: message || "Payment setup failed. Please try again.",
      code: "PAYMENT_SETUP_FAILED",
      charge_state: "no_charge",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
