/**
 * Shared Commission Wallet top-up confirm → TOP_UP_CREDIT (+ Phase 5 bonus).
 * Never writes driver_wallet_ledger.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  COMMISSION_TOPUP_STATUS,
  COMMISSION_WALLET_CAMPAIGN_TYPE,
  COMMISSION_WALLET_CLAIM_KIND,
  COMMISSION_WALLET_ENTRY_TYPE,
  buildCommissionWalletTopupBonusIdempotencyKey,
  planCommissionWalletTopupBonus,
  planCommissionWalletTopupConfirm,
} from "../../../shared/commissionWalletSSOT.ts";

export type ConfirmTopupBonusInfo = {
  applied: boolean;
  amount_minor?: number;
  campaign_id?: string;
  ledger_entry_id?: string;
  skipped_code?: string;
  claim_synced?: boolean;
};

export type ConfirmTopupResult =
  | {
    ok: true;
    already_succeeded: boolean;
    topup_id: string;
    ledger_entry_id: string;
    amount_minor: number;
    currency: string;
    bonus?: ConfirmTopupBonusInfo;
  }
  | {
    ok: false;
    error: string;
    code: string;
    status?: number;
  };

export async function confirmCommissionWalletTopupCredit(
  supabase: SupabaseClient,
  input: {
    topupId?: string | null;
    provider: string;
    providerTransactionId: string;
    confirmedAmountMinor: number;
    confirmedCurrency: string;
  },
): Promise<ConfirmTopupResult> {
  const provider = String(input.provider).trim().toLowerCase();
  const providerTxn = String(input.providerTransactionId).trim();

  let topupQuery = supabase
    .from("driver_commission_wallet_topups")
    .select(
      "id, driver_id, service_area_id, region_id, currency, amount_minor, provider, provider_transaction_id, status, credited_ledger_entry_id, idempotency_key, metadata",
    );

  if (input.topupId) {
    topupQuery = topupQuery.eq("id", input.topupId);
  } else {
    topupQuery = topupQuery
      .eq("provider", provider)
      .eq("provider_transaction_id", providerTxn);
  }

  const { data: topup, error: topupErr } = await topupQuery.maybeSingle();
  if (topupErr) {
    return { ok: false, error: topupErr.message, code: "TOPUP_LOOKUP_FAILED", status: 500 };
  }
  if (!topup) {
    return { ok: false, error: "Top-up not found", code: "TOPUP_NOT_FOUND", status: 404 };
  }

  const plan = planCommissionWalletTopupConfirm({
    currentStatus: topup.status,
    topupAmountMinor: topup.amount_minor,
    topupCurrency: topup.currency,
    confirmedAmountMinor: input.confirmedAmountMinor,
    confirmedCurrency: input.confirmedCurrency,
    providerTransactionId: providerTxn || topup.provider_transaction_id,
    topupId: topup.id,
  });

  if (!plan.ok) {
    return { ok: false, error: plan.error, code: plan.code, status: 400 };
  }

  let ledgerEntryId = topup.credited_ledger_entry_id as string | null;
  let alreadySucceeded = false;

  if (plan.already_succeeded && ledgerEntryId) {
    alreadySucceeded = true;
  } else {
    if (!topup.provider_transaction_id && providerTxn) {
      const { error: linkErr } = await supabase
        .from("driver_commission_wallet_topups")
        .update({
          provider_transaction_id: providerTxn,
          status: COMMISSION_TOPUP_STATUS.PROCESSING,
          updated_at: new Date().toISOString(),
        })
        .eq("id", topup.id)
        .in("status", [COMMISSION_TOPUP_STATUS.PENDING, COMMISSION_TOPUP_STATUS.PROCESSING]);
      if (linkErr) {
        return { ok: false, error: linkErr.message, code: "TOPUP_LINK_FAILED", status: 500 };
      }
    }

    const { data: existingLedger } = await supabase
      .from("driver_commission_wallet_ledger")
      .select("id")
      .eq("idempotency_key", plan.ledger_idempotency_key)
      .maybeSingle();

    if (existingLedger?.id) {
      ledgerEntryId = existingLedger.id;
      alreadySucceeded = true;
      await supabase
        .from("driver_commission_wallet_topups")
        .update({
          status: COMMISSION_TOPUP_STATUS.SUCCEEDED,
          credited_ledger_entry_id: existingLedger.id,
          provider_transaction_id: providerTxn || topup.provider_transaction_id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", topup.id);
    } else {
      const { data: entry, error: insertErr } = await supabase
        .from("driver_commission_wallet_ledger")
        .insert({
          driver_id: topup.driver_id,
          service_area_id: topup.service_area_id,
          region_id: topup.region_id ?? null,
          currency: plan.currency,
          entry_type: COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT,
          amount_minor: plan.amount_minor,
          direction: "credit",
          topup_id: topup.id,
          provider,
          provider_transaction_id: providerTxn || topup.provider_transaction_id,
          reason: "Provider sandbox top-up",
          promotional_portion_minor: 0,
          purchased_portion_minor: plan.purchased_portion_minor,
          idempotency_key: plan.ledger_idempotency_key,
          metadata: {
            phase: "phase4_provider_topup",
            sandbox: true,
            topup_idempotency_key: topup.idempotency_key,
          },
        })
        .select("id")
        .single();

      if (insertErr) {
        const { data: raced } = await supabase
          .from("driver_commission_wallet_ledger")
          .select("id")
          .eq("idempotency_key", plan.ledger_idempotency_key)
          .maybeSingle();
        if (raced?.id) {
          ledgerEntryId = raced.id;
          alreadySucceeded = true;
          await supabase
            .from("driver_commission_wallet_topups")
            .update({
              status: COMMISSION_TOPUP_STATUS.SUCCEEDED,
              credited_ledger_entry_id: raced.id,
              updated_at: new Date().toISOString(),
            })
            .eq("id", topup.id);
        } else {
          return { ok: false, error: insertErr.message, code: "LEDGER_INSERT_FAILED", status: 500 };
        }
      } else {
        ledgerEntryId = entry.id;
        const { error: updateErr } = await supabase
          .from("driver_commission_wallet_topups")
          .update({
            status: COMMISSION_TOPUP_STATUS.SUCCEEDED,
            credited_ledger_entry_id: entry.id,
            provider_transaction_id: providerTxn || topup.provider_transaction_id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", topup.id);

        if (updateErr) {
          return {
            ok: false,
            error: `Ledger credited but topup update failed: ${updateErr.message}`,
            code: "TOPUP_UPDATE_FAILED",
            status: 500,
          };
        }
      }
    }
  }

  const bonus = await applyTopupBonusIfEligible(supabase, {
    topupId: topup.id,
    driverId: topup.driver_id,
    serviceAreaId: topup.service_area_id,
    regionId: topup.region_id,
    currency: plan.currency,
    topupAmountMinor: plan.amount_minor,
  });

  return {
    ok: true,
    already_succeeded: alreadySucceeded,
    topup_id: topup.id,
    ledger_entry_id: ledgerEntryId!,
    amount_minor: plan.amount_minor,
    currency: plan.currency,
    bonus,
  };
}

async function applyTopupBonusIfEligible(
  supabase: SupabaseClient,
  input: {
    topupId: string;
    driverId: string;
    serviceAreaId: string;
    regionId: string | null;
    currency: string;
    topupAmountMinor: number;
  },
): Promise<ConfirmTopupBonusInfo> {
  const nowIso = new Date().toISOString();
  const { data: campaigns } = await supabase
    .from("commission_wallet_campaigns")
    .select(
      "id, campaign_type, currency, active, start_at, end_at, credit_amount_minor, bonus_percent, minimum_topup_amount_minor, maximum_bonus_amount_minor, maximum_claims, maximum_claims_per_driver",
    )
    .eq("service_area_id", input.serviceAreaId)
    .eq("active", true)
    .eq("currency", input.currency)
    .in("campaign_type", [
      COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS,
      COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS,
    ])
    .limit(5);

  const campaign = (campaigns ?? []).find((c) => {
    if (c.start_at && c.start_at > nowIso) return false;
    if (c.end_at && c.end_at < nowIso) return false;
    return true;
  }) ?? null;

  const bonusPlan = planCommissionWalletTopupBonus({
    campaign,
    topupAmountMinor: input.topupAmountMinor,
    topupCurrency: input.currency,
  });

  if (!bonusPlan.ok || !campaign) {
    return { applied: false, skipped_code: bonusPlan.ok ? "NO_CAMPAIGN" : bonusPlan.code };
  }

  // Replay must run BEFORE max-claim gates — otherwise an already-credited bonus for this
  // topup is counted toward the cap and incorrectly returns MAX_CLAIMS(_PER_DRIVER).
  const bonusKey = buildCommissionWalletTopupBonusIdempotencyKey(input.topupId, campaign.id);
  const { data: existingBonus } = await supabase
    .from("driver_commission_wallet_ledger")
    .select("id, amount_minor")
    .eq("idempotency_key", bonusKey)
    .maybeSingle();

  if (existingBonus?.id) {
    const claimSynced = await ensureTopupBonusClaim(supabase, {
      campaignId: campaign.id,
      driverId: input.driverId,
      serviceAreaId: input.serviceAreaId,
      topupId: input.topupId,
      ledgerEntryId: existingBonus.id,
      amountMinor: existingBonus.amount_minor,
      campaignType: String(campaign.campaign_type),
      bonusKey,
    });
    return {
      applied: true,
      amount_minor: existingBonus.amount_minor,
      campaign_id: campaign.id,
      ledger_entry_id: existingBonus.id,
      claim_synced: claimSynced,
    };
  }

  const maxClaims = Math.round(Number(campaign.maximum_claims) || 0);
  if (maxClaims > 0) {
    // Count ledger (source of truth for money) so missing claim rows cannot under-cap.
    const { count } = await supabase
      .from("driver_commission_wallet_ledger")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .eq("entry_type", COMMISSION_WALLET_ENTRY_TYPE.PROMOTIONAL_CREDIT)
      .not("topup_id", "is", null);
    if ((count ?? 0) >= maxClaims) {
      return { applied: false, skipped_code: "MAX_CLAIMS", campaign_id: campaign.id };
    }
  }

  const maxPerDriver = Math.round(Number(campaign.maximum_claims_per_driver) || 0);
  if (maxPerDriver > 0) {
    const { count } = await supabase
      .from("driver_commission_wallet_ledger")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .eq("driver_id", input.driverId)
      .eq("entry_type", COMMISSION_WALLET_ENTRY_TYPE.PROMOTIONAL_CREDIT)
      .not("topup_id", "is", null);
    if ((count ?? 0) >= maxPerDriver) {
      return { applied: false, skipped_code: "MAX_CLAIMS_PER_DRIVER", campaign_id: campaign.id };
    }
  }

  const { data: bonusEntry, error: bonusErr } = await supabase
    .from("driver_commission_wallet_ledger")
    .insert({
      driver_id: input.driverId,
      service_area_id: input.serviceAreaId,
      region_id: input.regionId ?? null,
      currency: input.currency,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.PROMOTIONAL_CREDIT,
      amount_minor: bonusPlan.amount_minor,
      direction: "credit",
      topup_id: input.topupId,
      campaign_id: campaign.id,
      reason: `Top-up bonus (${bonusPlan.campaign_type})`,
      promotional_portion_minor: bonusPlan.amount_minor,
      purchased_portion_minor: 0,
      idempotency_key: bonusKey,
      metadata: {
        phase: "phase5_topup_bonus",
        campaign_type: bonusPlan.campaign_type,
      },
    })
    .select("id")
    .single();

  if (bonusErr) {
    const { data: raced } = await supabase
      .from("driver_commission_wallet_ledger")
      .select("id, amount_minor")
      .eq("idempotency_key", bonusKey)
      .maybeSingle();
    if (raced?.id) {
      const claimSynced = await ensureTopupBonusClaim(supabase, {
        campaignId: campaign.id,
        driverId: input.driverId,
        serviceAreaId: input.serviceAreaId,
        topupId: input.topupId,
        ledgerEntryId: raced.id,
        amountMinor: raced.amount_minor,
        campaignType: bonusPlan.campaign_type,
        bonusKey,
      });
      return {
        applied: true,
        amount_minor: raced.amount_minor,
        campaign_id: campaign.id,
        ledger_entry_id: raced.id,
        claim_synced: claimSynced,
      };
    }
    console.error("[applyTopupBonusIfEligible] insert failed", bonusErr);
    return { applied: false, skipped_code: "BONUS_INSERT_FAILED", campaign_id: campaign.id };
  }

  const claimSynced = await ensureTopupBonusClaim(supabase, {
    campaignId: campaign.id,
    driverId: input.driverId,
    serviceAreaId: input.serviceAreaId,
    topupId: input.topupId,
    ledgerEntryId: bonusEntry.id,
    amountMinor: bonusPlan.amount_minor,
    campaignType: bonusPlan.campaign_type,
    bonusKey,
  });

  return {
    applied: true,
    amount_minor: bonusPlan.amount_minor,
    campaign_id: campaign.id,
    ledger_entry_id: bonusEntry.id,
    claim_synced: claimSynced,
  };
}

async function ensureTopupBonusClaim(
  supabase: SupabaseClient,
  input: {
    campaignId: string;
    driverId: string;
    serviceAreaId: string;
    topupId: string;
    ledgerEntryId: string;
    amountMinor: number;
    campaignType: string;
    bonusKey: string;
  },
): Promise<boolean> {
  const payload = {
    campaign_id: input.campaignId,
    driver_id: input.driverId,
    service_area_id: input.serviceAreaId,
    claim_kind: COMMISSION_WALLET_CLAIM_KIND.TOPUP_BONUS,
    topup_id: input.topupId,
    ledger_entry_id: input.ledgerEntryId,
    amount_minor: Math.round(Number(input.amountMinor) || 0),
    idempotency_key: input.bonusKey,
    metadata: { campaign_type: input.campaignType },
  };

  const { error } = await supabase
    .from("commission_wallet_campaign_claims")
    .upsert(payload, { onConflict: "idempotency_key", ignoreDuplicates: true });

  if (error) {
    console.error("[ensureTopupBonusClaim] upsert failed", error);
  }

  const { data: claim } = await supabase
    .from("commission_wallet_campaign_claims")
    .select("id")
    .eq("idempotency_key", input.bonusKey)
    .maybeSingle();

  if (!claim?.id) {
    // Retry once without ignoreDuplicates in case of race/partial write.
    const { error: retryErr } = await supabase
      .from("commission_wallet_campaign_claims")
      .insert(payload);
    if (retryErr && retryErr.code !== "23505") {
      console.error("[ensureTopupBonusClaim] retry insert failed", retryErr);
    }
    const { data: again } = await supabase
      .from("commission_wallet_campaign_claims")
      .select("id")
      .eq("idempotency_key", input.bonusKey)
      .maybeSingle();
    if (!again?.id) {
      console.error("[ensureTopupBonusClaim] claim missing after ledger credit", input.bonusKey);
      return false;
    }
  }
  return true;
}

export async function markCommissionWalletTopupTerminal(
  supabase: SupabaseClient,
  input: {
    provider: string;
    providerTransactionId: string;
    status: typeof COMMISSION_TOPUP_STATUS.FAILED | typeof COMMISSION_TOPUP_STATUS.EXPIRED;
  },
): Promise<{ ok: true } | { ok: false; error: string; code: string; status?: number }> {
  const { data: topup, error } = await supabase
    .from("driver_commission_wallet_topups")
    .select("id, status")
    .eq("provider", input.provider)
    .eq("provider_transaction_id", input.providerTransactionId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message, code: "TOPUP_LOOKUP_FAILED", status: 500 };
  if (!topup) return { ok: false, error: "Top-up not found", code: "TOPUP_NOT_FOUND", status: 404 };

  if (
    topup.status === COMMISSION_TOPUP_STATUS.SUCCEEDED
    || topup.status === COMMISSION_TOPUP_STATUS.REVERSED
  ) {
    return { ok: false, error: "Top-up already finalized", code: "INVALID_STATUS", status: 400 };
  }

  if (
    topup.status === COMMISSION_TOPUP_STATUS.FAILED
    || topup.status === COMMISSION_TOPUP_STATUS.EXPIRED
  ) {
    return { ok: true };
  }

  const { error: updErr } = await supabase
    .from("driver_commission_wallet_topups")
    .update({
      status: input.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", topup.id);

  if (updErr) return { ok: false, error: updErr.message, code: "TOPUP_UPDATE_FAILED", status: 500 };
  return { ok: true };
}
