/**
 * Fetch per-driver wallet/payout snapshot from distinct SSOT sources (server I/O).
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type Stripe from "https://esm.sh/stripe@14.21.0";
import { computeLedgerWalletBalancePence, computeCashCommissionOutstanding } from "./onecabFinanceLedger.ts";
import {
  computeDriverWalletPayoutSnapshot,
  sumIncludedInPayoutBatchPence,
  sumStripePaidOutFromConnectPayouts,
  type DriverWalletPayoutSnapshot,
} from "./driverWalletPayoutSSOT.ts";
import {
  computeFrDriverReconciliation,
  type FrDriverReconciliationRow,
  type ProviderAccountBalanceStatus,
} from "./frDriverReconciliationSSOT.ts";
import {
  buildDriverWalletPeriodKpis,
  type DriverWalletPeriodKpis,
} from "./driverWalletPeriodKpisSSOT.ts";
import { fetchDriverPayoutEligibility } from "./fetchDriverPayoutEligibility.ts";
import { buildDriverWalletSettlementHistory } from "./driverWalletSettlementHistorySSOT.ts";
import { buildDriverWalletDebtRecoveryKpis } from "./driverWalletDebtRecoverySSOT.ts";
import { nextWeeklyPayoutDateIso } from "./payoutScheduleSSOT.ts";
import { buildPayoutScheduleDto } from "./payoutScheduleSSOT.ts";
import { loadPayoutControlCentreSettings } from "./payoutControlCentreSettingsSSOT.ts";
import {
  attachRunningNetOnecabBalanceNewestFirst,
  buildCommissionFeeBreakdownRow,
  summarizeCommissionFeeRows,
} from "./driverWalletCommissionFeeSSOT.ts";

const TERMINAL_FAILED = new Set(["failed", "ledger_sync_failed", "failed_duplicate"]);
const STUCK_SETTLEMENT = new Set(["PROCESSING", "READY", "PENDING", "AVAILABLE"]);

export type DriverWalletPayoutDetail = Omit<
  DriverWalletPayoutSnapshot,
  "reconciliation_status" | "reconciliation_reasons"
> & FrDriverReconciliationRow & {
  driver_id: string;
  user_id: string | null;
  driver_code: string | null;
  driver_name: string | null;
  connected_account_id: string | null;
  verification_status: string | null;
  bank_account_last4: string | null;
  payouts_enabled: boolean | null;
  last_payout_at: string | null;
  last_payout_amount_pence: number | null;
  /** Wallet account identity — owned by Driver Wallet Ledger. */
  driver_tier_name: string | null;
  commission_percent: number | null;
  service_area_id: string | null;
  service_area_name: string | null;
  payout_provider: string | null;
  next_scheduled_payout_at: string | null;
  wallet_status: "ACTIVE" | "FROZEN" | "NOT_CONNECTED" | "RESTRICTED";
  payout_items: Array<Record<string, unknown>>;
  early_cashouts: Array<Record<string, unknown>>;
  stripe_connect_payouts: Array<Record<string, unknown>>;
  settlements: Array<Record<string, unknown>>;
  /** One row per completed trip settlement — consume-only display DTO. */
  settlement_history: Array<Record<string, unknown>>;
  debt_recovery: {
    outstanding_debt_pence: number;
    recovered_amount_pence: number;
    remaining_debt_pence: number;
    recovery_percent: number | null;
  };
  /** Gross / provider fee / net — provider fee is never ONECAB revenue. */
  commission_fee_breakdown: Array<Record<string, unknown>>;
  commission_fee_summary: {
    gross_onecab_commission_pence: number;
    payment_provider_fees_pence: number;
    net_onecab_commission_pence: number;
    transaction_count: number;
  };
  active_provider_fee_config: Record<string, unknown> | null;
  ledger_rows: Array<Record<string, unknown>>;
  transfer_ledger_rows: Array<Record<string, unknown>>;
  last_synced_at: string | null;
  period_kpis: DriverWalletPeriodKpis;
  /** Alias for provider account balance (reference-only). */
  provider_account_balance_pence: number | null;
};

