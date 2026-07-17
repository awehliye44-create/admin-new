/**
 * Admin Commission Wallet overview — Phase 2 read model.
 * Summaries + ledgers from driver_commission_wallet_ledger only.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  requireAdminOrStaff,
  requirePageAccess,
  corsHeaders,
} from "../_shared/adminPaymentGate.ts";
import {
  aggregateCommissionWalletOverviewCards,
  aggregateCommissionWalletFinanceReport,
  deriveBalancesFromCommissionLedgerEntries,
  isCommissionWalletWorkflowEnabled,
  REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION,
} from "../../../shared/commissionWalletSSOT.ts";

const PAGE_SLUG = "commission-wallet";
const PAGE_SIZE = 1000;
const MAX_AGGREGATE_ROWS = 50000;

type LedgerBalanceRow = {
  driver_id: string;
  service_area_id: string;
  currency: string;
  entry_type: string;
  amount_minor: number;
  direction: string;
  promotional_portion_minor?: number | null;
  purchased_portion_minor?: number | null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const staffGate = await requireAdminOrStaff(req);
    if (!staffGate.ok) return staffGate.response;
    const gate = await requirePageAccess(staffGate, PAGE_SLUG);
    if (!gate.ok) return gate.response;

    if (gate.userId === "service-role") {
      return json({
        success: false,
        error: "Authenticated admin/staff user required for Commission Wallet overview",
        code: "ADMIN_USER_REQUIRED",
      }, 403);
    }

    const body = await req.json().catch(() => ({})) as {
      region_id?: string | null;
      service_area_id?: string | null;
      driver_id?: string | null;
      currency?: string | null;
      limit?: number;
    };

    const regionId = body.region_id ? String(body.region_id).trim() : null;
    const serviceAreaId = body.service_area_id ? String(body.service_area_id).trim() : null;
    const driverId = body.driver_id ? String(body.driver_id).trim() : null;
    const currencyFilter = body.currency ? String(body.currency).trim().toUpperCase() : null;
    const limit = Math.min(200, Math.max(1, Math.round(Number(body.limit) || 50)));

    let saQuery = gate.supabase
      .from("service_areas")
      .select(
        "id, name, region_id, financial_model, commission_wallet_enabled, commission_reserve_enabled, commission_wallet_currency, commission_topup_provider, commission_wallet_minimum_balance_minor, customer_payment_policy, welcome_credit_enabled, welcome_credit_amount_minor, welcome_credit_max_drivers, currency_code, region:regions(id, name, currency_code)",
      )
      .order("name");

    if (regionId) saQuery = saQuery.eq("region_id", regionId);
    if (serviceAreaId) saQuery = saQuery.eq("id", serviceAreaId);

    const { data: areas, error: saErr } = await saQuery;
    if (saErr) {
      return json({ success: false, error: saErr.message }, 500);
    }

    const serviceAreas = (areas ?? []).map((sa) => {
      const enabled = isCommissionWalletWorkflowEnabled({
        financial_model: sa.financial_model,
        commission_wallet_enabled: sa.commission_wallet_enabled,
      });
      return {
        ...sa,
        workflow_enabled: enabled,
        dispatch_gate_active: false,
      };
    });

    let ledgerQuery = gate.supabase
      .from("driver_commission_wallet_ledger")
      .select(
        "id, driver_id, service_area_id, region_id, currency, entry_type, credit_type, amount_minor, direction, trip_id, topup_id, campaign_id, provider, provider_transaction_id, admin_user_id, reason, promotional_portion_minor, purchased_portion_minor, metadata, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit);

    if (serviceAreaId) ledgerQuery = ledgerQuery.eq("service_area_id", serviceAreaId);
    if (regionId) ledgerQuery = ledgerQuery.eq("region_id", regionId);
    if (driverId) ledgerQuery = ledgerQuery.eq("driver_id", driverId);
    if (currencyFilter) ledgerQuery = ledgerQuery.eq("currency", currencyFilter);

    const { data: ledgerRows, error: ledgerErr } = await ledgerQuery;
    if (ledgerErr) {
      return json({ success: false, error: ledgerErr.message }, 500);
    }

    const applyScopeFilters = <T extends { eq: (col: string, val: string) => T }>(q: T): T => {
      if (serviceAreaId) q = q.eq("service_area_id", serviceAreaId);
      if (regionId) q = q.eq("region_id", regionId);
      if (driverId) q = q.eq("driver_id", driverId);
      if (currencyFilter) q = q.eq("currency", currencyFilter);
      return q;
    };

    const paginateLedger = async <T>(
      columns: string,
      orderCol = "created_at",
    ): Promise<{ rows: T[]; truncated: boolean }> => {
      const rows: T[] = [];
      let truncated = false;
      for (let offset = 0; offset < MAX_AGGREGATE_ROWS; offset += PAGE_SIZE) {
        let q = applyScopeFilters(
          gate.supabase
            .from("driver_commission_wallet_ledger")
            .select(columns)
            .order(orderCol, { ascending: true }),
        ).range(offset, offset + PAGE_SIZE - 1);
        const { data, error } = await q;
        if (error) throw error;
        if (!data?.length) break;
        rows.push(...(data as T[]));
        if (data.length < PAGE_SIZE) break;
        if (offset + PAGE_SIZE >= MAX_AGGREGATE_ROWS) {
          truncated = true;
        }
      }
      return { rows, truncated };
    };

    const { rows: balanceRows, truncated: balancesTruncated } = await paginateLedger<LedgerBalanceRow>(
      "driver_id, service_area_id, currency, entry_type, amount_minor, direction, promotional_portion_minor, purchased_portion_minor",
      "id",
    );

    const { rows: cardSliceRows, truncated: cardsTruncated } = await paginateLedger<{
      entry_type: string;
      amount_minor: number;
      metadata?: Record<string, unknown> | null;
    }>(
      "entry_type, amount_minor, metadata",
      "id",
    );

    const byKey = new Map<string, LedgerBalanceRow[]>();
    for (const row of balanceRows) {
      const key = `${row.driver_id}:${row.service_area_id}:${row.currency}`;
      const list = byKey.get(key) ?? [];
      list.push(row);
      byKey.set(key, list);
    }

    const driverBalances = [...byKey.entries()].map(([key, rows]) => {
      const [dId, saId, cur] = key.split(":");
      const bal = deriveBalancesFromCommissionLedgerEntries(rows ?? []);
      const minRequired = Number(
        serviceAreas.find((s) => s.id === saId)?.commission_wallet_minimum_balance_minor ?? 0,
      );
      return {
        driver_id: dId,
        service_area_id: saId,
        currency: cur,
        ...bal,
        below_minimum: bal.usable_commission_balance_minor < minRequired,
      };
    });

    const cardTotals = aggregateCommissionWalletOverviewCards(cardSliceRows);

    const walletLiabilitiesMinor = driverBalances.reduce(
      (s, d) =>
        s
        + Math.max(0, d.purchased_balance_minor)
        + Math.max(0, d.promotional_balance_minor),
      0,
    );

    // Phase 7/8 finance: completed CW trips + reported customer fares.
    // Prefer trip snapshot (financial_model / commission_wallet_enabled), not live SA membership.
    let completedCwTrips = 0;
    let customerFaresReportedMinor = 0;
    const cwSaIds = serviceAreas
      .filter((s) => s.workflow_enabled)
      .map((s) => String(s.id));
    const filteredSaEnabled = serviceAreaId
      ? serviceAreas.some((s) => String(s.id) === serviceAreaId && s.workflow_enabled)
      : false;
    if (cwSaIds.length > 0 || filteredSaEnabled) {
      const saFilter = serviceAreaId && filteredSaEnabled ? [serviceAreaId] : cwSaIds;
      if (saFilter.length > 0) {
        let tripQ = gate.supabase
          .from("trips")
          .select(
            "id, final_fare_pence, final_customer_fare_pence, fare, service_area_id, financial_model, commission_wallet_enabled",
          )
          .eq("status", "completed")
          .in("service_area_id", saFilter)
          .eq("financial_model", "DRIVER_COLLECTED_COMMISSION_WALLET")
          .eq("commission_wallet_enabled", true)
          .limit(5000);
        if (driverId) tripQ = tripQ.eq("driver_id", driverId);
        const { data: cwTrips } = await tripQ;
        completedCwTrips = (cwTrips ?? []).length;
        for (const t of cwTrips ?? []) {
          const fare =
            Number(t.final_customer_fare_pence)
            || Number(t.final_fare_pence)
            || Math.round(Number(t.fare || 0) * 100);
          customerFaresReportedMinor += Math.max(0, Math.round(fare || 0));
        }
      }
    }

    const financeReport = aggregateCommissionWalletFinanceReport(cardSliceRows, {
      completedDriverCollectedTrips: completedCwTrips,
      totalCustomerFaresReportedMinor: customerFaresReportedMinor,
      walletLiabilitiesMinor,
    });

    const cards = {
      purchased_balances_minor: driverBalances.reduce((s, d) => s + d.purchased_balance_minor, 0),
      promotional_balances_minor: driverBalances.reduce((s, d) => s + d.promotional_balance_minor, 0),
      reserved_commission_minor: driverBalances.reduce((s, d) => s + d.reserved_balance_minor, 0),
      commission_collected_minor: cardTotals.commission_collected_minor,
      campaign_credits_minor: cardTotals.campaign_credits_minor,
      provider_topups_minor: cardTotals.provider_topups_minor,
      reversals_minor: cardTotals.reversals_minor,
      drivers_below_minimum: driverBalances.filter((d) => d.below_minimum).length,
      enabled_service_areas: serviceAreas.filter((s) => s.workflow_enabled).length,
      balance_rows_scanned: balanceRows.length,
      card_rows_scanned: cardSliceRows.length,
      aggregates_truncated: balancesTruncated || cardsTruncated,
      // Phase 7 finance mirrors
      onecab_revenue_minor: financeReport.onecab_revenue_minor,
      outstanding_reserves_minor: financeReport.outstanding_reserves_minor,
      completed_driver_collected_trips: financeReport.completed_driver_collected_trips,
      total_customer_fares_reported_minor: financeReport.total_customer_fares_reported_minor,
      onecab_customer_collection_minor: financeReport.onecab_customer_collection_minor,
      driver_payout_liability_minor: financeReport.driver_payout_liability_minor,
    };

    let audits: Record<string, unknown>[] = [];
    if (regionId && !serviceAreaId && serviceAreas.length === 0) {
      // Region filter with no matching SAs must not fall open to global audits.
      audits = [];
    } else {
      let auditQuery = gate.supabase
        .from("commission_wallet_admin_audit")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(30);
      if (serviceAreaId) {
        auditQuery = auditQuery.eq("service_area_id", serviceAreaId);
      } else if (regionId) {
        auditQuery = auditQuery.in(
          "service_area_id",
          serviceAreas.map((s) => String(s.id)),
        );
      }
      if (driverId) auditQuery = auditQuery.eq("driver_id", driverId);
      const { data: auditRows } = await auditQuery;
      audits = (auditRows ?? []) as Record<string, unknown>[];

      const adminIds = [...new Set(
        audits
          .map((a) => String(a.admin_user_id ?? "").trim())
          .filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
      )];
      if (adminIds.length > 0) {
        const { data: staffRows } = await gate.supabase
          .from("staff_profiles")
          .select("user_id, full_name")
          .in("user_id", adminIds);
        const nameById = new Map(
          (staffRows ?? []).map((s) => [
            String(s.user_id),
            String(s.full_name ?? "").trim(),
          ]),
        );
        audits = audits.map((a) => {
          const meta = a.metadata && typeof a.metadata === "object"
            ? a.metadata as Record<string, unknown>
            : null;
          const fromMeta = String(meta?.admin_display_name ?? "").trim();
          const fromStaff = nameById.get(String(a.admin_user_id ?? "")) || "";
          return {
            ...a,
            admin_display_name: fromMeta || fromStaff || null,
          };
        });
      }
    }

    let topupRows: Record<string, unknown>[] = [];
    if (!(regionId && !serviceAreaId && serviceAreas.length === 0)) {
      let topupQuery = gate.supabase
        .from("driver_commission_wallet_topups")
        .select(
          "id, driver_id, service_area_id, currency, amount_minor, provider, provider_transaction_id, status, credited_ledger_entry_id, created_at, updated_at",
        )
        .order("created_at", { ascending: false })
        .limit(40);
      if (serviceAreaId) {
        topupQuery = topupQuery.eq("service_area_id", serviceAreaId);
      } else if (regionId) {
        topupQuery = topupQuery.in(
          "service_area_id",
          serviceAreas.map((s) => String(s.id)),
        );
      }
      if (driverId) topupQuery = topupQuery.eq("driver_id", driverId);
      if (currencyFilter) topupQuery = topupQuery.eq("currency", currencyFilter);
      const { data: topups } = await topupQuery;
      topupRows = (topups ?? []) as Record<string, unknown>[];
    }

    let campaigns: Record<string, unknown>[] = [];
    let campaignClaimCounts: Record<string, number> = {};
    if (serviceAreaId) {
      const { data: campRows } = await gate.supabase
        .from("commission_wallet_campaigns")
        .select(
          "id, campaign_name, campaign_type, currency, active, credit_amount_minor, bonus_percent, minimum_topup_amount_minor, maximum_bonus_amount_minor, start_at, end_at, created_at",
        )
        .eq("service_area_id", serviceAreaId)
        .order("created_at", { ascending: false })
        .limit(50);
      campaigns = (campRows ?? []) as Record<string, unknown>[];
      const campIds = campaigns.map((c) => String(c.id));
      if (campIds.length) {
        const { data: claims } = await gate.supabase
          .from("commission_wallet_campaign_claims")
          .select("campaign_id")
          .in("campaign_id", campIds);
        for (const row of claims ?? []) {
          const id = String(row.campaign_id);
          campaignClaimCounts[id] = (campaignClaimCounts[id] ?? 0) + 1;
        }
      }
      campaigns = campaigns.map((c) => ({
        ...c,
        claim_count: campaignClaimCounts[String(c.id)] ?? 0,
      }));
    }

    return json({
      success: true,
      phase: 7,
      dispatch_enabled: true,
      topup_enabled: true,
      campaigns_enabled: true,
      deduction_enabled: true,
      revenue_source: REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION,
      finance_report: financeReport,
      service_areas: serviceAreas,
      cards,
      driver_balances: driverBalances,
      recent_ledger: ledgerRows ?? [],
      recent_topups: topupRows,
      recent_admin_audit: audits,
      campaigns,
      campaign_claim_total: Object.values(campaignClaimCounts).reduce((s, n) => s + n, 0),
    });
  } catch (err) {
    console.error("[admin-commission-wallet-overview]", err);
    return json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
