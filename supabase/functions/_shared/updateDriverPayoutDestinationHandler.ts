/**
 * Shared handler: update driver payout destination.
 * A8B28F Stage B2: sync UK/Revolut link failure → HTTP 422 (no false success).
 * Idempotent retry via linkage_version. Never fabricates PROVIDER_VERIFIED /
 * MANUAL_VERIFIED. Never writes payouts_enabled / payout_operational_paused.
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
import {
  PAYOUT_DESTINATION_OUTCOME,
  PROVIDER_LINK_FAILURE_CLASS,
  classifyCounterpartyCreateFailure,
  driverFacingMessageForOutcome,
  httpStatusForOutcome,
  inferCounterpartyFailureSignals,
  isClientSuccessOutcome,
  providerErrorCodeForFailureClass,
  resolveSyncUkRevolutOutcome,
  safeProviderErrorMessageForFailure,
  type PayoutDestinationOutcome,
  type ProviderLinkFailureClass,
} from "./payoutDestinationVerificationOutcomeSSOT.ts";

export type UpdatePayoutDestinationInput = {
  destination_type: string;
  destination_identifier: string;
  account_holder_name?: string;
  device_id?: string;
  /** When true, retry linkage on the current active row without inserting a duplicate. */
  retry_existing?: boolean;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Content-Type": "application/json",
};

function revolutRecipientAccountId(cp: { id: string; accounts?: Array<{ id?: string }> }): string | null {
  const accounts = Array.isArray(cp.accounts) ? cp.accounts : [];
  const first = accounts.find((a) => a?.id);
  return first?.id ? String(first.id) : null;
}

function extractHttpStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err) {
    const n = Number((err as { status?: unknown }).status);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function safeLinkErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message.slice(0, 240);
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) return o.message.trim().slice(0, 240);
  }
  return "Revolut counterparty create failed";
}

type LinkResult = {
  verification_status: string;
  provider_link_status: string | null;
  provider_counterparty_id: string | null;
  provider_recipient_account_id: string | null;
  provider_error_code: string | null;
  failure_class: ProviderLinkFailureClass | null;
  http_status: number | null;
};

/** Test-only injection — production uses live Revolut helpers. */
export type RevolutLinkageDeps = {
  ensureToken?: (supabase: SupabaseClient) => Promise<{ accessToken?: string | null } | null>;
  createCounterparty?: (args: {
    environment: string;
    accessToken: string;
    destinationType: string;
    destinationIdentifier: string;
    accountHolderName: string | null;
    currencyCode: string;
  }) => Promise<{ id: string; accounts?: Array<{ id?: string }> }>;
};

function mergeFailureTruthIntoPayload(
  existing: unknown,
  failureClass: ProviderLinkFailureClass | null,
  httpStatus: number | null,
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  return {
    ...base,
    provider_link_failure_class: failureClass,
    provider_http_status: httpStatus,
  };
}

/**
 * Audit actions allowed by live CHECK today:
 * created | updated | deactivated | provider_link_blocked | provider_link_synced | reject | disable
 * B2R maps auto-link success/failure onto synced/blocked so inserts succeed.
 */
const AUDIT_ACTION_LINK_SYNCED = "provider_link_synced";
const AUDIT_ACTION_LINK_BLOCKED = "provider_link_blocked";

