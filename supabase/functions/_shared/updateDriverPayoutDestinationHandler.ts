/**
 * Shared handler: update driver payout destination (archive previous + insert active).
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
  destinationLast4,
  encryptDestinationIdentifier,
  isDestinationTypeAllowed,
  validateDestinationIdentifier,
} from "./driverPayoutDestinationSSOT.ts";

export type UpdatePayoutDestinationInput = {
  destination_type: string;
  destination_identifier: string;
  account_holder_name?: string;
  device_id?: string;
};

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
  const currencyCode = region?.currency_code ?? null;

  const last4 = destinationLast4(destinationIdentifier);
  const encrypted = await encryptDestinationIdentifier(destinationIdentifier);
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

  const { data: inserted, error: insertError } = await supabase
    .from("driver_payout_destinations")
    .insert({
      driver_id: driver.driver_id,
      service_area_id: serviceAreaId,
      provider,
      destination_type: destinationType,
      destination_label: destinationLabel,
      destination_last4: last4,
      account_holder_name: accountHolderName,
      currency_code: currencyCode,
      destination_identifier_encrypted: encrypted,
      destination_payload: safePayload,
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

  return new Response(
    JSON.stringify({
      success: true,
      provider,
      display_name: gatewayCheck.display_name,
      audit_log_id: auditRow?.id ?? null,
      active_destination: {
        id: inserted.id,
        destination_type: destinationType,
        destination_last4: last4,
        account_holder_name: accountHolderName,
        is_active: true,
        updated_at: now,
      },
      masked_destination: destinationLabel,
      destination: {
        destination_type: destinationType,
        destination_label: destinationLabel,
        destination_last4: last4,
        is_active: true,
        updated_at: now,
      },
    }),
    { headers: corsHeaders },
  );
}