export async function fetchDriverWalletPayoutSnapshot(
  supabase: SupabaseClient,
  args: {
    driverId: string;
    stripe?: Stripe | null;
    currency?: string;
  },
): Promise<DriverWalletPayoutDetail> {
  const currency = (args.currency ?? "gbp").toLowerCase();
  const syncedAt = new Date().toISOString();

  const { data: driver } = await supabase
    .from("drivers")
    .select("id, user_id, driver_code, first_name, last_name, stripe_account_id, payouts_enabled, charges_enabled, onboarding_complete, region_id, category_id, driver_categories(name)")
    .eq("id", args.driverId)
    .maybeSingle();

  const [
    fullLedgerRes,
    recentLedgerRes,
    transferLedgerRes,
    settlementsRes,
    payoutItemsRes,
    stripePayoutsRes,
    earlyCashoutsRes,
    driverServiceAreaRes,
    payoutEligibility,
  ] = await Promise.all([
    supabase.from("driver_wallet_ledger").select("type, amount_pence, stripe_payout_id, created_at, related_trip_id")
      .eq("driver_id", args.driverId),
    supabase.from("driver_wallet_ledger").select("id, type, amount_pence, related_trip_id, stripe_payout_id, stripe_transfer_id, created_at, description")
      .eq("driver_id", args.driverId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("driver_wallet_ledger").select("id, type, amount_pence, related_trip_id, stripe_payout_id, stripe_transfer_id, created_at")
      .eq("driver_id", args.driverId)
      .not("stripe_transfer_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("driver_earning_settlement")
      .select("id, trip_id, settlement_status, settlement_lifecycle_status, settled_at, allocated_to_payout, allocated_amount_pence, paid_in_payout_item_id, paid_in_batch_id, driver_wallet_ledger!inner(amount_pence)")
      .eq("driver_id", args.driverId),
    supabase.from("payout_items")
      .select("id, batch_id, status, settlement_status, net_driver_payout_pence, amount_pence, stripe_transfer_id, stripe_payout_id, failure_reason, created_at, updated_at")
      .eq("driver_id", args.driverId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("stripe_connect_payouts")
      .select("*")
      .eq("driver_id", args.driverId)
      .order("initiated_at", { ascending: false })
      .limit(50),
    supabase.from("driver_early_cashouts")
      .select("id, status, requested_cashout_pence, early_cashout_fee_pence, driver_receives_pence, created_at, updated_at, paid_at, stripe_payout_id, failure_reason")
      .eq("driver_id", args.driverId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("driver_service_areas")
      .select("service_area_id, service_areas(id, name, driver_payout_gateway, payment_provider)")
      .eq("driver_id", args.driverId)
      .limit(1)
      .maybeSingle(),
    fetchDriverPayoutEligibility(supabase, { driver_id: args.driverId }),
  ]);

  const ledger = fullLedgerRes.data ?? [];
  const recentLedger = recentLedgerRes.data ?? [];
  const transferLedger = transferLedgerRes.data ?? [];
  const walletBalance = computeLedgerWalletBalancePence(ledger);
  const recoveryDebt = computeCashCommissionOutstanding(ledger);

  const settlements = settlementsRes.data ?? [];
  const settlementTripIds = [...new Set(
    settlements.map((s) => String(s.trip_id ?? "")).filter(Boolean),
  )];
  const tripMetaById = new Map<string, {
    payment_method: string | null;
    payment_provider: string | null;
    final_customer_fare_pence: number | null;
  }>();
  const tripDetailById = new Map<string, Record<string, unknown>>();
  const sessionByTripId = new Map<string, Record<string, unknown>>();
  if (settlementTripIds.length > 0) {
    const [tripRowsRes, sessionRowsRes] = await Promise.all([
      supabase
        .from("trips")
        .select(
          "id, trip_code, completed_at, passenger_name, payment_status, final_customer_fare_pence, payment_method, payment_provider, provider_fee_pence, commission_pence, platform_commission_amount, driver_tier_commission_percent, driver_net_pence, payment_session_id, provider_payment_id, service_area_id",
        )
        .in("id", settlementTripIds),
      supabase
        .from("payment_sessions")
        .select(
          "id, trip_id, captured_amount_pence, payment_provider, payment_method, provider_processing_fee_pence, fee_status, provider_order_id, provider_payment_id, provider_fee_percentage_snapshot_pence, provider_fixed_fee_snapshot_pence, provider_fee_total_snapshot_pence, provider_fee_currency_snapshot, provider_fee_version_snapshot, provider_fee_source, provider_fee_confirmed_at, provider_name_snapshot",
        )
        .in("trip_id", settlementTripIds),
    ]);
    for (const t of tripRowsRes.data ?? []) {
      tripMetaById.set(String(t.id), {
        payment_method: (t.payment_method as string | null) ?? null,
        payment_provider: (t.payment_provider as string | null) ?? null,
        final_customer_fare_pence: t.final_customer_fare_pence == null
          ? null
          : Number(t.final_customer_fare_pence),
      });
      tripDetailById.set(String(t.id), t as Record<string, unknown>);
    }
    for (const s of sessionRowsRes.data ?? []) {
      const tripId = String(s.trip_id ?? "");
      if (!tripId) continue;
      // Prefer the session with a confirmed capture when multiple exist.
      const existing = sessionByTripId.get(tripId);
      const existingCap = Number(existing?.captured_amount_pence ?? 0);
      const nextCap = Number(s.captured_amount_pence ?? 0);
      if (!existing || nextCap > existingCap) {
        sessionByTripId.set(tripId, s as Record<string, unknown>);
      }
    }
    for (const [tripId, session] of sessionByTripId) {
      const meta = tripMetaById.get(tripId);
      if (!meta) continue;
      const sessionProvider = (session.payment_provider as string | null) ?? null;
      if (!meta.payment_provider && sessionProvider) {
        tripMetaById.set(tripId, { ...meta, payment_provider: sessionProvider });
      }
    }
  }
  // Canonical cleared = eligibility eligible earnings only (DES optional — never DES fallback invent).
  const financeCleared = Math.max(0, payoutEligibility.eligible_earnings_pence);
  // Canonical pending = live − available (same as Payout Ledger). Never cleared−batch.
  const canonicalPending = Math.max(0, payoutEligibility.pending_balance_pence);

  const payoutItems = payoutItemsRes.data ?? [];
  const includedBatch = sumIncludedInPayoutBatchPence(payoutItems);

  const stripePayouts = stripePayoutsRes.data ?? [];
  const stripePaidOut = sumStripePaidOutFromConnectPayouts(stripePayouts);

  const earlyCashouts = earlyCashoutsRes.data ?? [];
  const inFlight = earlyCashouts
    .filter((r) => ["pending", "processing", "transfer_created"].includes(String(r.status ?? "").toLowerCase()))
    .reduce((s, r) => s + Math.max(0, Number(r.requested_cashout_pence ?? 0)), 0);

  let connectAvailable: number | null = null;
  let connectPending: number | null = null;
  let connectInstant: number | null = null;
  let connectInTransit: number | null = null;
  // P0: Provider Account Balance from Stripe Connect permanently retired from live finance.
  // Never call stripe.balance.retrieve for FR / DWL / PL.
  let providerBalanceStatus: ProviderAccountBalanceStatus = "NOT_APPLICABLE";
  void args.stripe;
  void currency;

  const stripePayoutIds = new Set(
    stripePayouts.map((r) => String(r.payout_id ?? "")).filter(Boolean),
  );
  const ledgerStripePayoutIds = new Set(
    ledger.filter((r) => r.stripe_payout_id).map((r) => String(r.stripe_payout_id)),
  );

  let stripeWithoutLedger = 0;
  for (const sp of stripePayouts) {
    const pid = String(sp.payout_id ?? "");
    if (pid && !ledgerStripePayoutIds.has(pid) && String(sp.status).toLowerCase() === "paid") {
      stripeWithoutLedger += Math.max(0, Number(sp.amount_pence ?? 0));
    }
  }

  let ledgerWithoutStripe = 0;
  for (const row of ledger) {
    const pid = row.stripe_payout_id ? String(row.stripe_payout_id) : "";
    if (pid && !stripePayoutIds.has(pid) && (row.amount_pence ?? 0) < 0) {
      ledgerWithoutStripe += Math.abs(row.amount_pence ?? 0);
    }
  }

  let localFailed = 0;
  let stuckProcessing = 0;
  for (const item of payoutItems) {
    const st = String(item.status ?? "").toLowerCase();
    const net = Math.max(0, Number(item.net_driver_payout_pence ?? item.amount_pence ?? 0));
    const hasStripe = Boolean(item.stripe_transfer_id || item.stripe_payout_id);
    if (TERMINAL_FAILED.has(st) && !hasStripe) {
      localFailed += net;
      const ss = String(item.settlement_status ?? "");
      if (STUCK_SETTLEMENT.has(ss)) stuckProcessing += net;
    }
  }

  let providerAvailable: number | null = null;
  // P0: platform Stripe balance retrieve retired from live DWL snapshot.
  void providerAvailable;

  const saJoinEarly = driverServiceAreaRes.data?.service_areas as
    | {
      id?: string;
      name?: string;
      driver_payout_gateway?: string | null;
      payment_provider?: string | null;
    }
    | {
      id?: string;
      name?: string;
      driver_payout_gateway?: string | null;
      payment_provider?: string | null;
    }[]
    | null;
  const serviceAreaEarly = Array.isArray(saJoinEarly) ? saJoinEarly[0] ?? null : saJoinEarly;
  const payoutProviderEarlyRaw = serviceAreaEarly?.driver_payout_gateway
    ?? (String(serviceAreaEarly?.payment_provider ?? "").toLowerCase() === "stripe"
      ? null
      : serviceAreaEarly?.payment_provider)
    ?? null;
  const payoutProviderEarly = String(payoutProviderEarlyRaw ?? "").toLowerCase() === "stripe"
    ? null
    : payoutProviderEarlyRaw;
  const inferredRevolut = [...tripMetaById.values()].some((m) =>
    String(m.payment_provider ?? "").toLowerCase() === "revolut"
  );
  const payoutProviderResolved = payoutProviderEarly
    ?? (inferredRevolut ? "revolut" : null);

  const snapshot = computeDriverWalletPayoutSnapshot({
    wallet_balance_pence: walletBalance,
    finance_cleared_pence: financeCleared,
    included_in_payout_batch_pence: includedBatch,
    stripe_connect_available_pence: connectAvailable,
    stripe_connect_pending_pence: connectPending,
    stripe_in_transit_pence: connectInTransit,
    stripe_connect_instant_available_pence: connectInstant,
    stripe_paid_out_total_pence: stripePaidOut,
    recovery_debt_pence: recoveryDebt,
    in_flight_cashout_pence: inFlight,
    payout_blocked: walletBalance < 0 || driver?.payouts_enabled === false,
    instant_payout_enabled_by_stripe: driver?.charges_enabled !== false,
    stripe_payout_without_ledger_debit_pence: stripeWithoutLedger,
    ledger_debit_without_stripe_payout_pence: ledgerWithoutStripe,
    local_only_failed_payout_pence: localFailed,
    failed_payout_stuck_processing_pence: stuckProcessing,
    provider_platform_available_pence: null,
    payout_provider: payoutProviderResolved,
  });

  const canonicalAvailable = Math.max(
    0,
    snapshot.payout_blocked ? 0 : payoutEligibility.available_balance_pence,
  );

  const driverName = driver
    ? `${String(driver.first_name ?? "").trim()} ${String(driver.last_name ?? "").trim()}`.trim() || null
    : null;

  const lastPaidPayout = [...stripePayouts]
    .filter((row) => {
      const st = String(row.status ?? "").toLowerCase();
      return st === "paid" || st === "in_transit" || st === "pending";
    })
    .sort((a, b) => {
      const aTs = new Date(String(a.initiated_at ?? a.arrival_date ?? 0)).getTime();
      const bTs = new Date(String(b.initiated_at ?? b.arrival_date ?? 0)).getTime();
      return bTs - aTs;
    })[0] ?? null;

  const bankLast4 = [...stripePayouts]
    .map((r) => (r.bank_last4 == null ? null : String(r.bank_last4)))
    .find((v) => v && v.length > 0) ?? null;

  let verificationStatus: string | null = null;
  const isRevolutPayout = String(payoutProviderResolved ?? "").toLowerCase() === "revolut";
  if (isRevolutPayout) {
    // Manual bank / Revolut Business — Connect ID is not required.
    if (driver?.payouts_enabled === false) verificationStatus = "restricted";
    else if (driver?.payouts_enabled !== false) verificationStatus = "manual_bank";
    else verificationStatus = "pending";
  } else if (!driver?.stripe_account_id) {
    verificationStatus = "not_set";
  } else if (driver.payouts_enabled && driver.onboarding_complete) {
    verificationStatus = "verified";
  } else if (driver.onboarding_complete || driver.charges_enabled) {
    verificationStatus = "restricted";
  } else {
    verificationStatus = "pending";
  }

  const settledTripsForFr: Array<{
    trip_id: string | null;
    driver_net_pence: number | null;
    settlement_status?: string | null;
  }> = [...tripDetailById.values()].map((trip) => ({
    trip_id: String(trip.id ?? ""),
    driver_net_pence: trip.driver_net_pence == null ? null : Number(trip.driver_net_pence),
    settlement_status: "settled",
  }));
  if (settledTripsForFr.length === 0 && settlements.length > 0) {
    for (const s of settlements) {
      const tripId = s.trip_id == null ? null : String(s.trip_id);
      const ledgerJoin = s.driver_wallet_ledger as { amount_pence?: number } | { amount_pence?: number }[] | null;
      const ledgerAmt = Array.isArray(ledgerJoin)
        ? Number(ledgerJoin[0]?.amount_pence ?? 0)
        : Number(ledgerJoin?.amount_pence ?? 0);
      settledTripsForFr.push({
        trip_id: tripId,
        driver_net_pence: Number.isFinite(ledgerAmt) ? ledgerAmt : null,
        settlement_status: (s.settlement_status as string | null) ?? null,
      });
    }
  }

  // Revolut bank destination can verify without Connect.
  const accountVerified = verificationStatus === "verified"
    || (String(payoutProviderResolved ?? "").toLowerCase() === "revolut"
      && driver?.payouts_enabled !== false);

  if (
    String(payoutProviderResolved ?? "").toLowerCase() === "revolut"
    && providerBalanceStatus === "UNAVAILABLE"
    && !driver?.stripe_account_id
  ) {
    providerBalanceStatus = "NOT_APPLICABLE";
  }

  const frRow = computeFrDriverReconciliation({
    ledger: ledger.map((r) => ({
      type: String(r.type ?? ""),
      amount_pence: Number(r.amount_pence ?? 0),
    })),
    settledTrips: settledTripsForFr,
    completedPayoutItems: payoutItems.map((p) => ({
      status: (p.status as string | null) ?? null,
      net_driver_payout_pence: p.net_driver_payout_pence == null
        ? null
        : Number(p.net_driver_payout_pence),
      amount_pence: p.amount_pence == null ? null : Number(p.amount_pence),
    })),
    walletEvidenceAvailable: fullLedgerRes.error == null,
    settlementEvidenceAvailable: settlementsRes.error == null,
    identityMappingValid: Boolean(driver?.id),
    accountVerified,
    payout_provider: payoutProviderResolved,
    finance_cleared_pence: financeCleared,
    in_flight_cashout_pence: inFlight,
    recovery_debt_pence: recoveryDebt,
    payout_blocked: snapshot.payout_blocked,
    provider_account_balance_pence: connectAvailable,
    provider_account_balance_status: providerBalanceStatus,
    pending_balance_pence: canonicalPending,
  });

  const period_kpis = buildDriverWalletPeriodKpis(
    ledger.map((r) => ({
      type: String(r.type ?? ""),
      amount_pence: Number(r.amount_pence ?? 0),
      created_at: (r as { created_at?: string | null }).created_at ?? null,
      related_trip_id: (r as { related_trip_id?: string | null }).related_trip_id ?? null,
    })),
    {
      recoveryDebtPence: recoveryDebt,
      // Slice 6: Pending = eligibility pending (live − available) — same as Payout Ledger.
      pendingEarningsPence: canonicalPending,
    },
  );

  const category = driver?.driver_categories as { name?: string } | null;
  const tierName = category?.name ?? null;
  const saJoin = driverServiceAreaRes.data?.service_areas as
    | {
      id?: string;
      name?: string;
      driver_payout_gateway?: string | null;
      payment_provider?: string | null;
    }
    | {
      id?: string;
      name?: string;
      driver_payout_gateway?: string | null;
      payment_provider?: string | null;
    }[]
    | null;
  const serviceArea = Array.isArray(saJoin) ? saJoin[0] ?? null : saJoin;
  const serviceAreaId = serviceArea?.id
    ?? (driverServiceAreaRes.data?.service_area_id as string | null)
    ?? null;

  let commissionPercent: number | null = null;
  if (serviceAreaId && tierName) {
    const { data: saTier } = await supabase
      .from("service_area_driver_tiers")
      .select("commission_percent")
      .eq("service_area_id", serviceAreaId)
      .ilike("tier_name", tierName)
      .eq("is_active", true)
      .maybeSingle();
    if (saTier?.commission_percent != null) {
      commissionPercent = Number(saTier.commission_percent);
    }
  }

  const settlement_history = buildDriverWalletSettlementHistory(
    settlements.map((s) => {
      const tripId = s.trip_id == null ? null : String(s.trip_id);
      const ledgerJoin = s.driver_wallet_ledger as { amount_pence?: number } | { amount_pence?: number }[] | null;
      const ledgerAmt = Array.isArray(ledgerJoin)
        ? Number(ledgerJoin[0]?.amount_pence ?? 0)
        : Number(ledgerJoin?.amount_pence ?? 0);
      const trip = tripId ? tripDetailById.get(tripId) : null;
      const session = tripId ? sessionByTripId.get(tripId) : null;
      return {
        settlement_id: String(s.id),
        trip_id: tripId,
        settlement_status: (s.settlement_status as string | null) ?? null,
        settled_at: (s.settled_at as string | null) ?? null,
        wallet_credit_pence: ledgerAmt,
        trip: trip
          ? {
            trip_code: (trip.trip_code as string | null) ?? null,
            completed_at: (trip.completed_at as string | null) ?? null,
            passenger_name: (trip.passenger_name as string | null) ?? null,
            payment_provider: (trip.payment_provider as string | null) ?? null,
            payment_method: (trip.payment_method as string | null) ?? null,
            provider_fee_pence: trip.provider_fee_pence == null ? null : Number(trip.provider_fee_pence),
            platform_commission_amount: trip.commission_pence == null
              ? (trip.platform_commission_amount == null ? null : Number(trip.platform_commission_amount))
              : Number(trip.commission_pence),
            driver_tier_commission_percent: trip.driver_tier_commission_percent == null
              ? null
              : Number(trip.driver_tier_commission_percent),
            driver_net_pence: trip.driver_net_pence == null ? null : Number(trip.driver_net_pence),
            payment_session_id: (trip.payment_session_id as string | null) ?? null,
          }
          : null,
        payment_session: session
          ? {
            id: (session.id as string | null) ?? null,
            payment_provider: (session.payment_provider as string | null) ?? null,
            payment_method: (session.payment_method as string | null) ?? null,
            captured_amount_pence: session.captured_amount_pence == null
              ? null
              : Number(session.captured_amount_pence),
            provider_processing_fee_pence: session.provider_processing_fee_pence == null
              ? null
              : Number(session.provider_processing_fee_pence),
          }
          : null,
      };
    }),
  );

  // Active provider fee config for this driver's service area (estimate + admin display).
  let activeFeeConfig: Record<string, unknown> | null = null;
  if (serviceAreaId) {
    const { data: feeCfg } = await supabase
      .from("provider_fee_configurations")
      .select("*")
      .eq("service_area_id", serviceAreaId)
      .eq("is_active", true)
      .lte("effective_from", new Date().toISOString())
      .or("effective_to.is.null,effective_to.gt." + new Date().toISOString())
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    activeFeeConfig = (feeCfg as Record<string, unknown> | null) ?? null;
  }

  const commissionRowsRaw = settlements.map((s) => {
    const tripId = s.trip_id == null ? null : String(s.trip_id);
    const trip = tripId ? tripDetailById.get(tripId) : null;
    const session = tripId ? sessionByTripId.get(tripId) : null;
    if (!tripId || !trip) return null;
    const gross = trip.commission_pence != null
      ? Number(trip.commission_pence)
      : (trip.platform_commission_amount != null ? Number(trip.platform_commission_amount) : null);
    return buildCommissionFeeBreakdownRow({
      trip: {
        trip_id: tripId,
        trip_code: (trip.trip_code as string | null) ?? null,
        completed_at: (trip.completed_at as string | null) ?? null,
        payment_provider: (trip.payment_provider as string | null) ?? null,
        payment_method: (trip.payment_method as string | null) ?? null,
        commissionable_fare_pence: trip.final_customer_fare_pence == null
          ? null
          : Number(trip.final_customer_fare_pence),
        commission_rate_percent: trip.driver_tier_commission_percent == null
          ? null
          : Number(trip.driver_tier_commission_percent),
        gross_commission_pence: gross,
        provider_transaction_id: (trip.provider_payment_id as string | null) ?? null,
      },
      session: session
        ? {
          payment_session_id: (session.id as string | null) ?? null,
          payment_provider: (session.payment_provider as string | null) ?? null,
          payment_method: (session.payment_method as string | null) ?? null,
          provider_processing_fee_pence: session.provider_processing_fee_pence == null
            ? null
            : Number(session.provider_processing_fee_pence),
          fee_status: (session.fee_status as string | null) ?? null,
          provider_fee_percentage_snapshot: session.provider_fee_percentage_snapshot_pence == null
            ? null
            : Number(session.provider_fee_percentage_snapshot_pence),
          provider_fixed_fee_snapshot: session.provider_fixed_fee_snapshot_pence == null
            ? null
            : Number(session.provider_fixed_fee_snapshot_pence),
          provider_fee_total_snapshot: session.provider_fee_total_snapshot_pence == null
            ? null
            : Number(session.provider_fee_total_snapshot_pence),
          provider_fee_version_snapshot: (session.provider_fee_version_snapshot as string | null) ?? null,
          provider_fee_currency_snapshot: (session.provider_fee_currency_snapshot as string | null) ?? null,
          provider_transaction_id: (session.provider_payment_id as string | null)
            ?? (session.provider_order_id as string | null)
            ?? null,
          provider_fee_source: (session.provider_fee_source as string | null) ?? null,
          provider_fee_confirmed_at: (session.provider_fee_confirmed_at as string | null) ?? null,
        }
        : null,
      feeConfig: activeFeeConfig
        ? {
          provider_name: String(activeFeeConfig.collection_provider ?? ""),
          fee_type: (activeFeeConfig.fee_type as string | null) ?? null,
          percentage_fee_bps: activeFeeConfig.percentage_fee_bps == null
            ? null
            : Number(activeFeeConfig.percentage_fee_bps),
          fixed_fee_pence: activeFeeConfig.fixed_fee_pence == null
            ? null
            : Number(activeFeeConfig.fixed_fee_pence),
          currency_code: (activeFeeConfig.currency_code as string | null) ?? null,
          version: (activeFeeConfig.version as string | null) ?? null,
          effective_from: (activeFeeConfig.effective_from as string | null) ?? null,
          payment_method: (activeFeeConfig.payment_method as string | null) ?? null,
        }
        : null,
    });
  }).filter(Boolean);

  const commission_fee_breakdown = attachRunningNetOnecabBalanceNewestFirst(
    commissionRowsRaw as ReturnType<typeof buildCommissionFeeBreakdownRow>[],
  );
  const commission_fee_summary = summarizeCommissionFeeRows(commission_fee_breakdown);

  const debt_recovery = buildDriverWalletDebtRecoveryKpis(ledger, recoveryDebt);

  let walletStatus: DriverWalletPayoutDetail["wallet_status"] = "ACTIVE";
  if (
    !isRevolutPayout
    && !driver?.stripe_account_id
    && String(payoutProviderResolved ?? "").toLowerCase() !== "revolut"
  ) {
    walletStatus = "NOT_CONNECTED";
  } else if (
    snapshot.payout_blocked
    || walletBalance < 0
    || frRow.reconciliation_status === "DRIVER_WALLET_MISMATCH"
    || frRow.reconciliation_status === "PAYOUT_MISMATCH"
    || frRow.reconciliation_status === "DRIVER_AND_PAYOUT_MISMATCH"
  ) {
    walletStatus = "FROZEN";
  } else if (verificationStatus === "restricted" || verificationStatus === "pending") {
    walletStatus = "RESTRICTED";
  }

  const payoutProvider = serviceArea?.driver_payout_gateway
    ?? (String(serviceArea?.payment_provider ?? "").toLowerCase() === "stripe"
      ? null
      : serviceArea?.payment_provider)
    ?? null;
  // P0: never infer payout provider from stripe_account_id; never prefer retired stripe payment_provider.

  const controlCentre = await loadPayoutControlCentreSettings(supabase, {
    serviceAreaId,
  });
  const schedule = buildPayoutScheduleDto({
    service_area_id: serviceAreaId,
    serviceAreaTimezone: serviceArea?.timezone ?? null,
    currencyCode: serviceArea?.currency_code ?? "GBP",
    automatic_payouts_enabled: controlCentre.payouts_enabled,
    frequency: controlCentre.payout_frequency,
    weekly_day: controlCentre.weekly_payout_day,
    local_processing_time: controlCentre.payout_processing_time,
  });
  const nextScheduledPayoutAt = schedule.next_run_at_utc;

  return {
    ...snapshot,
    ...frRow,
    // FR Drivers tab status — wallet vs payable, never Connect default BALANCED.
    reconciliation_status: frRow.reconciliation_status,
    reconciliation_reasons: [
      ...(payoutEligibility.primary_hold_reason ? [payoutEligibility.primary_hold_reason] : []),
      ...frRow.reconciliation_reasons,
      ...snapshot.reconciliation_reasons.filter((r) =>
        !frRow.reconciliation_reasons.includes(r)
      ),
    ].filter((r, i, arr) => arr.indexOf(r) === i),
    stripe_connect_available_pence: frRow.provider_account_balance_pence,
    provider_account_balance_pence: frRow.provider_account_balance_pence,
    cashout_limit_pence: canonicalAvailable,
    wallet_balance_pence: frRow.current_wallet_balance_pence ?? snapshot.wallet_balance_pence,
    driver_id: args.driverId,
    user_id: (driver?.user_id as string) ?? null,
    driver_code: (driver?.driver_code as string) ?? null,
    driver_name: driverName,
    connected_account_id: (driver?.stripe_account_id as string) ?? null,
    verification_status: verificationStatus,
    bank_account_last4: bankLast4,
    payouts_enabled: driver?.payouts_enabled ?? null,
    last_payout_at: lastPaidPayout
      ? String(lastPaidPayout.initiated_at ?? lastPaidPayout.arrival_date ?? null)
      : null,
    last_payout_amount_pence: lastPaidPayout
      ? Math.max(0, Number(lastPaidPayout.amount_pence ?? 0))
      : null,
    driver_tier_name: tierName,
    commission_percent: commissionPercent,
    service_area_id: serviceAreaId,
    service_area_name: serviceArea?.name ?? null,
    payout_provider: payoutProvider,
    next_scheduled_payout_at: nextScheduledPayoutAt,
    wallet_status: walletStatus,
    period_kpis,
    payout_items: payoutItems,
    early_cashouts: earlyCashouts,
    stripe_connect_payouts: stripePayouts,
    settlements,
    settlement_history,
    debt_recovery,
    commission_fee_breakdown,
    commission_fee_summary,
    active_provider_fee_config: activeFeeConfig,
    ledger_rows: recentLedger,
    transfer_ledger_rows: transferLedger,
    last_synced_at: syncedAt,
  };
}