/** Exported for mocked Deno tests only — never call provider from production probes. */
export async function attemptAutoRevolutLinkage(args: {
  supabase: SupabaseClient;
  destinationId: string;
  driverId: string;
  /** Required for audit NOT NULL changed_by_user_id (initiating driver JWT subject). */
  actorUserId: string;
  destinationType: string;
  destinationIdentifier: string;
  accountHolderName: string | null;
  currencyCode: string | null;
  expectedLinkageVersion: number;
  deps?: RevolutLinkageDeps;
}): Promise<LinkResult> {
  const now = new Date().toISOString();
  if (args.destinationType !== "uk_bank_account") {
    return {
      verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
      provider_link_status: PROVIDER_LINK_STATUS.NOT_LINKED,
      provider_counterparty_id: null,
      provider_recipient_account_id: null,
      provider_error_code: null,
      failure_class: null,
      http_status: null,
    };
  }

  const ensureToken = args.deps?.ensureToken ?? ensureFreshRevolutBusinessAccessToken;
  const createCounterparty = args.deps?.createCounterparty ?? createRevolutCounterparty;

  try {
    const tokenResult = await ensureToken(args.supabase);
    const accessToken = String(tokenResult?.accessToken ?? "").trim();
    if (!accessToken) {
      const failure_class = classifyCounterpartyCreateFailure({ access_token_missing: true });
      const provider_error_code = "ACCESS_TOKEN_MISSING";
      const provider_error_message_safe = safeProviderErrorMessageForFailure({
        failureClass: failure_class,
        providerMessageSafe: "Revolut Business access token unavailable for auto-link.",
      });
      const { data: cur } = await args.supabase
        .from("driver_payout_destinations")
        .select("destination_payload")
        .eq("id", args.destinationId)
        .maybeSingle();
      await args.supabase.from("driver_payout_destinations").update({
        verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
        provider_link_status: PROVIDER_LINK_STATUS.FAILED,
        provider_sync_status: "failed",
        provider_last_checked_at: now,
        provider_error_code,
        provider_error_message_safe,
        provider_link_failure_class: failure_class,
        provider_http_status: null,
        destination_payload: mergeFailureTruthIntoPayload(
          cur?.destination_payload,
          failure_class,
          null,
        ),
        linkage_version: args.expectedLinkageVersion + 1,
        updated_at: now,
      }).eq("id", args.destinationId).eq("linkage_version", args.expectedLinkageVersion);
      await args.supabase.from("driver_payout_destination_audit").insert({
        driver_id: args.driverId,
        provider: "revolut",
        action: AUDIT_ACTION_LINK_BLOCKED,
        new_payload: {
          provider_link_status: PROVIDER_LINK_STATUS.FAILED,
          provider_error_code,
          failure_class,
          http_status: null,
        },
        changed_by_role: "system",
        changed_by_user_id: args.actorUserId,
        new_payout_account_id: args.destinationId,
        metadata: {
          revolut_pay_called: false,
          wallet_mutated: false,
          audit_kind: "provider_auto_link_failed",
        },
      });
      return {
        verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
        provider_link_status: PROVIDER_LINK_STATUS.FAILED,
        provider_counterparty_id: null,
        provider_recipient_account_id: null,
        provider_error_code,
        failure_class,
        http_status: null,
      };
    }

    const cp = await createCounterparty({
      environment: "live",
      accessToken,
      destinationType: args.destinationType,
      destinationIdentifier: args.destinationIdentifier,
      accountHolderName: args.accountHolderName,
      currencyCode: args.currencyCode ?? "GBP",
    }) as { id: string; accounts?: Array<{ id?: string }> };

    const counterpartyId = String(cp.id ?? "").trim();
    const recipientId = revolutRecipientAccountId(cp);
    if (!counterpartyId || !recipientId) {
      throw Object.assign(new Error("PROVIDER_RESPONSE_INVALID"), { status: 502 });
    }

    const { data: updated, error: updErr } = await args.supabase
      .from("driver_payout_destinations")
      .update({
        verification_status: DESTINATION_STATUS.PROVIDER_VERIFIED,
        provider_counterparty_id: counterpartyId,
        provider_recipient_account_id: recipientId,
        provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
        provider_sync_status: "synced",
        provider_synced_at: now,
        provider_last_checked_at: now,
        provider_error_code: null,
        provider_error_message_safe: null,
        provider_link_failure_class: null,
        provider_http_status: null,
        verified_at: now,
        linkage_version: args.expectedLinkageVersion + 1,
        updated_at: now,
      })
      .eq("id", args.destinationId)
      .eq("linkage_version", args.expectedLinkageVersion)
      .select("id")
      .maybeSingle();

    if (updErr || !updated?.id) {
      // Concurrent retry won — do not create another counterparty; never overwrite success.
      return {
        verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
        provider_link_status: PROVIDER_LINK_STATUS.FAILED,
        provider_counterparty_id: null,
        provider_recipient_account_id: null,
        provider_error_code: "CONCURRENT_LINK_UPDATE",
        failure_class: PROVIDER_LINK_FAILURE_CLASS.RETRYABLE_TRANSIENT,
        http_status: 409,
      };
    }

    await args.supabase.from("driver_payout_destination_audit").insert({
      driver_id: args.driverId,
      provider: "revolut",
      action: AUDIT_ACTION_LINK_SYNCED,
      previous_payload: { verification_status: DESTINATION_STATUS.PENDING_VERIFICATION },
      new_payload: {
        verification_status: DESTINATION_STATUS.PROVIDER_VERIFIED,
        provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
        has_counterparty_ref: true,
        has_recipient_ref: true,
      },
      changed_by_role: "system",
      changed_by_user_id: args.actorUserId,
      new_payout_account_id: args.destinationId,
      metadata: {
        revolut_pay_called: false,
        wallet_mutated: false,
        auto_on_save: true,
        audit_kind: "provider_auto_linked",
      },
    });

    return {
      verification_status: DESTINATION_STATUS.PROVIDER_VERIFIED,
      provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
      provider_counterparty_id: counterpartyId,
      provider_recipient_account_id: recipientId,
      provider_error_code: null,
      failure_class: null,
      http_status: 200,
    };
  } catch (err) {
    const http_status = extractHttpStatus(err);
    const msg = safeLinkErrorMessage(err);
    const signals = inferCounterpartyFailureSignals(msg);
    const failure_class = classifyCounterpartyCreateFailure({
      provider_error_code: "COUNTERPARTY_CREATE_FAILED",
      http_status,
      ...signals,
    });
    // Normalized logs only — never bank details / raw provider body.
    console.error("PAYOUT_DESTINATION_AUTO_LINK_FAILED", failure_class, http_status);

    const provider_error_code = providerErrorCodeForFailureClass(failure_class);
    const provider_error_message_safe = safeProviderErrorMessageForFailure({
      failureClass: failure_class,
      providerMessageSafe: msg,
      httpStatus: http_status,
    });

    const { data: cur } = await args.supabase
      .from("driver_payout_destinations")
      .select("destination_payload")
      .eq("id", args.destinationId)
      .maybeSingle();

    const { data: failedUpdated } = await args.supabase
      .from("driver_payout_destinations")
      .update({
        // Keep PENDING_VERIFICATION column value for schema compatibility, but
        // provider_link_status=FAILED is the Driver UI authority (never ordinary Pending).
        verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
        provider_link_status: PROVIDER_LINK_STATUS.FAILED,
        provider_sync_status: "failed",
        provider_last_checked_at: now,
        provider_error_code,
        provider_error_message_safe,
        provider_link_failure_class: failure_class,
        provider_http_status: http_status,
        destination_payload: mergeFailureTruthIntoPayload(
          cur?.destination_payload,
          failure_class,
          http_status,
        ),
        linkage_version: args.expectedLinkageVersion + 1,
        updated_at: now,
      })
      .eq("id", args.destinationId)
      .eq("linkage_version", args.expectedLinkageVersion)
      .select("id")
      .maybeSingle();

    if (!failedUpdated?.id) {
      // Newer success/failure already committed — do not overwrite.
      return {
        verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
        provider_link_status: PROVIDER_LINK_STATUS.FAILED,
        provider_counterparty_id: null,
        provider_recipient_account_id: null,
        provider_error_code: "STALE_FAILURE_NOT_APPLIED",
        failure_class: PROVIDER_LINK_FAILURE_CLASS.RETRYABLE_TRANSIENT,
        http_status: 409,
      };
    }

    await args.supabase.from("driver_payout_destination_audit").insert({
      driver_id: args.driverId,
      provider: "revolut",
      action: AUDIT_ACTION_LINK_BLOCKED,
      new_payload: {
        provider_link_status: PROVIDER_LINK_STATUS.FAILED,
        provider_error_code,
        failure_class,
        http_status,
      },
      changed_by_role: "system",
      changed_by_user_id: args.actorUserId,
      new_payout_account_id: args.destinationId,
      metadata: {
        revolut_pay_called: false,
        wallet_mutated: false,
        audit_kind: "provider_auto_link_failed",
      },
    });

    return {
      verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
      provider_link_status: PROVIDER_LINK_STATUS.FAILED,
      provider_counterparty_id: null,
      provider_recipient_account_id: null,
      provider_error_code,
      failure_class,
      http_status,
    };
  }
}

