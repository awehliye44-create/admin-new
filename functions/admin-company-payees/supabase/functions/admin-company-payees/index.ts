/**
 * Admin company payees + automatic schedules.
 * Encrypts bank details at rest. Never returns plaintext account numbers.
 * Revolut counterparty create is opt-in (execute_live) — default dry/validation only.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse, requireAdminOrStaff } from "../_shared/adminPaymentGate.ts";
import {
  COMPANY_PAYEE_TYPES,
  companyPayeeAccountFingerprint,
  evaluateActiveCompanyPayeeDuplicateGate,
  maskUkAccount,
  normaliseIban,
  normaliseUkBankDigits,
  toCompanyPayeePublicDto,
} from "../_shared/companyPayeeSSOT.ts";
import { encryptCompanyPayeeSecret, decryptCompanyPayeeSecret } from "../_shared/companyPayeeEncryptionSSOT.ts";
import {
  buildAutomaticPeriodPayableDraft,
  computeCompanyPayeeNextRun,
  evaluateAutomaticCompanyPaymentGates,
} from "../_shared/companyPayeeScheduleSSOT.ts";
import { createRevolutCounterparty } from "../_shared/revolutApi.ts";
import { resolveLiveCompanyBalanceWithSlice10Gate } from "../_shared/companyBalanceResolveSSOT.ts";
import {
  isRevolutBusinessRelayConfigured,
  relayRevolutCounterparties,
  relayRevolutCreateCounterparty,
} from "../_shared/revolutBusinessRelayClient.ts";
import { ensureFreshRevolutBusinessAccessToken } from "../_shared/revolutBusinessAccessTokenRefresh.ts";
import {
  COMPANY_PAYEE_LINK_DB,
  COMPANY_PAYEE_LINK_ERROR,
  buildCompanyPayeeUkBankCounterpartyBody,
  classifyProviderCreateFailure,
  companyPayeeCounterpartyKind,
  companyPayeeLinkErrorLabel,
  companyPayeeLinkIdempotencyKey,
  matchUkBankAgainstCounterparties,
  normalizeAccountHolderName,
  pickRecipientAccountIdFromCreate,
  type RevolutCounterpartyLike,
} from "../_shared/companyPayeeRevolutLinkSSOT.ts";

const ListPayees = z.object({
  action: z.literal("list_payees"),
  service_area_id: z.string().uuid().nullable().optional(),
  include_inactive: z.boolean().optional(),
  include_archived: z.boolean().optional(),
  payee_type: z.string().nullable().optional(),
  search: z.string().max(200).nullable().optional(),
});

const CreatePayee = z.object({
  action: z.literal("create_payee"),
  legal_name: z.string().min(1).max(200),
  display_name: z.string().min(1).max(200),
  payee_type: z.enum(COMPANY_PAYEE_TYPES as unknown as [string, ...string[]]),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  currency: z.string().default("GBP"),
  country: z.string().default("GB"),
  payment_purpose: z.string().max(500).nullable().optional(),
  default_reference: z.string().max(140).nullable().optional(),
  account_holder_name: z.string().min(1).max(200),
  bank_name: z.string().max(200).nullable().optional(),
  sort_code: z.string().max(20).nullable().optional(),
  account_number: z.string().max(20).nullable().optional(),
  iban: z.string().max(40).nullable().optional(),
  service_area_id: z.string().uuid().nullable().optional(),
  /** When true AND Business token present, create Revolut counterparty. Default false (no live call). */
  execute_live: z.boolean().optional().default(false),
  /**
   * Required to create a second *active* payee with the same SA + currency + bank fingerprint.
   * Without this, create returns DUPLICATE_ACTIVE_PAYEE (configuration guard — not money movement).
   */
  confirm_distinct_payee: z.boolean().optional().default(false),
});

const UpdatePayee = z.object({
  action: z.literal("update_payee"),
  payee_id: z.string().uuid(),
  legal_name: z.string().min(1).max(200).optional(),
  display_name: z.string().min(1).max(200).optional(),
  payee_type: z.enum(COMPANY_PAYEE_TYPES as unknown as [string, ...string[]]).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  country: z.string().max(8).optional(),
  payment_purpose: z.string().max(500).nullable().optional(),
  default_reference: z.string().max(140).nullable().optional(),
  account_holder_name: z.string().min(1).max(200).optional(),
  bank_name: z.string().max(200).nullable().optional(),
  active: z.boolean().optional(),
  paused: z.boolean().optional(),
});

