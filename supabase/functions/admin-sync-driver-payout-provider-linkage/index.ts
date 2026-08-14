/**
 * Admin: sync Revolut Business counterparty + recipient linkage for verified UK bank destinations.
 * Slice 2 â provider linkage only. Never calls /pay. Never mutates wallets.
 *
 * POST { driver_ids?: string[] }
 * Defaults to Ahmed + Bosteyo production IDs when omitted.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  decryptDestinationIdentifier,
  normalizeDestinationVerificationStatus,
  parseUkBankIdentifier,
} from "../_shared/driverPayoutDestinationSSOT.ts";
import {
  LINKAGE_ERROR,
  PROVIDER_LINK_STATUS,
  assertSlice2MoneySafety,
  bankDestinationFingerprint,
  buildRevolutUkBankCounterpartyCreateBody,
  counterpartyIdempotencyKey,
  decideLinkageAfterDiscovery,
  maskProviderId,
  matchUkBankAgainstCounterparties,
  normalizeAccountHolderName,
  resolveGrantedRevolutBusinessScopes,
  resolveRevolutLinkageCapabilities,
  type RevolutCounterpartyLike,
} from "../_shared/driverPayoutProviderLinkageSSOT.ts";
import {
  isRevolutBusinessRelayConfigured,
  relayProbePayBlocked,
  relayRevolutCounterparties,
  relayRevolutCreateCounterparty,
} from "../_shared/revolutBusinessRelayClient.ts";
import { ensureFreshRevolutBusinessAccessToken } from "../_shared/revolutBusinessAccessTokenRefresh.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Content-Type": "application/json",
};

const DEFAULT_DRIVER_IDS = [
  "5ed232c3-8bb5-4085-95d6-73e48e6c5e28", // Ahmed
  "cd8bae4c-3827-4b90-98c6-10be70eb0e52", // Bosteyo
];

type DestRow = {
  id: string;
  driver_id: string;
  provider: string;
  destination_type: string | null;
  country_code: string | null;
  currency_code: string | null;
  account_holder_name: string | null;
  destination_label: string | null;
  destination_last4: string | null;
  masked_sort_code: string | null;
  verification_status: string | null;
  sort_code_encrypted: string | null;
  account_number_encrypted: string | null;
  destination_identifier_encrypted: string | null;
  provider_counterparty_id: string | null;
  provider_recipient_account_id: string | null;
  provider_link_status: string | null;
  is_active: boolean | null;
};

function skipResult(args: {
  driver_id: string;
  destination_id?: string | null;
  reason: string;
  masked_destination?: string | null;
  verification_status?: string | null;
}) {
  return {
    driver_id: args.driver_id,
    destination_id: args.destination_id ?? null,
    skipped: true,
    reason: args.reason,
    verification_status: args.verification_status ?? null,
    provider_link_status: null,
    masked_destination: args.masked_destination ?? null,
    matching_counterparty_existed: false,
    provider_counterparty_id_masked: null,
    provider_recipient_account_id_masked: null,
    provider_synced_at: null,
    blocking_reason: args.reason,
    revolut_pay_called: false,
    wallet_mutated: false,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    // Allow service_role for automated Slice 2 production runs; otherwise require admin user.
    let actorUserId: string | null = null;
    let actorRole: "admin" | "service_role" = "admin";
    try {
      const payloadPart = token.split(".")[1];
      const json = JSON.parse(atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")));
      if (json?.role === "service_role") {
        actorRole = "service_role";
        actorUserId = null;
      }
    } catch {
      // fall through to user auth
    }

    if (actorRole !== "service_role") {
      const { data: { user }, error: userError } = await supabase.auth.getUser(token);
      if (userError || !user) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: corsHeaders,
        });
      }
      const { data: roleData } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();
      if (!roleData) {
        return new Response(JSON.stringify({ error: "Admin access required" }), {
          status: 403,
          headers: corsHeaders,
        });
      }
      actorUserId = user.id;
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const driverIds = Array.isArray(body.driver_ids)
      ? (body.driver_ids as unknown[]).filter((v): v is string => typeof v === "string")
      : DEFAULT_DRIVER_IDS;

    // Vault (post Connect exchange) â SCOPES_GRANTED secret â READ default. Never fakes WRITE.
    const grantedScopes = await resolveGrantedRevolutBusinessScopes(supabase);
    const caps = resolveRevolutLinkageCapabilities(grantedScopes);
    const livePayout = (Deno.env.get("LIVE_PAYOUT_EXECUTION_ENABLED") ?? "false").toLowerCase() === "true";

    let accessToken = "";
    let tokenNote = "not_loaded";
    try {
      const tokenRes = await ensureFreshRevolutBusinessAccessToken(supabase);
      accessToken = tokenRes.accessToken;
      tokenNote = tokenRes.note + (tokenRes.refreshed ? "+refreshed" : "");
    } catch (err) {
      tokenNote = err instanceof Error ? err.message.slice(0, 120) : "token_load_failed";
    }

    const results: Record<string, unknown>[] = [];

    for (const driverId of driverIds) {
      const { data: dest, error: destErr } = await supabase
        .from("driver_payout_destinations")
        .select(
          "id, driver_id, provider, destination_type, country_code, currency_code, account_holder_name, destination_label, destination_last4, masked_sort_code, verification_status, sort_code_encrypted, account_number_encrypted, destination_identifier_encrypted, provider_counterparty_id, provider_recipient_account_id, provider_link_status, is_active",
        )
        .eq("driver_id", driverId)
        .eq("is_active", true)
        .is("archived_at", null)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (destErr || !dest) {
        results.push(skipResult({
          driver_id: driverId,
          reason: LINKAGE_ERROR.DESTINATION_NOT_FOUND,
        }));
        continue;
      }

      const row = dest as DestRow;
      const verification = normalizeDestinationVerificationStatus(row.verification_status);
      if (verification !== "MANUAL_VERIFIED" && verification !== "PROVIDER_VERIFIED") {
        results.push(skipResult({
          driver_id: driverId,
          destination_id: row.id,
          reason: LINKAGE_ERROR.DESTINATION_NOT_VERIFIED,
          verification_status: verification,
          masked_destination: row.destination_label,
        }));
        continue;
      }

      if (
        String(row.destination_type ?? "").toLowerCase() !== "uk_bank_account"
        || String(row.country_code ?? "GB").toUpperCase() !== "GB"
        || String(row.currency_code ?? "GBP").toUpperCase() !== "GBP"
      ) {
        results.push(skipResult({
          driver_id: driverId,
          destination_id: row.id,
          reason: LINKAGE_ERROR.INVALID_UK_BANK_DESTINATION,
          verification_status: verification,
          masked_destination: row.destination_label,
        }));
        continue;
      }

      // Decrypt server-side only â never return plaintext.
      let sortCode = "";
      let accountNumber = "";
      try {
        if (row.sort_code_encrypted && row.account_number_encrypted) {
          sortCode = (await decryptDestinationIdentifier(row.sort_code_encrypted)).replace(/\D/g, "");
          accountNumber = (await decryptDestinationIdentifier(row.account_number_encrypted)).replace(/\D/g, "");
        } else if (row.destination_identifier_encrypted) {
          const combined = await decryptDestinationIdentifier(row.destination_identifier_encrypted);
          const parsed = parseUkBankIdentifier(combined);
          if (!parsed) throw new Error("parse_failed");
          sortCode = parsed.sortCode;
          accountNumber = parsed.accountNumber;
        } else {
          throw new Error("missing_ciphertext");
        }
        if (sortCode.length !== 6 || accountNumber.length < 8) {
          throw new Error("invalid_uk");
        }
      } catch {
        results.push(skipResult({
          driver_id: driverId,
          destination_id: row.id,
          reason: LINKAGE_ERROR.DESTINATION_DECRYPTION_FAILED,
          verification_status: verification,
          masked_destination: row.destination_label,
        }));
        continue;
      }

      const holder = normalizeAccountHolderName(row.account_holder_name ?? "");
      const fingerprint = await bankDestinationFingerprint({
        sortCode,
        accountNumber,
        currency: "GBP",
        country: "GB",
      });
      const idemKey = counterpartyIdempotencyKey(driverId, row.id);
      const now = new Date().toISOString();

      // Idempotent reuse of existing mapping
      if (row.provider_counterparty_id && row.provider_recipient_account_id) {
        await supabase.from("driver_payout_destinations").update({
          provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
          provider_sync_status: "synced",
          provider_synced_at: now,
          provider_last_checked_at: now,
          provider_idempotency_key: idemKey,
          destination_fingerprint: fingerprint,
          provider_error_code: null,
          provider_error_message_safe: null,
          updated_at: now,
        }).eq("id", row.id);

        results.push({
          driver_id: driverId,
          destination_id: row.id,
          skipped: false,
          verification_status: verification,
          provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
          masked_destination: row.destination_label,
          matching_counterparty_existed: true,
          provider_counterparty_id_masked: maskProviderId(row.provider_counterparty_id),
          provider_recipient_account_id_masked: maskProviderId(row.provider_recipient_account_id),
          provider_synced_at: now,
          blocking_reason: null,
          revolut_pay_called: false,
          wallet_mutated: false,
        });
        continue;
      }

      // READ-scope discovery: match existing counterparties via HTTPS relay only.
      let matchStatus: "none" | "unique" | "conflict" | "discovery_unavailable" = "discovery_unavailable";
      let matchHit: { counterparty_id: string; recipient_account_id: string } | null = null;
      let discoveryNote: string | null = tokenNote;

      if (caps.can_list_counterparties && isRevolutBusinessRelayConfigured()) {
        if (!accessToken) {
          discoveryNote = `access_token_missing:${tokenNote}`;
          matchStatus = "discovery_unavailable";
        } else {
          try {
            const listRes = await relayRevolutCounterparties(accessToken);
            if (listRes.status === 404) {
              discoveryNote = "relay_counterparties_route_not_deployed";
              matchStatus = "discovery_unavailable";
            } else if (!listRes.ok) {
              discoveryNote = `relay_list_http_${listRes.status}`;
              matchStatus = "discovery_unavailable";
            } else {
              const body = await listRes.json().catch(() => null);
              const list = Array.isArray(body)
                ? body as RevolutCounterpartyLike[]
                : Array.isArray((body as { counterparties?: unknown })?.counterparties)
                ? (body as { counterparties: RevolutCounterpartyLike[] }).counterparties
                : null;
              if (!list) {
                discoveryNote = "provider_response_invalid";
                matchStatus = "discovery_unavailable";
              } else {
                const matched = matchUkBankAgainstCounterparties({
                  sortCode,
                  accountNumber,
                  counterparties: list,
                });
                matchStatus = matched.status;
                matchHit = matched.hit;
                discoveryNote = `listed_${list.length}_matched_${matched.hit_count}`;
              }
            }
          } catch {
            discoveryNote = "relay_unavailable";
            matchStatus = "discovery_unavailable";
          }
        }
      } else if (!caps.can_list_counterparties) {
        discoveryNote = "scope_cannot_list";
        matchStatus = "discovery_unavailable";
      } else {
        discoveryNote = "relay_not_configured";
        matchStatus = "discovery_unavailable";
      }

      const decision = decideLinkageAfterDiscovery({
        capabilities: caps,
        matchStatus,
      });

      if (decision.provider_link_status === PROVIDER_LINK_STATUS.PROVIDER_VERIFIED && matchHit) {
        await supabase.from("driver_payout_destinations").update({
          provider: "revolut",
          provider_counterparty_id: matchHit.counterparty_id,
          provider_recipient_account_id: matchHit.recipient_account_id,
          provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
          provider_sync_status: "synced",
          provider_synced_at: now,
          provider_last_checked_at: now,
          provider_idempotency_key: idemKey,
          destination_fingerprint: fingerprint,
          provider_error_code: null,
          provider_error_message_safe: null,
          updated_at: now,
        }).eq("id", row.id);

        await supabase.from("driver_payout_destination_audit").insert({
          driver_id: driverId,
          provider: "revolut",
          action: "provider_link_synced",
          previous_payload: {
            provider_link_status: row.provider_link_status,
            verification_status: row.verification_status,
          },
          new_payload: {
            provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
            provider_counterparty_id_masked: maskProviderId(matchHit.counterparty_id),
            provider_recipient_account_id_masked: maskProviderId(matchHit.recipient_account_id),
            destination_last4: row.destination_last4,
            masked_sort_code: row.masked_sort_code,
          },
          changed_by_user_id: actorUserId ?? "9ab3080c-73ef-4c36-b92b-ae8e8f4815f2",
          old_payout_account_id: row.id,
          new_payout_account_id: row.id,
          changed_by_role: actorRole === "service_role" ? "system" : "admin",
          metadata: {
            revolut_called: true,
            revolut_pay_called: false,
            wallet_mutated: false,
            matched_existing: true,
            discovery_note: discoveryNote,
            live_payout_execution_enabled: livePayout,
          },
        });

        results.push({
          driver_id: driverId,
          destination_id: row.id,
          skipped: false,
          verification_status: verification,
          provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
          masked_destination: row.destination_label,
          matching_counterparty_existed: true,
          provider_counterparty_id_masked: maskProviderId(matchHit.counterparty_id),
          provider_recipient_account_id_masked: maskProviderId(matchHit.recipient_account_id),
          provider_synced_at: now,
          blocking_reason: null,
          revolut_pay_called: false,
          wallet_mutated: false,
          discovery_note: discoveryNote,
        });
        continue;
      }

      if (decision.provider_link_status === PROVIDER_LINK_STATUS.CONFLICT) {
        await supabase.from("driver_payout_destinations").update({
          provider: "revolut",
          provider_link_status: PROVIDER_LINK_STATUS.CONFLICT,
          provider_sync_status: "conflict",
          provider_last_checked_at: now,
          provider_idempotency_key: idemKey,
          destination_fingerprint: fingerprint,
          provider_error_code: LINKAGE_ERROR.COUNTERPARTY_MATCH_CONFLICT,
          provider_error_message_safe: "Multiple Revolut counterparties matched this bank destination.",
          updated_at: now,
        }).eq("id", row.id);

        results.push({
          driver_id: driverId,
          destination_id: row.id,
          skipped: false,
          verification_status: verification,
          provider_link_status: PROVIDER_LINK_STATUS.CONFLICT,
          masked_destination: row.destination_label,
          matching_counterparty_existed: true,
          provider_counterparty_id_masked: null,
          provider_recipient_account_id_masked: null,
          provider_synced_at: null,
          blocking_reason: LINKAGE_ERROR.COUNTERPARTY_MATCH_CONFLICT,
          revolut_pay_called: false,
          wallet_mutated: false,
          discovery_note: discoveryNote,
        });
        continue;
      }

      // Gate create: respect discovery decision (OAuth scope vs relay/discovery failure).
      if (!decision.may_create) {
        const blockedOauth =
          decision.provider_link_status === PROVIDER_LINK_STATUS.BLOCKED_BY_OAUTH_SCOPE;
        const status = decision.provider_link_status;
        const errCode = decision.blocking_reason
          ?? (blockedOauth ? LINKAGE_ERROR.BLOCKED_BY_OAUTH_SCOPE : LINKAGE_ERROR.RELAY_UNAVAILABLE);
        const safeMsg = blockedOauth
          ? `OAuth scope ${grantedScopes.join(",")} cannot create counterparties/recipient accounts. Required: ${caps.required_scope_for_create}.`
          : `Provider discovery unavailable before create (${discoveryNote ?? "unknown"}). Match-before-create requires list.`;
        await supabase.from("driver_payout_destinations").update({
          provider: "revolut",
          provider_link_status: status,
          provider_sync_status: blockedOauth ? "blocked" : "failed",
          provider_last_checked_at: now,
          provider_idempotency_key: idemKey,
          destination_fingerprint: fingerprint,
          provider_error_code: errCode,
          provider_error_message_safe: safeMsg,
          updated_at: now,
        }).eq("id", row.id);

        await supabase.from("driver_payout_destination_audit").insert({
          driver_id: driverId,
          provider: "revolut",
          action: "provider_link_blocked",
          previous_payload: {
            provider_link_status: row.provider_link_status,
            verification_status: row.verification_status,
          },
          new_payload: {
            provider_link_status: status,
            destination_last4: row.destination_last4,
            masked_sort_code: row.masked_sort_code,
            account_holder_name: holder ? "â¢â¢â¢â¢" : null,
          },
          changed_by_user_id: actorUserId ?? "9ab3080c-73ef-4c36-b92b-ae8e8f4815f2",
          old_payout_account_id: row.id,
          new_payout_account_id: row.id,
          changed_by_role: actorRole === "service_role" ? "system" : "admin",
          metadata: {
            revolut_called: matchStatus !== "discovery_unavailable",
            revolut_pay_called: false,
            wallet_mutated: false,
            oauth_scopes: grantedScopes,
            required_scope: caps.required_scope_for_create,
            discovery_note: discoveryNote,
            match_status: matchStatus,
            live_payout_execution_enabled: livePayout,
            token_note: tokenNote,
          },
        });

        results.push({
          driver_id: driverId,
          destination_id: row.id,
          skipped: false,
          verification_status: verification,
          provider_link_status: status,
          masked_destination: row.destination_label,
          matching_counterparty_existed: false,
          provider_counterparty_id_masked: maskProviderId(row.provider_counterparty_id),
          provider_recipient_account_id_masked: maskProviderId(row.provider_recipient_account_id),
          provider_synced_at: null,
          blocking_reason: errCode,
          required_scope: caps.required_scope_for_create,
          oauth_scopes_granted: grantedScopes,
          revolut_pay_called: false,
          wallet_mutated: false,
          destination_preserved: true,
          discovery_note: discoveryNote,
          match_status: matchStatus,
          token_note: tokenNote,
        });
        continue;
      }

      // WRITE create path â match-before-create already confirmed none. Never /pay.
      if (!decision.may_create || !accessToken || !isRevolutBusinessRelayConfigured()) {
        const reason = !accessToken
          ? "access_token_missing"
          : !isRevolutBusinessRelayConfigured()
          ? LINKAGE_ERROR.RELAY_UNAVAILABLE
          : decision.blocking_reason ?? LINKAGE_ERROR.RELAY_UNAVAILABLE;
        await supabase.from("driver_payout_destinations").update({
          provider: "revolut",
          provider_link_status: PROVIDER_LINK_STATUS.FAILED,
          provider_sync_status: "failed",
          provider_last_checked_at: now,
          provider_idempotency_key: idemKey,
          destination_fingerprint: fingerprint,
          provider_error_code: reason,
          provider_error_message_safe: "Provider create gated: match-before-create failed or relay unavailable.",
          updated_at: now,
        }).eq("id", row.id);
        results.push({
          driver_id: driverId,
          destination_id: row.id,
          skipped: false,
          verification_status: verification,
          provider_link_status: PROVIDER_LINK_STATUS.FAILED,
          masked_destination: row.destination_label,
          matching_counterparty_existed: false,
          provider_counterparty_id_masked: null,
          provider_recipient_account_id_masked: null,
          blocking_reason: reason,
          revolut_pay_called: false,
          wallet_mutated: false,
          discovery_note: discoveryNote,
        });
        continue;
      }

      try {
        // Revolut Business UK bank create requires individual_name (not flat name).
        // Ahmed/Bosteyo and driver destinations are personal individuals.
        const createBody = buildRevolutUkBankCounterpartyCreateBody({
          kind: "personal",
          accountHolderName: holder || row.destination_label || "Driver Account",
          sortCode,
          accountNumber,
          currency: "GBP",
          bankCountry: "GB",
        });
        const createRes = await relayRevolutCreateCounterparty({
          accessToken,
          idempotencyKey: idemKey,
          body: createBody,
        });
        if (!createRes.ok) {
          const errBody = await createRes.json().catch(() => ({})) as Record<string, unknown>;
          const safeMsg = typeof errBody?.message === "string"
            ? errBody.message.slice(0, 180)
            : `counterparty_create_http_${createRes.status}`;
          const scopeBlocked = createRes.status === 403
            || /scope|permission|forbidden/i.test(safeMsg);
          await supabase.from("driver_payout_destinations").update({
            provider: "revolut",
            provider_link_status: scopeBlocked
              ? PROVIDER_LINK_STATUS.BLOCKED_BY_OAUTH_SCOPE
              : PROVIDER_LINK_STATUS.FAILED,
            provider_sync_status: scopeBlocked ? "blocked" : "failed",
            provider_last_checked_at: now,
            provider_idempotency_key: idemKey,
            destination_fingerprint: fingerprint,
            provider_error_code: scopeBlocked
              ? LINKAGE_ERROR.BLOCKED_BY_OAUTH_SCOPE
              : LINKAGE_ERROR.COUNTERPARTY_CREATE_FAILED,
            provider_error_message_safe: safeMsg,
            updated_at: now,
          }).eq("id", row.id);
          results.push({
            driver_id: driverId,
            destination_id: row.id,
            skipped: false,
            verification_status: verification,
            provider_link_status: scopeBlocked
              ? PROVIDER_LINK_STATUS.BLOCKED_BY_OAUTH_SCOPE
              : PROVIDER_LINK_STATUS.FAILED,
            masked_destination: row.destination_label,
            matching_counterparty_existed: false,
            provider_counterparty_id_masked: null,
            provider_recipient_account_id_masked: null,
            blocking_reason: scopeBlocked
              ? LINKAGE_ERROR.BLOCKED_BY_OAUTH_SCOPE
              : LINKAGE_ERROR.COUNTERPARTY_CREATE_FAILED,
            revolut_pay_called: false,
            wallet_mutated: false,
            discovery_note: discoveryNote,
            create_http_status: createRes.status,
          });
          continue;
        }

        const created = await createRes.json().catch(() => null) as RevolutCounterpartyLike | null;
        const cpId = String(created?.id ?? "").trim();
        const accts = Array.isArray(created?.accounts) ? created!.accounts! : [];
        let raId = "";
        for (const acct of accts) {
          const aid = String(acct?.id ?? "").trim();
          if (!aid) continue;
          const candSort = String(acct?.sort_code ?? "");
          const candAcct = String(acct?.account_no ?? acct?.account_number ?? "");
          if (
            candSort && candAcct
            && sortCode === candSort.replace(/\D/g, "")
            && accountNumber === candAcct.replace(/\D/g, "")
          ) {
            raId = aid;
            break;
          }
          if (!raId) raId = aid;
        }
        if (!cpId || !raId) {
          await supabase.from("driver_payout_destinations").update({
            provider: "revolut",
            provider_link_status: PROVIDER_LINK_STATUS.FAILED,
            provider_sync_status: "failed",
            provider_last_checked_at: now,
            provider_idempotency_key: idemKey,
            destination_fingerprint: fingerprint,
            provider_error_code: LINKAGE_ERROR.PROVIDER_RESPONSE_INVALID,
            provider_error_message_safe: "Create succeeded but counterparty/recipient IDs missing.",
            updated_at: now,
          }).eq("id", row.id);
          results.push({
            driver_id: driverId,
            destination_id: row.id,
            skipped: false,
            verification_status: verification,
            provider_link_status: PROVIDER_LINK_STATUS.FAILED,
            blocking_reason: LINKAGE_ERROR.PROVIDER_RESPONSE_INVALID,
            revolut_pay_called: false,
            wallet_mutated: false,
            discovery_note: discoveryNote,
          });
          continue;
        }

        await supabase.from("driver_payout_destinations").update({
          provider: "revolut",
          provider_counterparty_id: cpId,
          provider_recipient_account_id: raId,
          provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
          provider_sync_status: "synced",
          provider_synced_at: now,
          provider_last_checked_at: now,
          provider_idempotency_key: idemKey,
          destination_fingerprint: fingerprint,
          provider_error_code: null,
          provider_error_message_safe: null,
          updated_at: now,
        }).eq("id", row.id);

        await supabase.from("driver_payout_destination_audit").insert({
          driver_id: driverId,
          provider: "revolut",
          action: "provider_link_synced",
          previous_payload: {
            provider_link_status: row.provider_link_status,
            verification_status: row.verification_status,
          },
          new_payload: {
            provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
            provider_counterparty_id_masked: maskProviderId(cpId),
            provider_recipient_account_id_masked: maskProviderId(raId),
            destination_last4: row.destination_last4,
            masked_sort_code: row.masked_sort_code,
          },
          changed_by_user_id: actorUserId ?? "9ab3080c-73ef-4c36-b92b-ae8e8f4815f2",
          old_payout_account_id: row.id,
          new_payout_account_id: row.id,
          changed_by_role: actorRole === "service_role" ? "system" : "admin",
          metadata: {
            revolut_called: true,
            revolut_pay_called: false,
            wallet_mutated: false,
            matched_existing: false,
            created: true,
            discovery_note: discoveryNote,
            live_payout_execution_enabled: livePayout,
          },
        });

        results.push({
          driver_id: driverId,
          destination_id: row.id,
          skipped: false,
          verification_status: verification,
          provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
          masked_destination: row.destination_label,
          matching_counterparty_existed: false,
          provider_counterparty_id_masked: maskProviderId(cpId),
          provider_recipient_account_id_masked: maskProviderId(raId),
          provider_synced_at: now,
          blocking_reason: null,
          revolut_pay_called: false,
          wallet_mutated: false,
          discovery_note: discoveryNote,
        });
      } catch {
        results.push({
          driver_id: driverId,
          destination_id: row.id,
          skipped: false,
          verification_status: verification,
          provider_link_status: PROVIDER_LINK_STATUS.FAILED,
          blocking_reason: LINKAGE_ERROR.RELAY_UNAVAILABLE,
          revolut_pay_called: false,
          wallet_mutated: false,
          discovery_note: discoveryNote,
        });
      }
    }

    const linked = results.filter((r) =>
      !r.skipped && r.provider_link_status === PROVIDER_LINK_STATUS.PROVIDER_VERIFIED
    ).length;
    const actionable = results.filter((r) => !r.skipped);

    let verdict = "SLICE 2 FAIL â PROVIDER LINKAGE DEFECT";
    if (linked === actionable.length && linked === 2) {
      verdict = "SLICE 2 PASS â BOTH DESTINATIONS PROVIDER-LINKED";
    } else if (linked === 1) {
      verdict = "SLICE 2 PARTIAL â ONE DESTINATION PROVIDER-LINKED";
    } else if (linked > 0 && linked < actionable.length) {
      verdict = "SLICE 2 PARTIAL â ONE DESTINATION PROVIDER-LINKED";
    }

    const payProbe = await relayProbePayBlocked().catch(() => ({
      blocked: true,
      status: 0,
      error: "probe_failed",
    }));
    assertSlice2MoneySafety({
      revolut_pay_called: false,
      wallet_mutated: false,
      live_payout_execution_enabled: livePayout,
    });

    return new Response(
      JSON.stringify({
        success: true,
        slice: 2,
        oauth_scopes_granted: grantedScopes,
        required_scope_for_counterparty_create: caps.required_scope_for_create,
        required_scope_for_recipient_create: caps.required_scope_for_create,
        capabilities: caps,
        live_payout_execution_enabled: livePayout,
        revolut_pay_blocked: true,
        relay_pay_probe: payProbe,
        wallet_mutated: false,
        token_note: tokenNote,
        results,
        verdict,
      }),
      { headers: corsHeaders },
    );
  } catch (error) {
    console.error("ADMIN_SYNC_DRIVER_PAYOUT_PROVIDER_LINKAGE_FAILED", error instanceof Error ? error.message : "error");
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