function outcomeFromLinkResult(linkResult: LinkResult, saveOk: boolean): PayoutDestinationOutcome {
  if (
    linkResult.failure_class === PROVIDER_LINK_FAILURE_CLASS.DUPLICATE_COUNTERPARTY_RECONCILIATION_REQUIRED ||
    linkResult.provider_error_code === "CONCURRENT_LINK_UPDATE" ||
    linkResult.provider_error_code === "STALE_FAILURE_NOT_APPLIED"
  ) {
    return PAYOUT_DESTINATION_OUTCOME.RETRY_REQUIRED;
  }
  return resolveSyncUkRevolutOutcome({
    saveOk,
    linkStatus: linkResult.provider_link_status,
    verificationStatus: linkResult.verification_status,
    hasCounterpartyRef: !!linkResult.provider_counterparty_id,
    hasRecipientRef: !!linkResult.provider_recipient_account_id,
  });
}

function responseForOutcome(args: {
  outcome: PayoutDestinationOutcome;
  provider: string;
  displayName: string | null | undefined;
  auditLogId: string | null;
  linkResult: LinkResult;
  activeDestination: Record<string, unknown>;
  maskedDestination: string;
  last4: string | null;
  destinationType: string;
  now: string;
}): Response {
  const success = isClientSuccessOutcome(args.outcome);
  const status = httpStatusForOutcome(args.outcome);
  return new Response(
    JSON.stringify({
      success,
      outcome: args.outcome,
      failure_class: args.linkResult.failure_class,
      provider_http_status: args.linkResult.http_status,
      message: driverFacingMessageForOutcome(args.outcome, args.linkResult.failure_class),
      provider: args.provider,
      display_name: args.displayName,
      audit_log_id: args.auditLogId,
      verification_status: args.linkResult.verification_status,
      provider_link_status: args.linkResult.provider_link_status,
      provider_auto_linked: args.linkResult.verification_status === DESTINATION_STATUS.PROVIDER_VERIFIED,
      provider_error_code: args.linkResult.provider_error_code,
      active_destination: args.activeDestination,
      masked_destination: args.maskedDestination,
      destination: {
        destination_type: args.destinationType,
        destination_label: args.maskedDestination,
        destination_last4: args.last4,
        verification_status: args.linkResult.verification_status,
        provider_link_status: args.linkResult.provider_link_status,
        is_active: true,
        updated_at: args.now,
      },
    }),
    { status, headers: corsHeaders },
  );
}

