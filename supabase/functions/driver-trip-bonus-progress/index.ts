import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  buildProgressView,
  selectHomeCampaign,
  shouldHideTripBonusHomeCard,
  type DriverTripBonusCampaignRow,
  type DriverTripBonusGeoContext,
} from "./lib/driverTripBonusCampaignSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

type ProgressRow = {
  campaign_id: string;
  completed_count: number;
  credited_at: string | null;
  ledger_entry_id: string | null;
  entitled_trip_target: number | null;
  entitled_bonus_amount_pence: number | null;
  credit_notice_delivered_at: string | null;
};

/**
 * Driver Home trip-bonus progress card payload.
 * One highest-priority live campaign for the driver's service area, or a
 * qualified credit-pending entitlement (visible after ends_at until credited).
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "UNAUTHENTICATED" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "UNAUTHENTICATED" }, 401);

    const { data: driver, error: driverErr } = await admin
      .from("drivers")
      .select("id, service_area_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (driverErr) throw driverErr;
    if (!driver) return json({ error: "DRIVER_PROFILE_REQUIRED" }, 403);

    // Best-effort durable recovery while Driver is online (idempotent).
    try {
      await admin.rpc("reconcile_driver_trip_bonus_qualified_credits", {
        p_limit: 10,
      });
    } catch {
      // Cron remains authoritative; never fail the Home card on reconcile hiccup.
    }

    let areaActive = false;
    let driverRegionId: string | null = null;
    if (driver.service_area_id) {
      const { data: area, error: areaErr } = await admin
        .from("service_areas")
        .select("id, is_active, region_id")
        .eq("id", driver.service_area_id)
        .maybeSingle();
      if (areaErr) throw areaErr;
      areaActive = area?.is_active === true;
      driverRegionId = areaActive ? (area?.region_id ?? null) : null;
    }

    const geo: DriverTripBonusGeoContext = {
      service_area_id: driver.service_area_id ?? null,
      service_area_active: areaActive,
      region_id: driverRegionId,
    };

    const { data: progressRows, error: progressErr } = await admin
      .from("driver_trip_bonus_campaign_progress")
      .select(
        "campaign_id, completed_count, credited_at, ledger_entry_id, entitled_trip_target, entitled_bonus_amount_pence, credit_notice_delivered_at",
      )
      .eq("driver_id", driver.id);
    if (progressErr) throw progressErr;
    const progressList = (progressRows ?? []) as ProgressRow[];
    const progressByCampaign = new Map(
      progressList.map((p) => [p.campaign_id, p] as const),
    );

    // Pending credit-notice after durable wallet credit (one-shot heads-up).
    const noticeProgress = progressList.find(
      (p) =>
        p.credited_at != null &&
        p.ledger_entry_id != null &&
        p.credit_notice_delivered_at == null,
    );
    if (noticeProgress) {
      const amount =
        noticeProgress.entitled_bonus_amount_pence ??
        (
          await admin
            .from("driver_trip_bonus_campaigns")
            .select("bonus_amount_pence")
            .eq("id", noticeProgress.campaign_id)
            .maybeSingle()
        ).data?.bonus_amount_pence ??
        0;
      return json({
        campaign: null,
        wallet_credit_notice: {
          campaign_id: noticeProgress.campaign_id,
          bonus_amount_pence: Math.max(0, Number(amount) || 0),
          credited_at: noticeProgress.credited_at,
        },
      });
    }

    // Qualified but uncredited — keep visible even after campaign ends_at.
    const pending = progressList.find((p) => {
      if (p.credited_at != null) return false;
      const target = Math.max(1, Number(p.entitled_trip_target ?? 0));
      if (!p.entitled_trip_target) return false;
      return Number(p.completed_count ?? 0) >= target;
    });
    if (pending) {
      const { data: camp, error: campErr } = await admin
        .from("driver_trip_bonus_campaigns")
        .select(
          "id, title, card_headline, card_body, trip_target, bonus_amount_pence, status, is_active, starts_at, ends_at, scope_type, region_id, display_priority, created_at",
        )
        .eq("id", pending.campaign_id)
        .maybeSingle();
      if (campErr) throw campErr;
      if (camp) {
        const view = buildProgressView(
          camp as DriverTripBonusCampaignRow,
          Number(pending.completed_count ?? 0),
          false,
          {
            trip_target: pending.entitled_trip_target,
            bonus_amount_pence: pending.entitled_bonus_amount_pence,
          },
        );
        return json({
          campaign: {
            campaign_id: view.campaign_id,
            title: view.title,
            card_headline: view.card_headline,
            card_body: view.card_body,
            trip_target: view.trip_target,
            completed_count: view.completed_count,
            remaining_trips: view.remaining_trips,
            bonus_amount_pence: view.bonus_amount_pence,
            progress_ratio: view.progress_ratio,
            settlement_status: view.settlement_status,
            ends_at: null, // credit-pending must not expire from Home
          },
          wallet_credit_notice: null,
        });
      }
    }

    const { data: campaigns, error: campErr } = await admin
      .from("driver_trip_bonus_campaigns")
      .select(
        "id, title, card_headline, card_body, trip_target, bonus_amount_pence, status, is_active, starts_at, ends_at, scope_type, region_id, display_priority, created_at",
      )
      .eq("status", "published")
      .eq("is_active", true);
    if (campErr) throw campErr;

    const rows = (campaigns ?? []) as DriverTripBonusCampaignRow[];
    const areaMap: Record<string, string[]> = {};
    if (rows.length && driver.service_area_id && areaActive) {
      const { data: links, error: linkErr } = await admin
        .from("driver_trip_bonus_campaign_service_areas")
        .select("campaign_id, service_area_id")
        .in(
          "campaign_id",
          rows.map((r) => r.id),
        )
        .eq("service_area_id", driver.service_area_id);
      if (linkErr) throw linkErr;
      for (const l of (links ?? []) as Array<{ campaign_id: string; service_area_id: string }>) {
        (areaMap[l.campaign_id] ??= []).push(l.service_area_id);
      }
    }

    const home = selectHomeCampaign(rows, areaMap, geo);
    if (!home) {
      return json({ campaign: null, wallet_credit_notice: null });
    }

    const progress = progressByCampaign.get(home.id);
    const completed = Number(progress?.completed_count ?? 0);
    const credited = progress?.credited_at != null;
    const view = buildProgressView(home, completed, credited, {
      trip_target: progress?.entitled_trip_target,
      bonus_amount_pence: progress?.entitled_bonus_amount_pence,
    });

    if (
      shouldHideTripBonusHomeCard({
        settlementStatus: view.settlement_status,
        endsAt: home.ends_at,
      })
    ) {
      return json({ campaign: null, wallet_credit_notice: null });
    }

    return json({
      campaign: {
        campaign_id: view.campaign_id,
        title: view.title,
        card_headline: view.card_headline,
        card_body: view.card_body,
        trip_target: view.trip_target,
        completed_count: view.completed_count,
        remaining_trips: view.remaining_trips,
        bonus_amount_pence: view.bonus_amount_pence,
        progress_ratio: view.progress_ratio,
        settlement_status: view.settlement_status,
        ends_at:
          view.settlement_status === "credit_pending" ? null : (home.ends_at ?? null),
      },
      wallet_credit_notice: null,
    });
  } catch (e) {
    console.error("[driver-trip-bonus-progress]", e);
    return json({ error: "INTERNAL" }, 500);
  }
});
