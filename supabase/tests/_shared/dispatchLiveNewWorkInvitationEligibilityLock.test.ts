/**
 * MK-261105-002 / MK0009 — SQL offer-create must use live new-work invitation
 * eligibility (not cached documents_approved alone).
 * Run: deno test --allow-read supabase/tests/_shared/dispatchLiveNewWorkInvitationEligibilityLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIG = new URL(
  "../../migrations/20261230180000_dispatch_live_new_work_invitation_eligibility.sql",
  import.meta.url,
);

Deno.test("migration defines driver_eligible_for_new_work_invitation with live docs", async () => {
  const sql = await Deno.readTextFile(MIG);
  assertStringIncludes(sql, "driver_eligible_for_new_work_invitation");
  assertStringIncludes(sql, "check_driver_documents_approved");
  assertStringIncludes(sql, "deleted_at");
  assertStringIncludes(sql, "suspended");
  // Enum-safe casts — bare COALESCE(..., '') raises 22P02 on driver_status.
  assertStringIncludes(sql, "approval_status::text");
  assertStringIncludes(sql, "driver_status::text");
  // Must not gate invitation eligibility on online/presence inside the helper.
  const helperMatch = sql.match(
    /CREATE OR REPLACE FUNCTION public\.driver_eligible_for_new_work_invitation[\s\S]*?\$function\$;/,
  );
  assert(helperMatch, "helper function missing");
  const helper = helperMatch[0];
  assertEquals(/is_online|driver_presence|last_heartbeat/i.test(helper), false);
});

Deno.test("migration rewrites dispatch_trip_offers + commit_dispatch_wave filters", async () => {
  const sql = await Deno.readTextFile(MIG);
  assertStringIncludes(
    sql,
    "WHERE public.driver_eligible_for_new_work_invitation(d.id)",
  );
  assertStringIncludes(
    sql,
    "AND public.driver_eligible_for_new_work_invitation(id)",
  );
  // No remaining cached documents_approved equality gates in rewritten bodies.
  assertEquals(/documents_approved\s*=\s*true/.test(sql), false);
});

Deno.test("source lock: Edge push gate + marketplace still use shared SSOT", async () => {
  const rideOffer = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/rideOfferDriverEligibility.ts",
      import.meta.url,
    ),
  );
  const marketplace = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/scheduledMarketplaceNotifySSOT.ts",
      import.meta.url,
    ),
  );
  const send = await Deno.readTextFile(
    new URL(
      "../../functions/send-driver-notification/index.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(rideOffer, "evaluateDriverDocumentState");
  assertStringIncludes(marketplace, "evaluateDriverNewWorkInvitationEligibility");
  assertStringIncludes(send, "evaluateScheduledMarketplaceInviteSendGate");
});
