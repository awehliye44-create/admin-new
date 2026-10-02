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
  bookingPaymentQuoteErrorPayload,
  extractBookingPaymentQuoteIdFromBody,
  FARE_QUOTE_CHANGED,
  loadBookingPaymentQuote,
} from "../_shared/bookingPaymentQuoteSSOT.ts";
import {
  buildServerPreauthSessionFareSnapshot,
  resolveServiceAreaIdForPickup,
  SERVICE_AREA_MISMATCH,
} from "../_shared/serverFareAuthoritySSOT.ts";
import { normalizePersonalVoucherCode } from "../_shared/serverBookingDiscountSSOT.ts";
import { createRevolutPreauthResponse } from "../_shared/revolutPreauth.ts";
import { extractReceivableConsentFromPreauthBody } from "../_shared/customerReceivableConsentSSOT.ts";
import { createPreauthEdgeTiming } from "../_shared/preauthEdgeTimingSSOT.ts";
import { scheduleEdgeBackground } from "../_shared/scheduleEdgeBackground.ts";
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
import { resolvePreauthBuffer } from "../_shared/preauthBufferResolverSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CREATE-PREAUTH] ${step}${detailsStr}`);
};

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
    let preloadedOpaqueQuote: Awaited<ReturnType<typeof loadBookingPaymentQuote>> = null;
    let deferredOfferMetadata: (() => Promise<void>) | null = null;
    let prefetchedBookingGateway: ServiceAreaBookingGatewayBundle | null = null;

    if (body.trip_id) {
      // Legacy path: trip already exists. Eligibility stays ahead of trip reads.
      edgeTiming.markEligibilityStart();
      const bookingEligibility = await assertCanBookRide(supabaseClient, user.id);
      edgeTiming.markEligibilityEnd();
      if (!bookingEligibility.allowed) {
        logPassengerBookingBlocked("create-preauth-payment-intent", user.id, bookingEligibility);
        return passengerNotEligibleResponse(bookingEligibility, corsHeaders);
      }
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

      // Eligibility is a read gate. It overlaps quote/customer/gateway/offer
      // reads and still finishes before any payment session or provider order.
      edgeTiming.markEligibilityStart();
      const eligibilityP = assertCanBookRide(supabaseClient, user.id).finally(() => {
        edgeTiming.markEligibilityEnd();
      });
      const parallelStart = Date.now();
      const fareP = (async () => {
        const started = Date.now();
        if (opaqueQuoteId) {
          const row = await loadBookingPaymentQuote(supabaseClient, opaqueQuoteId);
          const ms = Date.now() - started;
          return { kind: "opaque" as const, row, ms };
        }
        const snapForQuote = body.booking_snapshot && typeof body.booking_snapshot === "object"
          ? body.booking_snapshot as Record<string, unknown>
          : null;
        const [serverQuote, pickupServiceArea] = await Promise.all([
          quoteFareServerSide({
            serviceAreaId: resolvedServiceAreaId,
            vehicleTypeId: typeof body.vehicle_type_id === "string" ? body.vehicle_type_id : null,
            bookingSnapshot: snapForQuote,
          }),
          resolveServiceAreaIdForPickup(
            supabaseClient,
            (snapForQuote?.pickup ?? null) as { lat?: unknown; lng?: unknown } | null,
          ),
        ]);
        return {
          kind: "estimate" as const,
          serverQuote,
          pickupServiceArea,
          ms: Date.now() - started,
        };
      })();
      const customerP = (async () => {
        const started = Date.now();
        const { data } = await supabaseClient
          .from("customers")
          .select("id, first_name, last_name")
          .eq("user_id", user.id)
          .maybeSingle();
        return { data, ms: Date.now() - started };
      })();
      const gatewayP = (async () => {
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
      })();
      // Offer needs the fare and customer id. On the opaque path the quote
      // total is the charge, so this read must not hold the response.
      const hasPersonalVoucher = Boolean(body.personal_voucher_code?.trim());
      const offerP = hasPersonalVoucher
        ? Promise.resolve(null)
        : (async () => {
          const [fareForOffer, customerForOffer] = await Promise.all([fareP, customerP]);
          const farePence = fareForOffer.kind === "opaque"
            ? (fareForOffer.row?.trip_fare_pence ?? 0)
            : (fareForOffer.serverQuote.ok ? fareForOffer.serverQuote.totalFarePence : 0);
          const offerCustomerId = customerForOffer.data?.id ?? user.id;
          if (!resolvedServiceAreaId || farePence <= 0) return null;
          edgeTiming.markOfferResolveStart();
          try {
            return await resolveBestOfferForTrip({
              admin: supabaseClient,
              serviceAreaId: resolvedServiceAreaId,
              estimatedFarePence: farePence,
              userId: user.id,
              customerId: offerCustomerId,
            });
          } catch (offerErr) {
            logStep("Offer resolution warning (non-fatal)", { error: String(offerErr) });
            return null;
          } finally {
            edgeTiming.markOfferResolveEnd();
          }
        })();
      const [bookingEligibility, fareSettled, customerSettled, gatewaySettled] =
        await Promise.all([eligibilityP, fareP, customerP, gatewayP]);
      if (!bookingEligibility.allowed) {
        logPassengerBookingBlocked("create-preauth-payment-intent", user.id, bookingEligibility);
        return passengerNotEligibleResponse(bookingEligibility, corsHeaders);
      }
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
        preloadedOpaqueQuote = fareSettled.row;
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
        const pickupSa = fareSettled.pickupServiceArea;
        if (!pickupSa.ok || pickupSa.serviceAreaId !== resolvedServiceAreaId) {
          logStep("SERVICE_AREA_PICKUP_MISMATCH", {
            requested_service_area_id: resolvedServiceAreaId,
            pickup_service_area_id: pickupSa.ok ? pickupSa.serviceAreaId : null,
            lookup_error: pickupSa.ok ? null : pickupSa.error,
          });
          return new Response(JSON.stringify({
            error: "We couldn't confirm the fare for this trip. Please refresh and try again.",
            error_code: SERVICE_AREA_MISMATCH,
            code: SERVICE_AREA_MISMATCH,
            charge_state: "no_charge",
          }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

      // Never trust a client-supplied discount.
      // Opaque quote: the frozen total is the charge. Offer metadata is
      // attached after the response so it cannot extend the preauth wall.
      // No-quote path: the offer changes the authorised amount, so it stays
      // on the wall.
      let appliedOfferId: string | null = null;
      let appliedOfferCode: string | null = null;
      let offerDiscountPence = 0;
      const deferOfferMetadata = fareSettled.kind === "opaque" && !hasPersonalVoucher;
      if (deferOfferMetadata) {
        edgeTiming.recordDiagnostic("edge_offer_deferred", true);
        const clientActionForOffer = body.client_action_id || "";
        const grossForOffer = grossFarePence;
        deferredOfferMetadata = async () => {
          const resolvedOffer = await offerP;
          if (!resolvedOffer || resolvedOffer.discountPence <= 0 || !clientActionForOffer) return;
          const discount = Math.min(resolvedOffer.discountPence, grossForOffer);
          const { data } = await supabaseClient
            .from("payment_sessions")
            .select("metadata")
            .eq("client_action_id", clientActionForOffer)
            .maybeSingle();
          const existing = data?.metadata && typeof data.metadata === "object"
            ? data.metadata as Record<string, unknown>
            : {};
          await supabaseClient
            .from("payment_sessions")
            .update({
              metadata: {
                ...existing,
                offer_discount_pence: String(discount),
                applied_offer_id: resolvedOffer.offerId,
                applied_offer_code: resolvedOffer.offerCode,
                offer_metadata_deferred: "true",
              },
              updated_at: new Date().toISOString(),
            })
            .eq("client_action_id", clientActionForOffer);
        };
      } else {
        const resolvedOffer = await offerP;
        if (resolvedOffer && resolvedOffer.discountPence > 0) {
          appliedOfferId = resolvedOffer.offerId;
          appliedOfferCode = resolvedOffer.offerCode;
          offerDiscountPence = Math.min(resolvedOffer.discountPence, grossFarePence);
        }
      }

      let appliedPersonalVoucherId: string | null = null;
      let appliedPersonalVoucherCode: string | null = null;
      let personalVoucherDiscountPence = 0;
      if (fareSettled.kind === "opaque" && fareSettled.row) {
        // The quote's trip fare already carries the server-resolved voucher.
        // Re-applying here would discount twice; a different voucher than the
        // one bound into the quote must re-quote.
        const quoteMeta = fareSettled.row.metadata ?? {};
        const boundCode = normalizePersonalVoucherCode(quoteMeta.applied_personal_voucher_code);
        const requestCode = normalizePersonalVoucherCode(body.personal_voucher_code);
        if (boundCode !== requestCode) {
          logStep("OPAQUE_QUOTE_VOUCHER_MISMATCH", {
            quote_id: opaqueQuoteId,
            quote_has_voucher: boundCode != null,
            request_has_voucher: requestCode != null,
          });
          return new Response(
            JSON.stringify(bookingPaymentQuoteErrorPayload(FARE_QUOTE_CHANGED, {
              note: "voucher_not_bound_to_quote",
            })),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (boundCode) {
          appliedPersonalVoucherId = String(quoteMeta.applied_personal_voucher_id ?? "") || null;
          appliedPersonalVoucherCode = boundCode;
        }
      } else if (body.personal_voucher_code?.trim()) {
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

    // Opaque quote already froze buffer. The settings read would be discarded
    // by resolvePreauthAmountsFromQuote. Currency remains a hard gate.
    edgeTiming.markBufferStart();
    edgeTiming.markCurrencyStart();
    let bufferPence: number;
    let bufferSource: Awaited<ReturnType<typeof resolvePreauthBuffer>>["source"];
    let regionCurrency: string;
    if (preloadedOpaqueQuote) {
      bufferPence = preloadedOpaqueQuote.buffer_pence;
      bufferSource = {
        service_area_id: resolvedServiceAreaId,
        enable_preauth_buffer: bufferPence > 0,
        buffer_type: "quote_row",
        buffer_value: bufferPence,
        min_hold_pence: null,
        max_hold_pence: null,
        config_table: "booking_payment_quotes",
      };
      edgeTiming.markBufferEnd();
      regionCurrency = await resolveRegionCurrency(
        supabaseClient,
        tripId,
        body.service_area_id || metadataExtra.service_area_id || null,
      );
      edgeTiming.markCurrencyEnd();
    } else {
      const resolved = await Promise.all([
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
      bufferPence = resolved[0].bufferPence;
      bufferSource = resolved[0].source;
      regionCurrency = resolved[1];
      edgeTiming.markBufferEnd();
      edgeTiming.markCurrencyEnd();
    }
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

      const preauthResponse = await createRevolutPreauthResponse({
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
        preloadedBookingPaymentQuote: preloadedOpaqueQuote,
        customerEmail: user.email,
        customerName: customerFullName,
        platformPaymentMethodId: body.payment_method_id ?? null,
        savePaymentMethod: body.save_payment_method === true,
        browserEnvironment: validatedBrowserEnvironment,
        bookingSnapshot:
          body.booking_snapshot && typeof body.booking_snapshot === "object"
            ? body.booking_snapshot as Record<string, unknown>
            : null,
        fareSnapshot: buildServerPreauthSessionFareSnapshot({
          estimatedTotalPence,
          authorisedAmountPence,
          bufferPence,
          metadataExtra,
          clientFareSnapshot:
            body.fare_snapshot && typeof body.fare_snapshot === "object"
              ? body.fare_snapshot as Record<string, unknown>
              : null,
        }),
        receivableConsent: extractReceivableConsentFromPreauthBody(
          body as Record<string, unknown>,
        ),
        corsHeaders,
        logStep,
        edgeTiming,
      });
      if (deferredOfferMetadata && preauthResponse.ok) {
        scheduleEdgeBackground(deferredOfferMetadata, "preauth_offer_metadata");
      }
      return preauthResponse;
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