export async function handleUpdateDriverPayoutDestination(
  supabase: SupabaseClient,
  userId: string,
  body: UpdatePayoutDestinationInput,
  reqMeta?: { ip_address?: string | null },
): Promise<Response> {
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
  const now = new Date().toISOString();

  // Idempotent retry path: reuse active row; never insert a second active destination.
  if (body.retry_existing === true) {
    const { data: active } = await supabase
      .from("driver_payout_destinations")
      .select(
        "id, destination_type, destination_last4, account_holder_name, verification_status, provider_link_status, provider_counterparty_id, provider_recipient_account_id, linkage_version, destination_identifier_encrypted",
      )
      .eq("driver_id", driver.driver_id)
      .eq("is_active", true)
      .is("archived_at", null)
      .maybeSingle();

    if (!active?.id) {
      return new Response(
        JSON.stringify({
          success: false,
          outcome: PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVE_FAILED,
          error: "no_active_destination",
          message: "No payout account to retry. Add your details again.",
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    if (
      String(active.provider_link_status ?? "").toUpperCase() === "PROVIDER_VERIFIED" &&
      active.provider_counterparty_id &&
      active.provider_recipient_account_id
    ) {
      return responseForOutcome({
        outcome: PAYOUT_DESTINATION_OUTCOME.DESTINATION_ALREADY_VERIFIED,
        provider,
        displayName: gatewayCheck.display_name,
        auditLogId: null,
        linkResult: {
          verification_status: DESTINATION_STATUS.PROVIDER_VERIFIED,
          provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
          provider_counterparty_id: String(active.provider_counterparty_id),
          provider_recipient_account_id: String(active.provider_recipient_account_id),
          provider_error_code: null,
          failure_class: null,
          http_status: 200,
        },
        activeDestination: {
          id: active.id,
          destination_type: active.destination_type,
          destination_last4: active.destination_last4,
          account_holder_name: active.account_holder_name,
          verification_status: DESTINATION_STATUS.PROVIDER_VERIFIED,
          provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
          is_active: true,
          updated_at: now,
        },
        maskedDestination: buildMaskedDestinationLabel({
          provider,
          destinationType: String(active.destination_type ?? destinationType),
          destinationLast4: active.destination_last4 ?? null,
          accountHolderName: active.account_holder_name ?? null,
        }),
        last4: active.destination_last4 ?? null,
        destinationType: String(active.destination_type ?? destinationType),
        now,
      });
    }

    // Retry requires fresh identifier in body (client re-submits). Decrypt path intentionally avoided here.
    if (!destinationIdentifier) {
      return new Response(
        JSON.stringify({
          success: false,
          outcome: PAYOUT_DESTINATION_OUTCOME.RETRY_REQUIRED,
          error: "destination_identifier_required_for_retry",
          message: driverFacingMessageForOutcome(PAYOUT_DESTINATION_OUTCOME.RETRY_REQUIRED),
        }),
        { status: 422, headers: corsHeaders },
      );
    }

    const linkResult = await attemptAutoRevolutLinkage({
      supabase,
      destinationId: active.id,
      driverId: driver.driver_id,
      actorUserId: userId,
      destinationType: String(active.destination_type ?? "uk_bank_account"),
      destinationIdentifier,
      accountHolderName: accountHolderName ?? active.account_holder_name ?? null,
      currencyCode: "GBP",
      expectedLinkageVersion: Number(active.linkage_version ?? 1),
    });

    const outcome = outcomeFromLinkResult(linkResult, true);

    return responseForOutcome({
      outcome,
      provider,
      displayName: gatewayCheck.display_name,
      auditLogId: null,
      linkResult,
      activeDestination: {
        id: active.id,
        destination_type: active.destination_type,
        destination_last4: active.destination_last4,
        account_holder_name: active.account_holder_name,
        verification_status: linkResult.verification_status,
        provider_link_status: linkResult.provider_link_status,
        is_active: true,
        updated_at: now,
      },
      maskedDestination: buildMaskedDestinationLabel({
        provider,
        destinationType: String(active.destination_type ?? destinationType),
        destinationLast4: active.destination_last4 ?? null,
        accountHolderName: active.account_holder_name ?? null,
      }),
      last4: active.destination_last4 ?? null,
      destinationType: String(active.destination_type ?? destinationType),
      now,
    });
  }

  if (!isDestinationTypeAllowed(provider, destinationType)) {
    return new Response(
      JSON.stringify({
        error: "invalid_destination_type",
        outcome: PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVE_FAILED,
        message: "This payout destination type is not supported for your service area.",
      }),
      { status: 400, headers: corsHeaders },
    );
  }

  const formatCheck = validateDestinationIdentifier(destinationType, destinationIdentifier);
  if (!formatCheck.ok) {
    return new Response(
      JSON.stringify({
        error: "invalid_destination",
        outcome: PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVE_FAILED,
        message: formatCheck.message,
      }),
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
      linkage_version: 1,
      is_active: true,
      updated_at: now,
    })
    .select("id, linkage_version")
    .single();

  if (insertError || !inserted?.id) {
    console.error("PAYOUT_DESTINATION_INSERT_FAILED", insertError?.message);
    return new Response(
      JSON.stringify({
        error: "insert_failed",
        outcome: PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVE_FAILED,
        message: "Could not save payout destination.",
      }),
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

  let linkResult: LinkResult = {
    verification_status: DESTINATION_STATUS.PENDING_VERIFICATION,
    provider_link_status: PROVIDER_LINK_STATUS.NOT_LINKED,
    provider_counterparty_id: null,
    provider_recipient_account_id: null,
    provider_error_code: null,
    failure_class: null,
    http_status: null,
  };

  if (String(provider).toLowerCase() === "revolut" && destinationType === "uk_bank_account") {
    linkResult = await attemptAutoRevolutLinkage({
      supabase,
      destinationId: inserted.id,
      driverId: driver.driver_id,
      actorUserId: userId,
      destinationType,
      destinationIdentifier,
      accountHolderName,
      currencyCode,
      expectedLinkageVersion: Number(inserted.linkage_version ?? 1),
    });
  }

  const outcome = outcomeFromLinkResult(linkResult, true);

  return responseForOutcome({
    outcome,
    provider,
    displayName: gatewayCheck.display_name,
    auditLogId: auditRow?.id ?? null,
    linkResult,
    activeDestination: {
      id: inserted.id,
      destination_type: destinationType,
      destination_last4: last4,
      account_holder_name: accountHolderName,
      verification_status: linkResult.verification_status,
      provider_link_status: linkResult.provider_link_status,
      is_active: true,
      updated_at: now,
    },
    maskedDestination: destinationLabel,
    last4,
    destinationType,
    now,
  });
}