const UpsertSchedule = z.object({
  action: z.literal("upsert_schedule"),
  payee_id: z.string().uuid(),
  automatic_enabled: z.boolean(),
  frequency: z.enum(["WEEKLY", "FORTNIGHTLY", "MONTHLY", "CUSTOM"]),
  weekly_day: z.string().nullable().optional(),
  monthly_day: z.number().int().min(1).max(28).nullable().optional(),
  local_processing_time: z.string().default("12:00"),
  timezone: z.string().default("Europe/London"),
  fixed_amount_pence: z.number().int().positive().nullable().optional(),
  use_approved_payable_amount: z.boolean().optional().default(false),
  maximum_amount_pence: z.number().int().positive().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  approval_required: z.boolean().optional().default(true),
  insufficient_funds_action: z.enum(["SKIP", "RETRY_NEXT", "ALERT_ONLY"]).optional().default("SKIP"),
  category: z.string().min(1).max(80),
  execution_mode: z.enum(["DRAFT_FOR_APPROVAL", "DIRECT_TRANSFER"]).optional().default("DRAFT_FOR_APPROVAL"),
  paused: z.boolean().optional().default(false),
  schedule_id: z.string().uuid().nullable().optional(),
});

const ListSchedules = z.object({
  action: z.literal("list_schedules"),
  payee_id: z.string().uuid().nullable().optional(),
});

const PausePayee = z.object({
  action: z.literal("pause_payee"),
  payee_id: z.string().uuid(),
  paused: z.boolean(),
});

const ArchivePayee = z.object({
  action: z.literal("archive_payee"),
  payee_id: z.string().uuid(),
  archived: z.boolean(),
});

/** Link existing payee to Revolut Business counterparty (decrypt → create → VERIFIED). */
const LinkRevolutPayee = z.object({
  action: z.literal("link_revolut_payee"),
  payee_id: z.string().uuid(),
});

/** Creates DRAFT company transfers for due schedules. Never executes Revolut /pay. */
const RunDueSchedules = z.object({
  action: z.literal("run_due_schedules"),
  /** Optional: only evaluate, do not insert drafts. */
  dry_run: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(100).optional().default(50),
});

const InputSchema = z.discriminatedUnion("action", [
  ListPayees,
  CreatePayee,
  UpdatePayee,
  UpsertSchedule,
  ListSchedules,
  PausePayee,
  ArchivePayee,
  LinkRevolutPayee,
  RunDueSchedules,
]);

async function readBusinessToken(supabase: { from: (t: string) => any }): Promise<{
  merchant_id: string | null;
  business_access_token: string | null;
}> {
  const { data } = await supabase
    .from("payment_provider_vault")
    .select("secret_name, secret_value")
    .eq("provider", "revolut")
    .eq("environment", "live");
  const map = new Map<string, string>();
  for (const row of data ?? []) map.set(String(row.secret_name), String(row.secret_value ?? ""));
  return {
    merchant_id: (map.get("merchant_id") ?? Deno.env.get("REVOLUT_SOURCE_BUSINESS_ACCOUNT_ID") ?? "").trim() || null,
    business_access_token: (
      map.get("business_access_token")
      ?? Deno.env.get("REVOLUT_BUSINESS_ACCESS_TOKEN")
      ?? ""
    ).trim() || null,
  };
}

/** Revolut helpers throw plain `{ message, status, body }` — never String(err). */
function safeErrorMessage(err: unknown, fallback = "Unexpected error"): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
    if (typeof o.error === "string" && o.error.trim()) return o.error.trim();
    try {
      return JSON.stringify(o).slice(0, 500);
    } catch {
      /* ignore */
    }
  }
  return fallback;
}

