import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { CorporateScheduleClaimRegistry } from "../../functions/_shared/corporateScheduleClaimSSOT.ts";

Deno.test("same client_action_id reclaim is idempotent", async () => {
  const reg = new CorporateScheduleClaimRegistry();
  const a = await reg.claim({
    corporateAccountId: "org-a",
    clientActionId: "key-1",
    scheduledAt: "2026-09-15T12:00:00.000Z",
    durationMinutes: 30,
    existingTrips: [],
  });
  const b = await reg.claim({
    corporateAccountId: "org-a",
    clientActionId: "key-1",
    scheduledAt: "2026-09-15T12:00:00.000Z",
    durationMinutes: 30,
    existingTrips: [],
  });
  assertEquals(a.ok, true);
  assertEquals(b.ok, true);
  if (a.ok && b.ok) {
    assertEquals(a.idempotent, false);
    assertEquals(b.idempotent, true);
  }
});

Deno.test("two concurrent overlapping claims: exactly one succeeds", async () => {
  const reg = new CorporateScheduleClaimRegistry();
  const results = await Promise.all([
    reg.claim({
      corporateAccountId: "org-a",
      clientActionId: "k-a",
      scheduledAt: "2026-09-15T12:00:00.000Z",
      durationMinutes: 30,
      existingTrips: [],
    }),
    reg.claim({
      corporateAccountId: "org-a",
      clientActionId: "k-b",
      scheduledAt: "2026-09-15T12:10:00.000Z",
      durationMinutes: 30,
      existingTrips: [],
    }),
  ]);
  const wins = results.filter((r) => r.ok);
  const losses = results.filter((r) => !r.ok);
  assertEquals(wins.length, 1);
  assertEquals(losses.length, 1);
  if (!losses[0].ok) assertEquals(losses[0].code, "SCHEDULE_OVERLAP");
});

Deno.test("non-overlapping concurrent claims both succeed", async () => {
  const reg = new CorporateScheduleClaimRegistry();
  const results = await Promise.all([
    reg.claim({
      corporateAccountId: "org-a",
      clientActionId: "k-a",
      scheduledAt: "2026-09-15T12:00:00.000Z",
      durationMinutes: 30,
      existingTrips: [],
    }),
    reg.claim({
      corporateAccountId: "org-a",
      clientActionId: "k-b",
      scheduledAt: "2026-09-15T18:00:00.000Z",
      durationMinutes: 30,
      existingTrips: [],
    }),
  ]);
  assertEquals(results.every((r) => r.ok), true);
});

Deno.test("existing trip blocks new claim", async () => {
  const reg = new CorporateScheduleClaimRegistry();
  const r = await reg.claim({
    corporateAccountId: "org-a",
    clientActionId: "k-new",
    scheduledAt: "2026-09-15T12:00:00.000Z",
    durationMinutes: 30,
    existingTrips: [{
      id: "trip-1",
      scheduled_at: "2026-09-15T12:00:00.000Z",
      estimated_duration_minutes: 30,
      status: "scheduled",
    }],
  });
  assertEquals(r.ok, false);
});

Deno.test("different orgs may overlap in time", async () => {
  const reg = new CorporateScheduleClaimRegistry();
  const results = await Promise.all([
    reg.claim({
      corporateAccountId: "org-a",
      clientActionId: "k-a",
      scheduledAt: "2026-09-15T12:00:00.000Z",
      durationMinutes: 30,
      existingTrips: [],
    }),
    reg.claim({
      corporateAccountId: "org-b",
      clientActionId: "k-b",
      scheduledAt: "2026-09-15T12:00:00.000Z",
      durationMinutes: 30,
      existingTrips: [],
    }),
  ]);
  assertEquals(results.every((r) => r.ok), true);
});
