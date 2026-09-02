import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  calculateFare,
  buildRoutePricingApiFields,
  ZONE_ROUTE_PRICING_SELECT,
  FARE_PRICING_SETTINGS_QUOTE_SELECT,
  CUSTOM_ZONES_QUOTE_SELECT,
  zonesContainingPoint,
  type FarePricingRow,
  type ZoneRoutePricingRow,
  type ZoneRow,
  type LatLng,
} from "../_shared/pricing-engine.ts";
import { corsHeaders } from "../_shared/corsHeaders.ts";
import {
  classifyServiceAreaFinancialPairing,
  shouldSkipPlatformPreauthForCommissionWallet,
  type ServiceAreaCommissionWalletConfig,
} from "../_shared/commissionWalletSSOT.ts";
import {
  compareVehicleByDisplayOrder,
  resolveVehicleDisplayOrder,
  sortVehicleRowsByDisplayOrder,
} from "../_shared/vehicleTypeSort.ts";
import {
  applyZoneSurgeToMeteredFarePence,
  meteredFareEligibleForZoneSurge,
  parseRpcSurgeResolution,
  type SurgeResolution,
} from "../_shared/demandZoneSurgeSSOT.ts";

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: "£", USD: "$", EUR: "€", KES: "KSh", NGN: "₦",
  ZAR: "R", INR: "₹", AED: "AED", CAD: "CA$", AUD: "A$",
};

function formatPrice(amount: number | null | undefined, code: string): string {
  if (amount == null) return "—";
  const c = (code || "").toUpperCase();
  const sym = CURRENCY_SYMBOLS[c] || `${c} `;
  return `${sym}${amount.toFixed(2)}`;
}

interface CalculateFareRequest {
  service_area_id: string;
  estimated_distance_km: number;
  estimated_duration_min: number;
  vehicle_type_id?: string;
  pickup?: LatLng;
  dropoff?: LatLng;
  pickup_lat?: number;
  pickup_lng?: number;
  dropoff_lat?: number;
  dropoff_lng?: number;
  /** Ordered intermediate stops between pickup and dropoff. */
  stops?: LatLng[];
  intermediate_stops?: LatLng[];
  intermediateStops?: LatLng[];
}

type FareTimings = {
  total_edge_ms: number;
  service_area_region_ms: number;
  vehicle_pricing_ms: number;
  vehicle_types_assigned_ms: number;
  fare_settings_ms: number;
  vehicle_types_ms: number;
  custom_zones_ms: number;
  zone_route_pricing_ms: number;
  airport_charge_ms: number;
  surge_rpc_ms: number;
  fare_engine_ms: number;
  serialization_ms: number;
};