function revolutAccounts(cp: unknown): Array<{ id?: string }> {
  if (!cp || typeof cp !== "object") return [];
  const accounts = (cp as { accounts?: unknown }).accounts;
  return Array.isArray(accounts) ? accounts as Array<{ id?: string }> : [];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const gate = await requireAdminOrStaff(req);
    if (!gate.ok) return gate.response;
    const body = await req.json().catch(() => ({}));
    const parsed = InputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ success: false, error: "Invalid input", details: parsed.error.flatten() }, 400);
    }
    const input = parsed.data;
    const supabase = gate.supabase;
    const actorId = gate.userId === "service-role" ? null : gate.userId;

    // Payee CRUD + schedules are configuration (not money movement).
    // Never gate create/update/list/archive behind LIVE_COMPANY_TRANSFER or LIVE_PAYOUT.
    // Revolut /pay for transfers stays on submit/finalize edges only.

    if (input.action === "list_payees") {
      let q = supabase.from("company_payees").select("*").order("display_name", { ascending: true }).limit(500);
      if (!input.include_inactive) q = q.eq("active", true);
      if (!input.include_archived) q = q.is("archived_at", null);
      if (input.service_area_id) q = q.eq("service_area_id", input.service_area_id);
      if (input.payee_type) q = q.eq("payee_type", String(input.payee_type).toUpperCase());
      const { data, error } = await q;
      if (error) return jsonResponse({ success: false, error: error.message }, 400);
      let payees = (data ?? []).map((r: Record<string, unknown>) => toCompanyPayeePublicDto(r));
      const search = String(input.search ?? "").trim().toLowerCase();
      if (search) {
        payees = payees.filter((p) =>
          p.display_name.toLowerCase().includes(search)
          || p.legal_name.toLowerCase().includes(search)
          || String(p.email ?? "").toLowerCase().includes(search)
          || String(p.default_reference ?? "").toLowerCase().includes(search)
          || p.masked_account.toLowerCase().includes(search)
        );
      }
      return jsonResponse({
        success: true,
        payees,
        company_transfers_money_read_only: true,
        note: "Payee management enabled; Revolut /pay still gated by LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED",
      });
    }

    if (input.action === "list_schedules") {
      let q = supabase.from("company_payee_schedules").select("*").order("updated_at", { ascending: false }).limit(500);
      if (input.payee_id) q = q.eq("payee_id", input.payee_id);
      const { data, error } = await q;
      if (error) return jsonResponse({ success: false, error: error.message }, 400);
      return jsonResponse({ success: true, schedules: data ?? [] });
    }

    if (input.action === "pause_payee") {
      const { data, error } = await supabase
        .from("company_payees")
        .update({ paused: input.paused, updated_at: new Date().toISOString() })
        .eq("id", input.payee_id)
        .select("*")
        .single();
      if (error || !data) return jsonResponse({ success: false, error: error?.message ?? "Not found" }, 404);
      return jsonResponse({ success: true, payee: toCompanyPayeePublicDto(data) });
    }

    if (input.action === "archive_payee") {
      const patch = input.archived
        ? {
          archived_at: new Date().toISOString(),
          active: false,
          paused: true,
          updated_at: new Date().toISOString(),
        }
        : {
          archived_at: null,
          active: true,
          paused: false,
          updated_at: new Date().toISOString(),
        };
      const { data, error } = await supabase
        .from("company_payees")
        .update(patch)
        .eq("id", input.payee_id)
        .select("*")
        .single();
      if (error || !data) return jsonResponse({ success: false, error: error?.message ?? "Not found" }, 404);
      return jsonResponse({ success: true, payee: toCompanyPayeePublicDto(data) });
    }

    if (input.action === "link_revolut_payee") {
      const { data: payee, error: payeeErr } = await supabase
        .from("company_payees")
        .select("*")
        .eq("id", input.payee_id)
        .is("archived_at", null)
        .maybeSingle();
      if (payeeErr || !payee) {
        return jsonResponse({ success: false, error: payeeErr?.message ?? "Payee not found" }, 404);
      }
      if (payee.revolut_counterparty_id && payee.account_verification_status === "VERIFIED") {
        return jsonResponse({
          success: true,
          payee: toCompanyPayeePublicDto(payee),
          already_linked: true,
          provider_link_status: "PROVIDER_VERIFIED",
          money_moved: false,
        });
      }

      if (!isRevolutBusinessRelayConfigured()) {
        return jsonResponse({
          success: false,
          error: COMPANY_PAYEE_LINK_ERROR.RELAY_UNAVAILABLE,
          error_code: COMPANY_PAYEE_LINK_ERROR.RELAY_UNAVAILABLE,
          message: companyPayeeLinkErrorLabel(COMPANY_PAYEE_LINK_ERROR.RELAY_UNAVAILABLE),
        }, 503);
      }

      const baseMeta =
        typeof payee.metadata === "object" && payee.metadata
          ? { ...(payee.metadata as Record<string, unknown>) }
          : {};

      // Mark LINKING (PENDING) before provider calls — never leave row stuck silently.
      await supabase.from("company_payees").update({
        account_verification_status: COMPANY_PAYEE_LINK_DB.PENDING,
        updated_at: new Date().toISOString(),
        metadata: {
          ...baseMeta,
          provider_link_status: "LINKING",
          provider_link_error_code: null,
          provider_link_error_message_safe: null,
        },
      }).eq("id", input.payee_id);

      let accessToken = "";
      try {
        const tok = await ensureFreshRevolutBusinessAccessToken(supabase);
        accessToken = tok.accessToken;
      } catch (err) {
        const msg = safeErrorMessage(err, "Revolut connection expired.");
        await supabase.from("company_payees").update({
          account_verification_status: COMPANY_PAYEE_LINK_DB.FAILED,
          updated_at: new Date().toISOString(),
          metadata: {
            ...baseMeta,
            provider_link_status: "LINK_FAILED",
            provider_link_error_code: COMPANY_PAYEE_LINK_ERROR.AUTHENTICATION_REQUIRED,
            provider_link_error_message_safe: companyPayeeLinkErrorLabel(
              COMPANY_PAYEE_LINK_ERROR.AUTHENTICATION_REQUIRED,
              msg,
            ),
          },
        }).eq("id", input.payee_id);
        return jsonResponse({
          success: false,
          error: COMPANY_PAYEE_LINK_ERROR.AUTHENTICATION_REQUIRED,
          error_code: COMPANY_PAYEE_LINK_ERROR.AUTHENTICATION_REQUIRED,
          message: companyPayeeLinkErrorLabel(COMPANY_PAYEE_LINK_ERROR.AUTHENTICATION_REQUIRED, msg),
        }, 409);
      }

      let sortCode = "";
      let accountNumber = "";
      let iban: string | null = null;
      try {
        if (payee.iban_encrypted) {
          iban = await decryptCompanyPayeeSecret(String(payee.iban_encrypted));
          iban = normaliseIban(iban);
        } else if (payee.sort_code_encrypted && payee.account_number_encrypted) {
          const sort = await decryptCompanyPayeeSecret(String(payee.sort_code_encrypted));
          const acct = await decryptCompanyPayeeSecret(String(payee.account_number_encrypted));
          const uk = normaliseUkBankDigits(sort, acct);
          sortCode = uk.sort_code;
          accountNumber = uk.account_number;
        } else {
          await supabase.from("company_payees").update({
            account_verification_status: COMPANY_PAYEE_LINK_DB.FAILED,
            updated_at: new Date().toISOString(),
            metadata: {
              ...baseMeta,
              provider_link_status: "LINK_FAILED",
              provider_link_error_code: COMPANY_PAYEE_LINK_ERROR.BANK_DETAILS_INCOMPLETE,
              provider_link_error_message_safe: companyPayeeLinkErrorLabel(
                COMPANY_PAYEE_LINK_ERROR.BANK_DETAILS_INCOMPLETE,
              ),
            },
          }).eq("id", input.payee_id);
          return jsonResponse({
            success: false,
            error: COMPANY_PAYEE_LINK_ERROR.BANK_DETAILS_INCOMPLETE,
            error_code: COMPANY_PAYEE_LINK_ERROR.BANK_DETAILS_INCOMPLETE,
            message: companyPayeeLinkErrorLabel(COMPANY_PAYEE_LINK_ERROR.BANK_DETAILS_INCOMPLETE),
          }, 409);
        }
      } catch {
        await supabase.from("company_payees").update({
          account_verification_status: COMPANY_PAYEE_LINK_DB.FAILED,
          updated_at: new Date().toISOString(),
          metadata: {
            ...baseMeta,
            provider_link_status: "LINK_FAILED",
            provider_link_error_code: COMPANY_PAYEE_LINK_ERROR.DECRYPT_FAILED,
            provider_link_error_message_safe: companyPayeeLinkErrorLabel(
              COMPANY_PAYEE_LINK_ERROR.DECRYPT_FAILED,
            ),
          },
        }).eq("id", input.payee_id);
        return jsonResponse({
          success: false,
          error: COMPANY_PAYEE_LINK_ERROR.DECRYPT_FAILED,
          error_code: COMPANY_PAYEE_LINK_ERROR.DECRYPT_FAILED,
          message: companyPayeeLinkErrorLabel(COMPANY_PAYEE_LINK_ERROR.DECRYPT_FAILED),
        }, 400);
      }

      const failLink = async (errorCode: string, safeMsg: string, http = 400) => {
        await supabase.from("company_payees").update({
          account_verification_status: COMPANY_PAYEE_LINK_DB.FAILED,
          updated_at: new Date().toISOString(),
          metadata: {
            ...baseMeta,
            provider_link_status: "LINK_FAILED",
            provider_link_error_code: errorCode,
            provider_link_error_message_safe: safeMsg,
          },
        }).eq("id", input.payee_id);
        return jsonResponse({
          success: false,
          error: errorCode,
          error_code: errorCode,
          message: safeMsg,
          money_moved: false,
        }, http);
      };

      let revolut_counterparty_id: string | null = null;
      let revolut_recipient_account_id: string | null = null;
      let reused_existing = false;
      const holder = normalizeAccountHolderName(
        String(payee.account_holder_name ?? payee.legal_name ?? ""),
      );
      const currency = String(payee.currency ?? "GBP").toUpperCase();
      const kind = companyPayeeCounterpartyKind(String(payee.payee_type ?? ""));

      // UK bank: match-before-create via fixed-egress relay (never direct b2b.revolut.com).
      if (!iban && sortCode && accountNumber) {
        try {
          const listRes = await relayRevolutCounterparties(accessToken);
          if (listRes.ok) {
            const body = await listRes.json().catch(() => null);
            const list = Array.isArray(body)
              ? body as RevolutCounterpartyLike[]
              : Array.isArray((body as { counterparties?: unknown })?.counterparties)
              ? (body as { counterparties: RevolutCounterpartyLike[] }).counterparties
              : null;
            if (list) {
              const matched = matchUkBankAgainstCounterparties({
                sortCode,
                accountNumber,
                counterparties: list,
              });
              if (matched.status === "conflict") {
                return await failLink(
                  COMPANY_PAYEE_LINK_ERROR.COUNTERPARTY_MATCH_CONFLICT,
                  companyPayeeLinkErrorLabel(COMPANY_PAYEE_LINK_ERROR.COUNTERPARTY_MATCH_CONFLICT),
                  409,
                );
              }
              if (matched.status === "unique" && matched.hit) {
                revolut_counterparty_id = matched.hit.counterparty_id;
                revolut_recipient_account_id = matched.hit.recipient_account_id;
                reused_existing = true;
              }
            }
          }
        } catch {
          // Discovery failure is non-fatal when create is still possible; create path below.
        }

        if (!revolut_counterparty_id) {
          const createBody = buildCompanyPayeeUkBankCounterpartyBody({
            kind,
            accountHolderName: holder,
            sortCode,
            accountNumber,
            currency,
            bankCountry: "GB",
          });
          const idemKey = companyPayeeLinkIdempotencyKey(input.payee_id);
          let createRes: Response;
          try {
            createRes = await relayRevolutCreateCounterparty({
              accessToken,
              idempotencyKey: idemKey,
              body: createBody,
            });
          } catch {
            return await failLink(
              COMPANY_PAYEE_LINK_ERROR.RELAY_UNAVAILABLE,
              companyPayeeLinkErrorLabel(COMPANY_PAYEE_LINK_ERROR.RELAY_UNAVAILABLE),
              503,
            );
          }
          if (!createRes.ok) {
            const errBody = await createRes.json().catch(() => ({})) as Record<string, unknown>;
            const safeMsg = typeof errBody?.message === "string"
              ? errBody.message.slice(0, 180)
              : typeof errBody?.error === "string"
              ? String(errBody.error).slice(0, 180)
              : `counterparty_create_http_${createRes.status}`;
            // Never log/return plaintext bank details — message is provider-safe only.
            const classified = classifyProviderCreateFailure({
              httpStatus: createRes.status,
              safeMessage: safeMsg,
            });
            return await failLink(classified.error_code, classified.user_message, 400);
          }
          const created = await createRes.json().catch(() => null) as RevolutCounterpartyLike | null;
          revolut_counterparty_id = String(created?.id ?? "").trim() || null;
          revolut_recipient_account_id = pickRecipientAccountIdFromCreate(
            created,
            sortCode,
            accountNumber,
          );
        }
      } else if (iban) {
        // IBAN path: still via relay create (no UK sort/account match).
        const createBody: Record<string, unknown> = {
          bank_country: iban.slice(0, 2),
          currency,
          iban,
          company_name: holder || "Company",
        };
        const idemKey = companyPayeeLinkIdempotencyKey(input.payee_id);
        let createRes: Response;
        try {
          createRes = await relayRevolutCreateCounterparty({
            accessToken,
            idempotencyKey: idemKey,
            body: createBody,
          });
        } catch {
          return await failLink(
            COMPANY_PAYEE_LINK_ERROR.RELAY_UNAVAILABLE,
            companyPayeeLinkErrorLabel(COMPANY_PAYEE_LINK_ERROR.RELAY_UNAVAILABLE),
            503,
          );
        }
        if (!createRes.ok) {
          const errBody = await createRes.json().catch(() => ({})) as Record<string, unknown>;
          const safeMsg = typeof errBody?.message === "string"
            ? errBody.message.slice(0, 180)
            : `counterparty_create_http_${createRes.status}`;
          const classified = classifyProviderCreateFailure({
            httpStatus: createRes.status,
            safeMessage: safeMsg,
          });
          return await failLink(classified.error_code, classified.user_message, 400);
        }
        const created = await createRes.json().catch(() => null) as RevolutCounterpartyLike | null;
        revolut_counterparty_id = String(created?.id ?? "").trim() || null;
        const accounts = Array.isArray(created?.accounts) ? created!.accounts! : [];
        revolut_recipient_account_id = accounts[0]?.id
          ? String(accounts[0].id)
          : null;
      }

      if (!revolut_counterparty_id) {
        return await failLink(
          COMPANY_PAYEE_LINK_ERROR.PROVIDER_RESPONSE_INVALID,
          companyPayeeLinkErrorLabel(COMPANY_PAYEE_LINK_ERROR.PROVIDER_RESPONSE_INVALID),
        );
      }

      const now = new Date().toISOString();
      const { data: updated, error: updErr } = await supabase
        .from("company_payees")
        .update({
          revolut_counterparty_id,
          revolut_recipient_account_id,
          account_verification_status: COMPANY_PAYEE_LINK_DB.VERIFIED,
          verified_at: now,
          updated_at: now,
          metadata: {
            ...baseMeta,
            provider_link_status: "PROVIDER_VERIFIED",
            provider_verified_at: now,
            provider_link_error_code: null,
            provider_link_error_message_safe: null,
            provider_evidence: {
              linked_via: "revolut_business_relay",
              reused_existing_counterparty: reused_existing,
              linked_at: now,
              // Never store sort/account/iban plaintext in evidence.
              masked_account: payee.masked_account ?? null,
              counterparty_id_suffix: String(revolut_counterparty_id).slice(-6),
            },
            revolut_linked_at: now,
          },
        })
        .eq("id", input.payee_id)
        .select("*")
        .single();
      if (updErr || !updated) {
        return jsonResponse({ success: false, error: updErr?.message ?? "Link update failed" }, 400);
      }
      return jsonResponse({
        success: true,
        payee: toCompanyPayeePublicDto(updated),
        live_counterparty_created: !reused_existing,
        reused_existing_counterparty: reused_existing,
        provider_link_status: "PROVIDER_VERIFIED",
        money_moved: false,
      });
    }

    if (input.action === "update_payee") {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (input.legal_name != null) patch.legal_name = input.legal_name;
      if (input.display_name != null) patch.display_name = input.display_name;
      if (input.payee_type != null) patch.payee_type = input.payee_type;
      if (input.email !== undefined) patch.email = input.email;
      if (input.phone !== undefined) patch.phone = input.phone;
      if (input.country != null) patch.country = String(input.country).toUpperCase();
      if (input.payment_purpose !== undefined) patch.payment_purpose = input.payment_purpose;
      if (input.default_reference !== undefined) patch.default_reference = input.default_reference;
      if (input.account_holder_name != null) patch.account_holder_name = input.account_holder_name;
      if (input.bank_name !== undefined) patch.bank_name = input.bank_name;
      if (input.active != null) patch.active = input.active;
      if (input.paused != null) patch.paused = input.paused;
      const { data, error } = await supabase
        .from("company_payees")
        .update(patch)
        .eq("id", input.payee_id)
        .is("archived_at", null)
        .select("*")
        .single();
      if (error || !data) {
        return jsonResponse({
          success: false,
          error: error?.message ?? "Payee not found or archived",
        }, 404);
      }
      return jsonResponse({ success: true, payee: toCompanyPayeePublicDto(data) });
    }

    if (input.action === "create_payee") {
      const currency = String(input.currency ?? "GBP").toUpperCase();
      let sortEnc: string | null = null;
      let acctEnc: string | null = null;
      let ibanEnc: string | null = null;
      let fingerprint: string;
      let masked: string;
      let destinationType = "uk_bank_account";
      let destinationIdentifier = "";

      if (input.iban) {
        const iban = normaliseIban(input.iban);
        ibanEnc = await encryptCompanyPayeeSecret(iban);
        fingerprint = await companyPayeeAccountFingerprint({ currency, iban });
        masked = maskUkAccount({ iban });
        destinationType = "iban";
        destinationIdentifier = iban;
      } else {
        const uk = normaliseUkBankDigits(String(input.sort_code ?? ""), String(input.account_number ?? ""));
        sortEnc = await encryptCompanyPayeeSecret(uk.sort_code);
        acctEnc = await encryptCompanyPayeeSecret(uk.account_number);
        fingerprint = await companyPayeeAccountFingerprint({
          currency,
          sort_code: uk.sort_code,
          account_number: uk.account_number,
        });
        masked = maskUkAccount({ account_number: uk.account_number });
        destinationIdentifier = `${uk.sort_code}${uk.account_number}`;
      }

      const { data: dupRows, error: dupErr } = await supabase
        .from("company_payees")
        .select("*")
        .eq("account_fingerprint", fingerprint)
        .eq("currency", currency)
        .is("archived_at", null)
        .eq("active", true)
        .limit(20);
      if (dupErr) {
        return jsonResponse({ success: false, error: dupErr.message }, 400);
      }
      const sa = input.service_area_id ?? null;
      const activeDups = (dupRows ?? []).filter((row: Record<string, unknown>) => {
        const rowSa = row.service_area_id == null ? null : String(row.service_area_id);
        return rowSa === sa;
      });
      const dupGate = evaluateActiveCompanyPayeeDuplicateGate({
        active_match_count: activeDups.length,
        confirm_distinct_payee: input.confirm_distinct_payee === true,
      });
      if (!dupGate.allowed) {
        return jsonResponse({
          success: false,
          error: dupGate.code,
          error_code: dupGate.code,
          message:
            "An active payee already exists for this service area, currency and bank account. " +
            "Confirm it is a distinct payee to create another, or reuse the existing one.",
          payee: toCompanyPayeePublicDto(activeDups[0]),
          duplicate: true,
          requires_confirm_distinct_payee: true,
        }, 409);
      }

      // Archived / inactive same fingerprint — allow recreate without confirm.

      let revolut_counterparty_id: string | null = null;
      let revolut_recipient_account_id: string | null = null;
      let account_verification_status = "UNVERIFIED";

      if (input.execute_live === true) {
        const vault = await readBusinessToken(supabase);
        if (!vault.business_access_token) {
          return jsonResponse({
            success: false,
            error: "AUTHENTICATION_REQUIRED",
            error_code: "AUTHENTICATION_REQUIRED",
            message: "Revolut Business token required for live counterparty creation",
          }, 409);
        }
        try {
          const cp = await createRevolutCounterparty({
            environment: "live",
            accessToken: vault.business_access_token,
            destinationType,
            destinationIdentifier,
            accountHolderName: input.account_holder_name,
            currencyCode: currency,
          });
          revolut_counterparty_id = String(cp.id ?? "");
          const accounts = revolutAccounts(cp);
          revolut_recipient_account_id = accounts[0]?.id ? String(accounts[0].id) : null;
          account_verification_status = revolut_counterparty_id ? "VERIFIED" : "PENDING";
        } catch (err) {
          return jsonResponse({
            success: false,
            error: safeErrorMessage(err, "Counterparty create failed"),
            error_code: "COUNTERPARTY_CREATE_FAILED",
            message: safeErrorMessage(err, "Counterparty create failed"),
          }, 400);
        }
      }

      const { data: created, error } = await supabase
        .from("company_payees")
        .insert({
          legal_name: input.legal_name,
          display_name: input.display_name,
          payee_type: input.payee_type,
          email: input.email ?? null,
          phone: input.phone ?? null,
          currency,
          country: String(input.country ?? "GB").toUpperCase(),
          payment_purpose: input.payment_purpose ?? null,
          default_reference: input.default_reference ?? null,
          revolut_counterparty_id,
          revolut_recipient_account_id,
          account_holder_name: input.account_holder_name,
          bank_name: input.bank_name ?? null,
          sort_code_encrypted: sortEnc,
          account_number_encrypted: acctEnc,
          iban_encrypted: ibanEnc,
          masked_account: masked,
          account_fingerprint: fingerprint,
          account_verification_status,
          active: true,
          paused: false,
          verified_at: account_verification_status === "VERIFIED" ? new Date().toISOString() : null,
          created_by: actorId,
          service_area_id: input.service_area_id ?? null,
          metadata: { execute_live_requested: input.execute_live === true },
        })
        .select("*")
        .single();
      if (error || !created) {
        return jsonResponse({ success: false, error: error?.message ?? "Create failed" }, 400);
      }
      return jsonResponse({
        success: true,
        payee: toCompanyPayeePublicDto(created),
        live_counterparty_created: Boolean(revolut_counterparty_id),
      });
    }

    if (input.action === "upsert_schedule") {
      const next = computeCompanyPayeeNextRun({
        frequency: input.frequency,
        weekly_day: input.weekly_day,
        monthly_day: input.monthly_day,
        local_processing_time: input.local_processing_time,
        timezone: input.timezone,
        automatic_enabled: input.automatic_enabled,
        paused: input.paused,
        start_date: input.start_date,
        end_date: input.end_date,
      });
      const row = {
        payee_id: input.payee_id,
        automatic_enabled: input.automatic_enabled,
        frequency: input.frequency,
        weekly_day: input.weekly_day ?? null,
        monthly_day: input.monthly_day ?? null,
        local_processing_time: input.local_processing_time,
        timezone: input.timezone,
        fixed_amount_pence: input.fixed_amount_pence ?? null,
        use_approved_payable_amount: input.use_approved_payable_amount ?? false,
        maximum_amount_pence: input.maximum_amount_pence ?? null,
        start_date: input.start_date ?? null,
        end_date: input.end_date ?? null,
        approval_required: input.approval_required ?? true,
        insufficient_funds_action: input.insufficient_funds_action ?? "SKIP",
        category: input.category,
        execution_mode: input.execution_mode ?? "DRAFT_FOR_APPROVAL",
        next_run_at: next.next_run_at,
        next_run_at_local: next.next_run_at_local,
        paused: input.paused ?? false,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      };

      if (input.schedule_id) {
        const { data, error } = await supabase
          .from("company_payee_schedules")
          .update(row)
          .eq("id", input.schedule_id)
          .select("*")
          .single();
        if (error || !data) return jsonResponse({ success: false, error: error?.message ?? "Update failed" }, 400);
        return jsonResponse({ success: true, schedule: data, schedule_period_key: next.schedule_period_key });
      }

      const { data, error } = await supabase
        .from("company_payee_schedules")
        .insert({ ...row, created_by: actorId })
        .select("*")
        .single();
      if (error || !data) return jsonResponse({ success: false, error: error?.message ?? "Create failed" }, 400);
      return jsonResponse({ success: true, schedule: data, schedule_period_key: next.schedule_period_key });
    }

    if (input.action === "run_due_schedules") {
      const nowIso = new Date().toISOString();
      const { data: due, error: dueErr } = await supabase
        .from("company_payee_schedules")
        .select("*")
        .eq("automatic_enabled", true)
        .eq("paused", false)
        .lte("next_run_at", nowIso)
        .order("next_run_at", { ascending: true })
        .limit(input.limit ?? 50);
      if (dueErr) return jsonResponse({ success: false, error: dueErr.message }, 400);

      const companyBalance = await resolveLiveCompanyBalanceWithSlice10Gate({
        supabase,
        currency: "GBP",
      });
      const results: Array<Record<string, unknown>> = [];

      for (const sched of due ?? []) {
        const { data: payee } = await supabase
          .from("company_payees")
          .select("*")
          .eq("id", sched.payee_id)
          .maybeSingle();
        if (!payee) {
          results.push({ schedule_id: sched.id, status: "PAYEE_NOT_FOUND" });
          continue;
        }
        const periodKey = String(sched.last_period_key ?? "")
          || (sched.next_run_at
            ? `D:${String(sched.next_run_at).slice(0, 10)}`
            : `D:${nowIso.slice(0, 10)}`);
        const { data: prior } = await supabase
          .from("company_outgoing_transfers")
          .select("id")
          .eq("schedule_id", sched.id)
          .eq("schedule_period_key", periodKey)
          .not("status", "in", '("CANCELLED","DECLINED","REJECTED")')
          .maybeSingle();

        const amount = Math.max(0, Number(sched.fixed_amount_pence ?? 0));
        const fundingBlockReason =
          companyBalance.sections?.company_transfer_available?.reason_code
          ?? companyBalance.sections?.operational_reserve?.reason_code
          ?? null;
        const gate = evaluateAutomaticCompanyPaymentGates({
          payee_active: payee.active !== false,
          payee_paused: payee.paused === true,
          payee_verification_status: String(payee.account_verification_status ?? ""),
          revolut_counterparty_id: payee.revolut_counterparty_id,
          schedule_paused: sched.paused === true,
          schedule_automatic_enabled: sched.automatic_enabled === true,
          amount_pence: amount,
          maximum_amount_pence: sched.maximum_amount_pence,
          company_available_for_transfer_pence: companyBalance.company_available_for_transfer_pence,
          funding_block_reason: fundingBlockReason,
          duplicate_period_exists: Boolean(prior),
          prior_transfer_same_payable: Boolean(prior),
          payable_approved: sched.approval_required === false ? true : undefined,
          currency_match: String(payee.currency ?? "GBP").toUpperCase() === "GBP",
        });
        if (!gate.ok) {
          results.push({ schedule_id: sched.id, status: gate.status });
          continue;
        }

        const draft = buildAutomaticPeriodPayableDraft({
          schedule_id: String(sched.id),
          schedule_period_key: periodKey,
          payee_id: String(payee.id),
          amount_pence: amount,
          category: String(sched.category ?? "STAFF_SALARY"),
          currency: String(payee.currency ?? "GBP"),
        });

        if (input.dry_run !== false) {
          results.push({
            schedule_id: sched.id,
            status: "DRY_RUN_OK",
            draft,
            live_transfer: false,
          });
          continue;
        }

        // Insert DRAFT only — never Revolut /pay here.
        const transferRef = `COT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        const { data: allocatedRef, error: refErr } = await supabase.rpc(
          "allocate_company_transfer_payment_reference",
          { p_kind: "CT" },
        );
        if (refErr || !allocatedRef) {
          results.push({
            schedule_id: sched.id,
            status: "CREATE_FAILED",
            error: refErr?.message ?? "PAYMENT_REFERENCE_ALLOCATE_FAILED",
          });
          continue;
        }
        const paymentReference = String(allocatedRef).trim();
        const { data: created, error: createErr } = await supabase
          .from("company_outgoing_transfers")
          .insert({
            transfer_ref: transferRef,
            recipient_name: payee.display_name || payee.legal_name,
            recipient_type: payee.payee_type,
            category: draft.category,
            money_source: "COMPANY_BALANCE",
            destination_account: payee.masked_account,
            payee_id: payee.id,
            amount_pence: draft.amount_pence,
            approved_amount_pence: draft.amount_pence,
            currency: draft.currency,
            purpose: `Automatic ${draft.category} ${periodKey}`,
            payment_reference: paymentReference,
            revolut_counterparty_id: payee.revolut_counterparty_id,
            revolut_recipient_account_id: payee.revolut_recipient_account_id,
            requested_by: actorId,
            approvals_required: 1,
            approval_count: 0,
            provider: "revolut_business",
            status: "AWAITING_APPROVAL",
            execution_mode: sched.execution_mode ?? "DRAFT_FOR_APPROVAL",
            schedule_id: sched.id,
            schedule_period_key: periodKey,
            idempotency_key: draft.idempotency_key,
            metadata: {
              automatic: true,
              dry_run: false,
              live_pay: false,
              payment_reference: paymentReference,
              payment_reference_ssot: true,
            },
          })
          .select("id, transfer_ref, status, payment_reference")
          .single();
        if (createErr) {
          results.push({ schedule_id: sched.id, status: "CREATE_FAILED", error: createErr.message });
          continue;
        }
        const advanced = computeCompanyPayeeNextRun({
          frequency: sched.frequency,
          weekly_day: sched.weekly_day,
          monthly_day: sched.monthly_day,
          local_processing_time: sched.local_processing_time,
          timezone: sched.timezone,
          automatic_enabled: true,
          paused: false,
          start_date: sched.start_date,
          end_date: sched.end_date,
          now: new Date(Date.now() + 60_000),
        });
        await supabase.from("company_payee_schedules").update({
          last_run_at: nowIso,
          last_period_key: periodKey,
          next_run_at: advanced.next_run_at,
          next_run_at_local: advanced.next_run_at_local,
          updated_at: nowIso,
        }).eq("id", sched.id);
        results.push({
          schedule_id: sched.id,
          status: "DRAFT_CREATED",
          transfer: created,
          live_transfer: false,
        });
      }

      return jsonResponse({
        success: true,
        dry_run: input.dry_run !== false,
        live_transfers_executed: 0,
        results,
        company_balance_status: companyBalance.status_code ?? companyBalance.status,
      });
    }

    return jsonResponse({ success: false, error: "Unhandled action" }, 400);
  } catch (err) {
    console.error("[admin-company-payees]", err);
    return jsonResponse({
      success: false,
      error: safeErrorMessage(err, "admin-company-payees failed"),
      message: safeErrorMessage(err, "admin-company-payees failed"),
    }, 500);
  }
});
