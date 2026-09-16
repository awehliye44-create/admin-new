/**
 * A8B28F Stage B2 — source locks + mocked Revolut linkage (no live provider I/O).
 * Run: deno test --allow-read supabase/functions/_shared/updateDriverPayoutDestinationHandler.b2Lock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";
import {
  attemptAutoRevolutLinkage,
} from "./updateDriverPayoutDestinationHandler.ts";
import {
  PAYOUT_DESTINATION_OUTCOME,
  httpStatusForOutcome,
  isClientSuccessOutcome,
  resolveSyncUkRevolutOutcome,
} from "./payoutDestinationVerificationOutcomeSSOT.ts";
import { PROVIDER_LINK_STATUS } from "./driverPayoutProviderLinkageSSOT.ts";
import { DESTINATION_STATUS } from "./driverPayoutDestinationSSOT.ts";

const SHARED = fromFileUrl(new URL(".", import.meta.url));
const ENTRY = join(SHARED, "..", "update-driver-payout-destination", "index.ts");

type DestRow = {
  id: string;
  linkage_version: number;
  verification_status?: string;
  provider_link_status?: string;
  provider_counterparty_id?: string | null;
  provider_recipient_account_id?: string | null;
  provider_error_code?: string | null;
  provider_error_message_safe?: string | null;
  destination_payload?: Record<string, unknown>;
};

function createMockSupabase(state: {
  destinations: Map<string, DestRow>;
  audits: Array<Record<string, unknown>>;
  forbidTables?: Set<string>;
}) {
  const chain = (table: string) => {
    if (state.forbidTables?.has(table)) {
      throw new Error(`FORBIDDEN_TABLE_${table}`);
    }
    let filters: Record<string, unknown> = {};
    let pendingUpdate: Record<string, unknown> | null = null;
    let pendingInsert: Record<string, unknown> | null = null;
    let wantSelect = false;

    const api: Record<string, unknown> = {
      update(payload: Record<string, unknown>) {
        pendingUpdate = payload;
        return api;
      },
      insert(payload: Record<string, unknown>) {
        pendingInsert = payload;
        return api;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return api;
      },
      select(_cols?: string) {
        wantSelect = true;
        return api;
      },
      async maybeSingle() {
        if (table === "driver_payout_destinations" && pendingUpdate) {
          const id = String(filters.id ?? "");
          const expectedLv = filters.linkage_version;
          const row = state.destinations.get(id);
          if (!row || (expectedLv != null && row.linkage_version !== expectedLv)) {
            return { data: null, error: null };
          }
          Object.assign(row, pendingUpdate);
          return { data: wantSelect ? { id: row.id } : row, error: null };
        }
        if (table === "driver_payout_destinations" && !pendingUpdate && !pendingInsert) {
          const id = String(filters.id ?? "");
          const row = state.destinations.get(id);
          return {
            data: row
              ? { id: row.id, destination_payload: (row as DestRow & { destination_payload?: unknown }).destination_payload ?? {} }
              : null,
            error: null,
          };
        }
        return { data: null, error: null };
      },
      async single() {
        return (api as { maybeSingle: () => Promise<unknown> }).maybeSingle();
      },
      then(resolve: (v: unknown) => void) {
        // await supabase.from(...).update(...).eq(...) without select
        return Promise.resolve(
          (async () => {
            if (table === "driver_payout_destinations" && pendingUpdate) {
              const id = String(filters.id ?? "");
              const expectedLv = filters.linkage_version;
              const row = state.destinations.get(id);
              if (!row || (expectedLv != null && row.linkage_version !== expectedLv)) {
                return resolve({ data: null, error: null });
              }
              Object.assign(row, pendingUpdate);
              return resolve({ data: { id: row.id }, error: null });
            }
            if (table === "driver_payout_destination_audit" && pendingInsert) {
              state.audits.push(pendingInsert);
              return resolve({ data: { id: `audit_${state.audits.length}` }, error: null });
            }
            return resolve({ data: null, error: null });
          })(),
        );
      },
    };
    return api;
  };

  return {
    from(table: string) {
      return chain(table);
    },
  } as unknown as import("npm:@supabase/supabase-js@2.57.2").SupabaseClient;
}

Deno.test("B2 source lock: fail-closed HTTP outcomes + concurrency + no payout flags", async () => {
  const handler = await Deno.readTextFile(join(SHARED, "updateDriverPayoutDestinationHandler.ts"));
  const entry = await Deno.readTextFile(ENTRY);
  assertStringIncludes(handler, "httpStatusForOutcome");
  assertStringIncludes(handler, "resolveSyncUkRevolutOutcome");
  assertStringIncludes(handler, "isClientSuccessOutcome");
  assertStringIncludes(handler, "RETRY_REQUIRED");
  assertStringIncludes(handler, "linkage_version");
  assertStringIncludes(handler, "STALE_FAILURE_NOT_APPLIED");
  assertStringIncludes(handler, "CONCURRENT_LINK_UPDATE");
  assertStringIncludes(handler, "DUPLICATE_COUNTERPARTY_RECONCILIATION_REQUIRED");
  assertStringIncludes(handler, "Normalized logs only");
  const ssot = await Deno.readTextFile(join(SHARED, "payoutDestinationVerificationOutcomeSSOT.ts"));
  assertStringIncludes(ssot, "DESTINATION_SAVED_VERIFICATION_FAILED");
  assertStringIncludes(ssot, "DESTINATION_SAVED_VERIFICATION_PENDING");
  assert(!/DESTINATION_STATUS\.MANUAL_VERIFIED/.test(handler));
  assert(!/\.from\(\s*["']drivers["']\s*\)/.test(handler));
  assert(!/payouts_enabled\s*:/.test(handler));
  assert(!/payout_operational_paused\s*:/.test(handler));
  assertStringIncludes(entry, "auth.getUser");
  assertStringIncludes(entry, "retry_existing");
  assertStringIncludes(entry, "Ignore any client-supplied driver_id");
  assert(!/console\.error\([^)]*error\)/.test(entry)); // no raw error dump
});

Deno.test("B2 source lock: entrypoint auth before handler; verify_jwt remains in-function", async () => {
  const entry = await Deno.readTextFile(ENTRY);
  assertStringIncludes(entry, 'if (!authHeader)');
  assertStringIncludes(entry, 'status: 401');
  assertStringIncludes(entry, "user.id");
  // Body never selects driver — JWT user id only.
  assert(!/body\.driver_id/.test(entry));
});

Deno.test("old client treats HTTP 422 as failure (resp.ok=false)", () => {
  const httpOk = false; // fetch Response.ok for 422
  assertEquals(httpOk, false);
  assertEquals(httpStatusForOutcome(PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED), 422);
});

Deno.test("mocked Revolut success → verified with refs", async () => {
  const destId = "dest_ok";
  const state = {
    destinations: new Map<string, DestRow>([[destId, { id: destId, linkage_version: 1 }]]),
    audits: [] as Array<Record<string, unknown>>,
    forbidTables: new Set(["drivers", "driver_wallet_ledger", "trips", "payment_sessions", "payout_items"]),
  };
  const supabase = createMockSupabase(state);
  const result = await attemptAutoRevolutLinkage({
    supabase,
    destinationId: destId,
    driverId: "drv_synth",
    actorUserId: "user_synth",
    destinationType: "uk_bank_account",
    destinationIdentifier: "40166412345678",
    accountHolderName: "Synthetic Holder",
    currencyCode: "GBP",
    expectedLinkageVersion: 1,
    deps: {
      ensureToken: async () => ({ accessToken: "synthetic_token" }),
      createCounterparty: async () => ({
        id: "cp_synth",
        accounts: [{ id: "ra_synth" }],
      }),
    },
  });
  assertEquals(result.provider_link_status, PROVIDER_LINK_STATUS.PROVIDER_VERIFIED);
  assertEquals(result.verification_status, DESTINATION_STATUS.PROVIDER_VERIFIED);
  assertEquals(result.provider_counterparty_id, "cp_synth");
  assertEquals(result.provider_recipient_account_id, "ra_synth");
  const outcome = resolveSyncUkRevolutOutcome({
    saveOk: true,
    linkStatus: result.provider_link_status,
    verificationStatus: result.verification_status,
    hasCounterpartyRef: !!result.provider_counterparty_id,
    hasRecipientRef: !!result.provider_recipient_account_id,
  });
  assertEquals(outcome, PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_AND_VERIFIED);
  assertEquals(isClientSuccessOutcome(outcome), true);
  assertEquals(state.destinations.get(destId)?.linkage_version, 2);
  assertEquals(state.audits.some((a) => a.action === "provider_link_synced"), true);
  assertEquals(state.audits.some((a) => a.changed_by_user_id === "user_synth"), true);
});

Deno.test("mocked Revolut failure → FAILED + not pending outcome", async () => {
  const destId = "dest_fail";
  const state = {
    destinations: new Map<string, DestRow>([[destId, { id: destId, linkage_version: 1 }]]),
    audits: [] as Array<Record<string, unknown>>,
  };
  const supabase = createMockSupabase(state);
  const result = await attemptAutoRevolutLinkage({
    supabase,
    destinationId: destId,
    driverId: "drv_synth",
    actorUserId: "user_synth",
    destinationType: "uk_bank_account",
    destinationIdentifier: "40166412345678",
    accountHolderName: "Synthetic Holder",
    currencyCode: "GBP",
    expectedLinkageVersion: 1,
    deps: {
      ensureToken: async () => ({ accessToken: "synthetic_token" }),
      createCounterparty: async () => {
        throw Object.assign(new Error("invalid sort code"), { status: 400 });
      },
    },
  });
  assertEquals(result.provider_link_status, PROVIDER_LINK_STATUS.FAILED);
  assertEquals(result.provider_counterparty_id, null);
  const outcome = resolveSyncUkRevolutOutcome({
    saveOk: true,
    linkStatus: result.provider_link_status,
    verificationStatus: result.verification_status,
    hasCounterpartyRef: false,
    hasRecipientRef: false,
  });
  assertEquals(outcome, PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED);
  assertEquals(httpStatusForOutcome(outcome), 422);
  assertEquals(isClientSuccessOutcome(outcome), false);
});

Deno.test("duplicate counterparty → RETRY_REQUIRED, no fabricated refs", async () => {
  const destId = "dest_dup";
  const state = {
    destinations: new Map<string, DestRow>([[destId, { id: destId, linkage_version: 1 }]]),
    audits: [] as Array<Record<string, unknown>>,
  };
  const supabase = createMockSupabase(state);
  const result = await attemptAutoRevolutLinkage({
    supabase,
    destinationId: destId,
    driverId: "drv_synth",
    actorUserId: "user_synth",
    destinationType: "uk_bank_account",
    destinationIdentifier: "40166412345678",
    accountHolderName: "Synthetic Holder",
    currencyCode: "GBP",
    expectedLinkageVersion: 1,
    deps: {
      ensureToken: async () => ({ accessToken: "synthetic_token" }),
      createCounterparty: async () => {
        throw Object.assign(new Error("duplicate counterparty already exists"), { status: 409 });
      },
    },
  });
  assertEquals(result.provider_error_code, "DUPLICATE_COUNTERPARTY_RECONCILIATION_REQUIRED");
  assertEquals(result.provider_counterparty_id, null);
  assertEquals(result.provider_recipient_account_id, null);
  assertEquals(result.failure_class, "DUPLICATE_COUNTERPARTY_RECONCILIATION_REQUIRED");
});

Deno.test("stale failure cannot overwrite newer verified row", async () => {
  const destId = "dest_stale";
  const state = {
    destinations: new Map<string, DestRow>([[
      destId,
      {
        id: destId,
        linkage_version: 5, // newer than expected 1
        verification_status: DESTINATION_STATUS.PROVIDER_VERIFIED,
        provider_link_status: PROVIDER_LINK_STATUS.PROVIDER_VERIFIED,
        provider_counterparty_id: "cp_existing",
        provider_recipient_account_id: "ra_existing",
      },
    ]]),
    audits: [] as Array<Record<string, unknown>>,
  };
  const supabase = createMockSupabase(state);
  const result = await attemptAutoRevolutLinkage({
    supabase,
    destinationId: destId,
    driverId: "drv_synth",
    actorUserId: "user_synth",
    destinationType: "uk_bank_account",
    destinationIdentifier: "40166412345678",
    accountHolderName: "Synthetic Holder",
    currencyCode: "GBP",
    expectedLinkageVersion: 1,
    deps: {
      ensureToken: async () => ({ accessToken: "synthetic_token" }),
      createCounterparty: async () => {
        throw Object.assign(new Error("timeout"), { status: 503 });
      },
    },
  });
  assertEquals(result.provider_error_code, "STALE_FAILURE_NOT_APPLIED");
  // Verified refs on row must remain.
  const row = state.destinations.get(destId)!;
  assertEquals(row.linkage_version, 5);
  assertEquals(row.provider_link_status, PROVIDER_LINK_STATUS.PROVIDER_VERIFIED);
  assertEquals(row.provider_counterparty_id, "cp_existing");
});

Deno.test("concurrent success update collision → CONCURRENT_LINK_UPDATE", async () => {
  const destId = "dest_race";
  const state = {
    destinations: new Map<string, DestRow>([[destId, { id: destId, linkage_version: 9 }]]),
    audits: [] as Array<Record<string, unknown>>,
  };
  const supabase = createMockSupabase(state);
  const result = await attemptAutoRevolutLinkage({
    supabase,
    destinationId: destId,
    driverId: "drv_synth",
    actorUserId: "user_synth",
    destinationType: "uk_bank_account",
    destinationIdentifier: "40166412345678",
    accountHolderName: "Synthetic Holder",
    currencyCode: "GBP",
    expectedLinkageVersion: 1, // stale
    deps: {
      ensureToken: async () => ({ accessToken: "synthetic_token" }),
      createCounterparty: async () => ({
        id: "cp_race",
        accounts: [{ id: "ra_race" }],
      }),
    },
  });
  assertEquals(result.provider_error_code, "CONCURRENT_LINK_UPDATE");
  assertEquals(result.provider_counterparty_id, null);
});

Deno.test("non-uk destination is not converted to failure (async pending path)", async () => {
  const destId = "dest_async";
  const state = {
    destinations: new Map<string, DestRow>([[destId, { id: destId, linkage_version: 1 }]]),
    audits: [] as Array<Record<string, unknown>>,
  };
  const supabase = createMockSupabase(state);
  let providerCalls = 0;
  const result = await attemptAutoRevolutLinkage({
    supabase,
    destinationId: destId,
    driverId: "drv_synth",
    actorUserId: "user_synth",
    destinationType: "mobile_money",
    destinationIdentifier: "07000000000",
    accountHolderName: null,
    currencyCode: "GBP",
    expectedLinkageVersion: 1,
    deps: {
      ensureToken: async () => {
        providerCalls++;
        return { accessToken: "should_not_run" };
      },
      createCounterparty: async () => {
        providerCalls++;
        return { id: "x", accounts: [{ id: "y" }] };
      },
    },
  });
  assertEquals(providerCalls, 0);
  assertEquals(result.provider_link_status, PROVIDER_LINK_STATUS.NOT_LINKED);
  assertEquals(
    resolveSyncUkRevolutOutcome({
      saveOk: true,
      linkStatus: result.provider_link_status,
      verificationStatus: result.verification_status,
      hasCounterpartyRef: false,
      hasRecipientRef: false,
    }),
    PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_PENDING,
  );
});

Deno.test("B2R: UK company details + Revolut 403 → config class, audit lands, no typo blame", async () => {
  const destId = "dest_mk0006_style";
  const state = {
    destinations: new Map<string, DestRow>([[
      destId,
      {
        id: destId,
        linkage_version: 1,
        destination_payload: {
          destination_type: "uk_bank_account",
          destination_last4: "3778",
          account_holder_name: "ONECAB Limited",
        },
      } as DestRow,
    ]]),
    audits: [] as Array<Record<string, unknown>>,
  };
  const supabase = createMockSupabase(state);
  const result = await attemptAutoRevolutLinkage({
    supabase,
    destinationId: destId,
    driverId: "drv_synth",
    actorUserId: "user_synth",
    destinationType: "uk_bank_account",
    destinationIdentifier: "04000379313778",
    accountHolderName: "ONECAB Limited",
    currencyCode: "GBP",
    expectedLinkageVersion: 1,
    deps: {
      ensureToken: async () => ({ accessToken: "synthetic_token" }),
      createCounterparty: async () => {
        throw Object.assign(
          new Error(
            "IP address is not whitelisted. Verify IP whitelist configuration in Revolut Business Portal.",
          ),
          { status: 403 },
        );
      },
    },
  });
  assertEquals(result.failure_class, "PROVIDER_CONFIGURATION_REQUIRED");
  assertEquals(result.http_status, 403);
  assertEquals(result.provider_error_code, "PROVIDER_CONFIGURATION_REQUIRED");
  assertEquals(result.provider_link_status, PROVIDER_LINK_STATUS.FAILED);
  const row = state.destinations.get(destId)! as DestRow & {
    destination_payload?: Record<string, unknown>;
    provider_error_message_safe?: string;
  };
  assertEquals(row.destination_payload?.provider_link_failure_class, "PROVIDER_CONFIGURATION_REQUIRED");
  assertEquals(row.destination_payload?.provider_http_status, 403);
  assertEquals(
    (row as { provider_link_failure_class?: string }).provider_link_failure_class,
    "PROVIDER_CONFIGURATION_REQUIRED",
  );
  assertEquals((row as { provider_http_status?: number }).provider_http_status, 403);
  assertEquals(String(row.provider_error_message_safe ?? "").includes("IP whitelist"), true);
  const blocked = state.audits.find((a) => a.action === "provider_link_blocked");
  assertEquals(Boolean(blocked), true);
  assertEquals(blocked?.changed_by_user_id, "user_synth");
  assertEquals(
    (blocked?.metadata as { audit_kind?: string } | undefined)?.audit_kind,
    "provider_auto_link_failed",
  );
  const msg = (await import("./payoutDestinationVerificationOutcomeSSOT.ts")).driverFacingMessageForOutcome(
    PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED,
    result.failure_class,
  );
  assertEquals(msg.includes("Check the details"), false);
  assertEquals(msg.includes("automatically"), true);
});

Deno.test("PII/secret scan on handler + entrypoint sources", async () => {
  const handler = await Deno.readTextFile(join(SHARED, "updateDriverPayoutDestinationHandler.ts"));
  const entry = await Deno.readTextFile(ENTRY);
  const ssot = await Deno.readTextFile(join(SHARED, "payoutDestinationVerificationOutcomeSSOT.ts"));
  for (const src of [handler, entry, ssot]) {
    assert(!/sk_live_|rk_live_|Bearer\s+[A-Za-z0-9._-]{20,}/.test(src));
    assert(!/console\.(?:error|warn|log)\([^)]*destination_identifier/.test(src));
    assert(!/console\.(?:error|warn|log)\([^)]*sort_code/.test(src));
    assert(!/console\.(?:error|warn|log)\([^)]*account_number/.test(src));
  }
});