function parseLatLng(raw: unknown): LatLng | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const lat = Number(row.lat ?? row.latitude);
  const lng = Number(row.lng ?? row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function parseStopsList(body: CalculateFareRequest): LatLng[] {
  const raw = body.stops ?? body.intermediate_stops ?? body.intermediateStops ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map(parseLatLng).filter((p): p is LatLng => p != null);
}

async function timedMs<T>(
  run: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await run();
  return { value, ms: Date.now() - start };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const requestReceivedAt = Date.now();

  const respond = (status: number, payload: Record<string, unknown>) =>
    new Response(JSON.stringify(payload), {
      // Always 200 so the Supabase JS SDK doesn't swallow the error body.
      // Clients must branch on payload.success / payload.error.
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body: CalculateFareRequest = await req.json().catch(() => ({} as CalculateFareRequest));
    const { service_area_id, vehicle_type_id } = body;
    if (!service_area_id) {
      return respond(200, { success: false, error: "service_area_id is required", vehicleFares: [] });
    }

    const distanceKm = Math.max(Number(body.estimated_distance_km) || 0, 0);
    const durationMin = Math.max(Number(body.estimated_duration_min) || 0, 0);

    const pickup: LatLng | null =
      body.pickup ??
      (Number.isFinite(body.pickup_lat) && Number.isFinite(body.pickup_lng)
        ? { lat: body.pickup_lat as number, lng: body.pickup_lng as number }
        : null);
    const dropoff: LatLng | null =
      body.dropoff ??
      (Number.isFinite(body.dropoff_lat) && Number.isFinite(body.dropoff_lng)
        ? { lat: body.dropoff_lat as number, lng: body.dropoff_lng as number }
        : null);
    const stops = parseStopsList(body);

    console.log(
      `[calculate-fare] sa=${service_area_id} dist=${distanceKm}km dur=${durationMin}min pickup=${!!pickup} dropoff=${!!dropoff} stops=${stops.length}`,
    );

    // ── Wave A: everything known from request body (service_area_id / pickup) ──
    // SA+region remains required for currency/unit and region-scoped zones, but
    // SA-id-only catalogue/config/surge must not wait on it.
    const saPromise = timedMs(() =>
      supabase
        .from("service_areas")
        .select(
          "id, name, region_id, financial_model, commission_wallet_enabled, customer_payment_policy, regions!inner(id, name, currency_code, distance_unit)",
        )
        .eq("id", service_area_id)
        .maybeSingle()
        .then((r) => r),
    );

    const vehiclePricingPromise = timedMs(() =>
      supabase
        .from("service_area_vehicle_pricing")
        .select("vehicle_type_id, is_enabled")
        .eq("service_area_id", service_area_id)
        .eq("is_enabled", true)
        .then((r) => r),
    );

    const vehicleAssignedPromise = timedMs(() =>
      supabase
        .from("service_area_vehicle_types")
        .select("vehicle_type_id, display_order")
        .eq("service_area_id", service_area_id)
        .eq("is_active", true)
        .order("display_order", { ascending: true })
        .then((r) => r),
    );

    const airportPromise = timedMs(() =>
      supabase
        .from("service_area_pricing_settings")
        .select("airport_charge")
        .eq("service_area_id", service_area_id)
        .maybeSingle()
        .then((r) => r),
    );

    const routesPromise = timedMs(() =>
      supabase
        .from("zone_route_pricing")
        .select(ZONE_ROUTE_PRICING_SELECT)
        .eq("is_active", true)
        .or(`service_area_id.eq.${service_area_id},service_area_id.is.null`)
        .then((r) => r),
    );

    // Surge RPC only needs service_area_id + pickup — independent of zone table load.
    const surgePromise = pickup
      ? timedMs(() =>
        supabase.rpc("resolve_zone_surge", {
          _service_area_id: service_area_id,
          _pickup_lat: pickup.lat,
          _pickup_lng: pickup.lng,
        }).then((r) => r)
      )
      : Promise.resolve({
        value: { data: null, error: null },
        ms: 0,
      });

    // Fare settings for the whole SA — filter to enabled vehicles in memory.
    const fareSettingsPromise = timedMs(() =>
      supabase
        .from("fare_pricing_settings")
        .select(FARE_PRICING_SETTINGS_QUOTE_SELECT)
        .eq("service_area_id", service_area_id)
        .then((r) => r),
    );

    const saTimed = await saPromise;
    const { data: saRow, error: saErr } = saTimed.value;
    if (saErr) throw new Error(saErr.message);
    if (!saRow) {
      return respond(200, { success: false, error: "Service area not found", vehicleFares: [] });
    }

    const regionId = (saRow as Record<string, unknown>).region_id as string;

    // Region-dependent: custom zones (SA or region). Start as soon as region_id is known.
    const zonesPromise = timedMs(() =>
      supabase
        .from("custom_zones")
        .select(CUSTOM_ZONES_QUOTE_SELECT)
        .eq("is_active", true)
        .or(`service_area_id.eq.${service_area_id},region_id.eq.${regionId}`)
        .then((r) => r),
    );

    // Overlap global vehicle_types fetch with zones / fare_settings / surge.
    const vehicleCataloguePromise = (async () => {
      const [vehiclePricingTimed, vehicleAssignedTimed] = await Promise.all([
        vehiclePricingPromise,
        vehicleAssignedPromise,
      ]);
      const { data: pricingRows, error: pricingRowsErr } = vehiclePricingTimed.value;
      const { data: assignedVtRows, error: assignedVtErr } = vehicleAssignedTimed.value;
      if (pricingRowsErr) throw new Error(pricingRowsErr.message);
      if (assignedVtErr) throw new Error(assignedVtErr.message);

      const pricingEnabledIds = new Set(
        (pricingRows || [])
          .map((r: Record<string, unknown>) => r.vehicle_type_id as string)
          .filter(Boolean),
      );
      const assignedDisplayOrder = new Map<string, number>();
      const assignedActiveIds: string[] = [];
      for (const row of assignedVtRows || []) {
        const r = row as Record<string, unknown>;
        const vtId = r.vehicle_type_id as string;
        if (!vtId) continue;
        assignedActiveIds.push(vtId);
        assignedDisplayOrder.set(vtId, (r.display_order as number) ?? 999);
      }
      const pricingVehicleIds = (
        assignedActiveIds.length > 0
          ? assignedActiveIds.filter((id) => pricingEnabledIds.has(id))
          : Array.from(pricingEnabledIds)
      );

      if (pricingVehicleIds.length === 0) {
        return {
          vehiclePricingTimed,
          vehicleAssignedTimed,
          pricingVehicleIds,
          assignedDisplayOrder,
          vehicleTypesTimed: { value: { data: [], error: null }, ms: 0 },
        };
      }

      const vehicleTypesTimed = await timedMs(() =>
        supabase
          .from("vehicle_types")
          .select("id, slug, name, description, icon, capacity, display_order, is_active")
          .in("id", pricingVehicleIds)
          .order("display_order", { ascending: true })
          .then((r) => r),
      );
      return {
        vehiclePricingTimed,
        vehicleAssignedTimed,
        pricingVehicleIds,
        assignedDisplayOrder,
        vehicleTypesTimed,
      };
    })();

    const [
      catalogue,
      airportTimed,
      routesTimed,
      surgeTimed,
      fareSettingsTimed,
      zonesTimed,
    ] = await Promise.all([
      vehicleCataloguePromise,
      airportPromise,
      routesPromise,
      surgePromise,
      fareSettingsPromise,
      zonesPromise,
    ]);

    const {
      pricingVehicleIds,
      assignedDisplayOrder,
      vehicleTypesTimed,
      vehiclePricingTimed,
      vehicleAssignedTimed,
    } = catalogue;

    const joinedRegion = saRow.regions as unknown;
    const region = (Array.isArray(joinedRegion) ? joinedRegion[0] : joinedRegion) as Record<string, unknown> | undefined;
    const currencyCode = region?.currency_code as string;
    const saConfig: ServiceAreaCommissionWalletConfig = {
      financial_model: (saRow as { financial_model?: string | null }).financial_model,
      commission_wallet_enabled: (saRow as { commission_wallet_enabled?: boolean | null })
        .commission_wallet_enabled,
      customer_payment_policy: (saRow as { customer_payment_policy?: string | null })
        .customer_payment_policy,
    };
    const saPairing = classifyServiceAreaFinancialPairing(saConfig);
    const skipPlatformPreauth = shouldSkipPlatformPreauthForCommissionWallet(saConfig);
    const financialModel = saPairing.ok ? saPairing.financial_model : null;
    const distanceUnit = region?.distance_unit as string;
    if (!currencyCode || !distanceUnit) {
      return respond(200, {
        success: false,
        error: "Region configuration incomplete — missing currency or distance unit.",
        vehicleFares: [],
      });
    }

    if (pricingVehicleIds.length === 0) {
      return new Response(JSON.stringify({
        success: false, vehicleFares: [], currencyCode, distanceUnit,
        message: "No active vehicle pricing configured for this service area.",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: vtRows, error: vtErr } = vehicleTypesTimed.value;
    if (vtErr) throw new Error(vtErr.message);

    const { data: fareRows, error: fareErr } = fareSettingsTimed.value;
    if (fareErr) throw new Error(fareErr.message);

    const { data: zonesData, error: zonesErr } = zonesTimed.value;
    if (zonesErr) throw new Error(zonesErr.message);

    const { data: routesData, error: routesErr } = routesTimed.value;
    if (routesErr) {
      console.warn("[calculate-fare] zone_route_pricing query failed (using empty routes):", routesErr.message);
    }

    const { data: saPricingData, error: saPricingErr } = airportTimed.value;
    if (saPricingErr) {
      console.warn(
        "[calculate-fare] service_area_pricing_settings query failed (airport charge defaults to 0):",
        saPricingErr.message,
      );
    }

    const fareMap = new Map<string, FarePricingRow>();
    const pricingIdSet = new Set(pricingVehicleIds);
    for (const row of (fareRows || []) as FarePricingRow[]) {
      const id = row.vehicle_type_id as unknown as string;
      if (id && pricingIdSet.has(id)) fareMap.set(id, row);
    }
    const vtMap = new Map<string, Record<string, unknown>>();
    for (const v of (vtRows || []) as Record<string, unknown>[]) {
      if (v.id) vtMap.set(v.id as string, v);
    }
    const zones = (zonesData || []) as unknown as ZoneRow[];
    const zoneRoutes = (routesData || []) as unknown as ZoneRoutePricingRow[];
    const serviceAreaPricingSettings =
      (saPricingData as Record<string, unknown> | null) ?? null;

    console.log(
      `[calculate-fare] zones=${zones.length} routes=${zoneRoutes.length}`,
    );

    let surgeResolution: SurgeResolution = {
      zone_id: null,
      confirmed_demand_level: null,
      applied_multiplier: 1,
      surge_enabled: false,
      reason: "NO_SETTINGS",
    };
    const surgeIssuedAtMs = Date.now();
    if (pickup) {
      const { data: surgeData, error: surgeErr } = surgeTimed.value;
      if (surgeErr) {
        console.error("[calculate-fare] resolve_zone_surge failed:", surgeErr.message);
        return respond(200, {
          success: false,
          error: "SURGE_RESOLUTION_FAILED",
          vehicleFares: [],
        });
      }
      surgeResolution = parseRpcSurgeResolution(surgeData);
    }

    // Zone containment once per quote (not once per vehicle).
    const pickupContainingZones = pickup ? zonesContainingPoint(pickup, zones) : [];
    const dropoffContainingZones = dropoff ? zonesContainingPoint(dropoff, zones) : [];

    const orderedVehicleIds = sortVehicleRowsByDisplayOrder(
      pricingVehicleIds
        .filter((id) => vtMap.has(id) && vtMap.get(id)?.is_active !== false)
        .map((vtId) => ({
          id: vtId,
          name: String(vtMap.get(vtId)?.name ?? ""),
          displayOrder: resolveVehicleDisplayOrder({
            vehicleTypeId: vtId,
            assignedDisplayOrder,
            vehicleDisplayOrder: vtMap.get(vtId)?.display_order as number | null | undefined,
          }),
        })),
    ).map((row) => row.id);

    const engineStart = Date.now();
    const vehicleFares = orderedVehicleIds
      .filter((id) => !vehicle_type_id || id === vehicle_type_id)
      .map((vtId) => {
        const vehicle = vtMap.get(vtId);
        if (!vehicle || vehicle.is_active === false) return null;
        const displayOrder = resolveVehicleDisplayOrder({
          vehicleTypeId: vtId,
          assignedDisplayOrder,
          vehicleDisplayOrder: vehicle.display_order as number | null | undefined,
        });
        const pricing = fareMap.get(vtId);
        if (!pricing) {
          return {
            vehicleTypeId: vtId,
            slug: (vehicle?.slug as string) || vtId,
            name: (vehicle?.name as string) || "Unknown vehicle",
            description: (vehicle?.description as string) || "",
            icon: (vehicle?.icon as string) || "car",
            capacity: vehicle?.capacity ?? null,
            displayOrder,
            hasFareConfig: false,
            fare: null,
            breakdown: null,
          };
        }

        const pricingForEngine = {
          ...pricing,
          enable_surge: false,
        };

        const breakdown = calculateFare({
          pricing: pricingForEngine,
          distanceKm,
          durationMin,
          pickup,
          dropoff,
          stops,
          zones,
          zoneRoutes,
          serviceAreaId: service_area_id,
          serviceAreaPricingSettings,
          vehicleTypeId: vtId,
          distanceUnit,
          pickupContainingZones,
          dropoffContainingZones,
        });

        let totalFarePence = breakdown.final_fare_pence;
        let totalFare = breakdown.final_fare;
        let surgeQuote: ReturnType<typeof applyZoneSurgeToMeteredFarePence>["surgeQuote"] | null = null;
        let appliedSurgeMultiplier = 1;

        if (
          pickup
          && meteredFareEligibleForZoneSurge(breakdown.fare_source, breakdown.pricing_mode)
        ) {
          const surged = applyZoneSurgeToMeteredFarePence({
            tripFarePence: Math.round(breakdown.trip_fare * 100),
            airportChargePence: Math.round(breakdown.airport_charge * 100),
            surgeResolution,
            serviceAreaId: service_area_id,
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            issuedAtMs: surgeIssuedAtMs,
          });
          totalFarePence = surged.finalFarePence;
          totalFare = totalFarePence / 100;
          surgeQuote = surged.surgeQuote;
          appliedSurgeMultiplier = surged.appliedMultiplier;
        }

        const vehicleCategory = (vehicle?.name as string) || (vehicle?.slug as string) || null;
        const routePricingFields = buildRoutePricingApiFields(breakdown, vehicleCategory);

        // Backwards-compatible "fare" object the customer app already consumes.
        const fare = {
          ...routePricingFields,
          fareEngineMode: String(pricing.pricing_mode || "fixed"),
          tripPricingMode: breakdown.pricing_mode,
          // Authoritative selector — UI must branch on this.
          fareSource: breakdown.fare_source,
          routeMatch: breakdown.route_match,
          matchedRouteId: breakdown.matched_route_id,
          baseFare: breakdown.base_fare,
          baseFareFormatted: formatPrice(breakdown.base_fare, currencyCode),
          distanceCost: breakdown.distance_cost,
          distanceCostFormatted: formatPrice(breakdown.distance_cost, currencyCode),
          timeCost: breakdown.time_cost,
          timeCostFormatted: formatPrice(breakdown.time_cost, currencyCode),
          bookingFee: breakdown.booking_fee,
          bookingFeeFormatted: formatPrice(breakdown.booking_fee, currencyCode),
          totalFare,
          totalFareFormatted: formatPrice(totalFare, currencyCode),
          totalFarePence,
          minimumFare: breakdown.minimum_fare,
          minimumFareFormatted: formatPrice(breakdown.minimum_fare, currencyCode),
          multiplier: breakdown.multiplier,
          perKmRate: breakdown.per_km_rate,
          perKmRateFormatted: formatPrice(breakdown.per_km_rate, currencyCode),
          perMinRate: breakdown.per_min_rate,
          perMinRateFormatted: formatPrice(breakdown.per_min_rate, currencyCode),
          tripFare: breakdown.trip_fare,
          tripFareFormatted: formatPrice(breakdown.trip_fare, currencyCode),
          airportCharge: breakdown.airport_charge,
          airportChargeFormatted: formatPrice(breakdown.airport_charge, currencyCode),
          airportChargeSource: breakdown.airport_charge_source,
          airportPickupFee: breakdown.airport_pickup_fee || 0,
          airportDropoffFee: breakdown.airport_dropoff_fee || 0,
          fareDetails: breakdown.fare_details,
          surcharge: breakdown.surcharge,
          zoneApplied: breakdown.zone_applied,
          fixedFareApplied: breakdown.fixed_fare_applied,
          distancePricingMode: breakdown.distance_pricing_mode,
          distanceBandSummary: breakdown.distance_band_summary,
          distanceBands: breakdown.distance_bands,
          minimumApplied: breakdown.minimum_applied,
          subtotalBeforeMinimum: breakdown.subtotal_before_minimum,
          grossFarePence: totalFarePence,
          finalPayableFarePence: totalFarePence,
          surge_multiplier: appliedSurgeMultiplier,
          appliedSurgeMultiplier,
          surge_quote: surgeQuote,
        };

        return {
          vehicleTypeId: vtId,
          slug: (vehicle?.slug as string) || vtId,
          name: (vehicle?.name as string) || "Unknown vehicle",
          description: (vehicle?.description as string) || "",
          icon: (vehicle?.icon as string) || "car",
          capacity: vehicle?.capacity ?? null,
          displayOrder,
          isVehicleTypeActive: (vehicle?.is_active as boolean | undefined) ?? null,
          hasFareConfig: true,
          fare,
          breakdown, // canonical engine breakdown
        };
      })
      .filter((row): row is NonNullable<typeof row> => row != null);

    vehicleFares.sort((a, b) =>
      compareVehicleByDisplayOrder(
        { displayOrder: a.displayOrder, name: a.name },
        { displayOrder: b.displayOrder, name: b.name },
      )
    );
    const fareEngineMs = Date.now() - engineStart;

    const timings: FareTimings = {
      total_edge_ms: 0, // filled after serialize
      service_area_region_ms: saTimed.ms,
      vehicle_pricing_ms: vehiclePricingTimed.ms,
      vehicle_types_assigned_ms: vehicleAssignedTimed.ms,
      fare_settings_ms: fareSettingsTimed.ms,
      vehicle_types_ms: vehicleTypesTimed.ms,
      custom_zones_ms: zonesTimed.ms,
      zone_route_pricing_ms: routesTimed.ms,
      airport_charge_ms: airportTimed.ms,
      surge_rpc_ms: surgeTimed.ms,
      fare_engine_ms: fareEngineMs,
      serialization_ms: 0,
    };

    const serializeStart = Date.now();
    const payload = {
      success: true,
      serviceAreaId: service_area_id,
      serviceAreaName: saRow.name,
      currencyCode,
      distanceUnit,
      financial_model: financialModel,
      skip_platform_preauth: skipPlatformPreauth,
      demand_surge: surgeResolution,
      vehicleFares,
      timings: null as FareTimings | null,
    };
    timings.serialization_ms = Date.now() - serializeStart;
    timings.total_edge_ms = Date.now() - requestReceivedAt;
    payload.timings = timings;

    console.log("[calculate-fare] timings", timings);

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("[calculate-fare] Error:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    // Return 200 so the Supabase JS SDK exposes the error body to the client.
    return new Response(JSON.stringify({
      success: false,
      error: msg,
      vehicleFares: [],
      airportCharge: 0,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
