/**
 * Shared handler: update driver payout destination (archive previous + insert active).
 * Revolut UK bank: auto-create counterparty after save (no /pay). Manual admin Verify is optional override.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveAuthenticatedDriver } from "./resolveAuthenticatedDriver.ts";
import { resolveDriverServiceAreaId } from "./resolveDriverServiceAreaId.ts";
import {
  checkServiceAreaGateway,
  gatewayNotConfiguredResponse,
} from "./paymentGatewayGuard.ts";
import {
  buildMaskedDestinationLabel,
  buildUkBankSortCodeMask,
  DESTINATION_STATUS,
  destinationLast4,
  encryptDestinationIdentifier,
  isDestinationTypeAllowed,
  maskAccountNumberLast4,
  parseUkBankIdentifier,
  validateDestinationIdentifier,
} from "./driverPayoutDestinationSSOT.ts";
import { PROVIDER_LINK_STATUS } from "./driverPayoutProviderLinkageSSOT.ts";
import { createRevolutCounterparty } from "./revolutApi.ts";
import { ensureFreshRevolutBusinessAccessToken } from "./revolutBusinessAccessTokenRefresh.ts";

export type UpdatePayoutDestinationInput = {
  destination_type: string;
  destination_identifier: string;
  account_holder_name?: string;
  device_id?: string;
};

function revolutRecipientAccountId(cp: { id: string; accounts?: Array<{ id?: string }> }): string | null {
  const accounts = Array.isArray(cp.accounts) ? cp.accounts : [];
  const first = accounts.find((a) => a?.id);
  return first?.id ? String(first.id) : null;
}

function safeLinkErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message.slice(0, 240);
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) return o.message.trim().slice(0, 240);
  }
  return "Revolut counterparty create failed";
}

async function attemptAutoRevolutLinkage(args: {
  supabase: SupabaseClient;
  destinationId: string;
  driverId: string;
  destinationType: string;
  destinationIdentifier: string;
  accountHolderName: string | null;
  currencyCode: string | null;
}): Promise<{
  verification_status: string;
  provider_link_status: string | null;
  provider_counterparty_id: string | null;
  provider_recipient_account_id: string | null;
  provider_error_code: string | null;
}> {
  const now = new Date().toISOString();
  if (
    args.destinationType !== "uk_bank_account"
  ) {
    return {
      verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
      provider_link_status: PROVIDER_LINK_STATUS.NOT_LINKED,
      provider_counterparty_id: null,
      provider_recipient_account_id: null,
      provider_error_code: null,
    };
  }

  try {
    const tokenResult = await ensureFreshRevolutBusinessAccessToken(args.supabase);
    const accessToken = String(tokenResult?.accessToken ?? "").trim();
    if (!accessToken) {
      await args.supabase.from("driver_payout_destinations").update({
        verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
        provider_link_status: PROVIDER_LINK_STATUS.FAILED,
        provider_sync_status: "failed",
        provider_last_checked_at: now,
        provider_error_code: "ACCESS_TOKEN_MISSING",
        provider_error_message_safe: "Revolut Business access token unavailable for auto-link.",
        updated_at: now,
      }).eq("id", args.destinationId);
      return {
        verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
        provider_link_status: PROVIDER_LINK_STATUS.FAILED,
        provider_counterparty_id: null,
        provider_recipient_account_id: null,
        provider_error_code: "ACCESS_TOKEN_MISSING",
      };
    }

    const cp = await createRevolutCounterparty({
      environment: "live",
      accessToken,
      destinationType: args.destinationType,
      destinationIdentifier: args.destinationIdentifier,
      accountHolderName: args.accountHolderName,
      currencyCode: args.currencyCode ?? "GBP",
    }) as { id: string; accounts?: Array<{ id?: string }> };

    const counterpartyId = String(cp.id ?? "").trim();
    const recipientId = revolutRecipientAccountId(cp);
    if (!counterpartyId) {
      throw new Error("PROVIDER_RESPONSE_INVALID");
    }

    await args.supabase.from("driver_payout_destinations").update({
      verification_status: DESTINATION_STATUS.PROVIDER_VERIFIED,
      provider_counterparty_id: counterpartyId,
      provider_recipient_account_id: recipientId,
      provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
      provider_sync_status: "synced",
      provider_synced_at: now,
      provider_last_checked_at: now,
      provider_error_code: null,
      provider_error_message_safe: null,
      verified_at: now,
      updated_at: now,
    }).eq("id", args.destinationId);

    await args.supabase.from("driver_payout_destination_audit").insert({
      driver_id: args.driverId,
      provider: "revolut",
      action: "provider_auto_linked",
      previous_payload: { verification_status: DESTINATION_STATUS.PENDING_VERIFICATION },
      new_payload: {
        verification_status: DESTINATION_STATUS.PROVIDER_VERIFIED,
        provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
      },
      changed_by_role: "system",
      new_payout_account_id: args.destinationId,
      metadata: { revolut_pay_called: false, wallet_mutated: false, auto_on_save: true },
    });

    return {
      verification_status: DESTINATION_STATUS.PROVIDER_VERIFIED,
      provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
      provider_counterparty_id: counterpartyId,
      provider_recipient_account_id: recipientId,
      provider_error_code: null,
    };
  } catch (err) {
    const msg = safeLinkErrorMessage(err);
    console.error("PAYOUT_DESTINATION_AUTO_LINK_FAILED", msg);
    await args.supabase.from("driver_payout_destinations").update({
      verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
      provider_link_status: PROVIDER_LINK_STATUS.FAILED,
      provider_sync_status: "failed",
      provider_last_checked_at: now,
      provider_error_code: "COUNTERPARTY_CREATE_FAILED",
      provider_error_message_safe: msg,
      updated_at: now,
    }).eq("id", args.destinationId);
    return {
      verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
      provider_link_status: PROVIDER_LINK_STATUS.FAILED,
      provider_counterparty_id: null,
      provider_recipient_account_id: null,
      provider_error_code: "COUNTERPARTY_CREATE_FAILED",
    };
  }
}

export async function handleUpdateDriverPayoutDestination(
  supabase: SupabaseClient,
  userId: string,
  body: UpdatePayoutDestinationInput,
  reqMeta?: { ip_address?: string | null },
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Content-Type": "application/json",
  };

  const resolved = await resolveAuthenticatedDriver(supabase, userId, "PAYOUT_DESTINATION");
  if (!resolved.ok) {
    const status =
      resolved.reason === "auth_user_missing" ? 401
      : resolved.reason === "rls_denied" ? 403
      : 404;
    return new Response(
      JSON.stringify({ error: resolved.reason, message: resolved.message }),
      { status, headers: corsHeaders },
    );
  }

  const driver = resolved.driver;
  const serviceAreaId = await resolveDriverServiceAreaId(supabase, driver.driver_id, null);
  if (!serviceAreaId) {
    return new Response(
      JSON.stringify({
        error: "PAYMENT_GATEWAY_NOT_CONFIGURED",
        message: "Driver payout gateway not selected for this service area",
      }),
      { status: 422, headers: corsHeaders },
    );
  }

  const gatewayCheck = await checkServiceAreaGateway(supabase, serviceAreaId, "driver");
  if (!gatewayCheck.ok) {
    return gatewayNotConfiguredResponse(gatewayCheck, corsHeaders);
  }

  const destinationType = body.destination_type?.trim() || "mobile_money";
  const destinationIdentifier = body.destination_identifier?.trim() ?? "";
  const accountHolderName = body.account_holder_name?.trim() || null;
  const provider = gatewayCheck.provider!;

  if (!isDestinationTypeAllowed(provider, destinationType)) {
    return new Response(
      JSON.stringify({
        error: "invalid_destination_type",
        message: "This payout destination type is not supported for your service area.",
      }),
      { status: 400, headers: corsHeaders },
    );
  }

  const formatCheck = validateDestinationIdentifier(destinationType, destinationIdentifier);
  if (!formatCheck.ok) {
    return new Response(
      JSON.stringify({ error: "invalid_destination", message: formatCheck.message }),
      { status: 400, headers: corsHeaders },
    );
  }

  const { data: areaRow } = await supabase
    .from("service_areas")
    .select("region_id, regions!inner(currency_code)")
    .eq("id", serviceAreaId)
    .maybeSingle();
  const region = areaRow?.regions as { currency_code?: string } | null;
  const currencyCode = region?.currency_code ?? "GBP";

  const last4 = destinationLast4(destinationIdentifier);
  const encrypted = await encryptDestinationIdentifier(destinationIdentifier);
  const uk = destinationType === "uk_bank_account"
    ? parseUkBankIdentifier(destinationIdentifier)
    : null;
  const sortMask = uk ? buildUkBankSortCodeMask(uk.sortCode) : null;
  const destinationLabel = buildMaskedDestinationLabel({
    provider,
    destinationType,
    destinationLast4: last4,
    accountHolderName,
  });

  const now = new Date().toISOString();

  const { data: existingActive } = await supabase
    .from("driver_payout_destinations")
    .select("id, destination_payload, destination_type, destination_last4, account_holder_name")
    .eq("driver_id", driver.driver_id)
    .eq("provider", provider)
    .eq("is_active", true)
    .is("archived_at", null)
    .maybeSingle();

  if (existingActive?.id) {
    await supabase
      .from("driver_payout_destinations")
      .update({ is_active: false, archived_at: now, updated_at: now })
      .eq("id", existingActive.id);
  }

  const safePayload = {
    destination_type: destinationType,
    destination_last4: last4,
    account_holder_name: accountHolderName,
  };

  const sortEnc = uk ? await encryptDestinationIdentifier(uk.sortCode) : null;
  const acctEnc = uk ? await encryptDestinationIdentifier(uk.accountNumber) : null;

  const { data: inserted, error: insertError } = await supabase
    .from("driver_payout_destinations")
    .insert({
      driver_id: driver.driver_id,
      service_area_id: serviceAreaId,
      provider,
      destination_type: destinationType,
      destination_label: destinationLabel,
      destination_last4: last4,
      account_last4: last4,
      account_holder_name: accountHolderName,
      currency_code: currencyCode,
      country_code: uk ? "GB" : null,
      destination_identifier_encrypted: encrypted,
      sort_code_encrypted: sortEnc,
      account_number_encrypted: acctEnc,
      masked_sort_code: sortMask?.masked_sort_code ?? null,
      sort_code_last2: sortMask?.sort_code_last2 ?? null,
      masked_account_number: maskAccountNumberLast4(last4),
      destination_payload: safePayload,
      verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
      provider_link_status: PROVIDER_LINK_STATUS.NOT_LINKED,
      is_active: true,
      updated_at: now,
    })
    .select("id")
    .single();

  if (insertError || !inserted?.id) {
    console.error("PAYOUT_DESTINATION_INSERT_FAILED", insertError?.message);
    return new Response(
      JSON.stringify({ error: "insert_failed", message: "Could not save payout destination." }),
      { status: 500, headers: corsHeaders },
    );
  }

  const { data: auditRow, error: auditError } = await supabase
    .from("driver_payout_destination_audit")
    .insert({
      driver_id: driver.driver_id,
      provider,
      action: existingActive ? "updated" : "created",
      previous_payload: existingActive
        ? {
          id: existingActive.id,
          destination_type: existingActive.destination_type,
          destination_last4: existingActive.destination_last4,
          account_holder_name: existingActive.account_holder_name,
        }
        : null,
      new_payload: safePayload,
      changed_by_user_id: userId,
      old_payout_account_id: existingActive?.id ?? null,
      new_payout_account_id: inserted.id,
      destination_type: destinationType,
      changed_by_role: "driver",
      device_id: body.device_id ?? null,
      ip_address: reqMeta?.ip_address ?? null,
      metadata: { service_area_id: serviceAreaId },
    })
    .select("id")
    .single();

  if (auditError) {
    console.warn("PAYOUT_DESTINATION_AUDIT_FAILED", auditError.message);
  }

  // Auto Revolut link for UK bank — save always succeeds; link failure stays pending.
  let linkResult = {
    verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
    provider_link_status: PROVIDER_LINK_STATUS.NOT_LINKED as string | null,
    provider_counterparty_id: null as string | null,
    provider_recipient_account_id: null as string | null,
    provider_error_code: null as string | null,
  };
  if (String(provider).toLowerCase() === "revolut" && destinationType === "uk_bank_account") {
    linkResult = await attemptAutoRevolutLinkage({
      supabase,
      destinationId: inserted.id,
      driverId: driver.driver_id,
      destinationType,
      destinationIdentifier,
      accountHolderName,
      currencyCode,
    });
  }

  return new Response(
    JSON.stringify({
      success: true,
      provider,
      display_name: gatewayCheck.display_name,
      audit_log_id: auditRow?.id ?? null,
      verification_status: linkResult.verification_status,
      provider_link_status: linkResult.provider_link_status,
      provider_auto_linked: linkResult.verification_status === DESTINATION_STATUS.PROVIDER_VERIFIED,
      active_destination: {
        id: inserted.id,
        destination_type: destinationType,
        destination_last4: last4,
        account_holder_name: accountHolderName,
        verification_status: linkResult.verification_status,
        provider_link_status: linkResult.provider_link_status,
        is_active: true,
        updated_at: now,
      },
      masked_destination: destinationLabel,
      destination: {
        destination_type: destinationType,
        destination_label: destinationLabel,
        destination_last4: last4,
        verification_status: linkResult.verification_status,
        is_active: true,
        updated_at: now,
      },
    }),
    { headers: corsHeaders },
  );
}
