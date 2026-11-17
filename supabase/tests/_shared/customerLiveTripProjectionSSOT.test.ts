/**
 * deno test --allow-read supabase/functions/_shared/customerLiveTripProjectionSSOT.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCustomerLiveTripProjection,
  nextAssignmentGeneration,
} from "../../functions/publish-customer-live-trip/lib/customerLiveTripProjectionSSOT.ts";

const DRIVER_A = "00000000-0000-4000-8000-000000000001";
const DRIVER_B = "00000000-0000-4000-8000-000000000002";

Deno.test("nextAssignmentGeneration increments on rematch and reassign", () => {
  assertEquals(
    nextAssignmentGeneration({
      previousGeneration: 1,
      previousDriverId: DRIVER_A,
      nextDriverId: null,
      rematching: true,
    }),
    2,
  );
  assertEquals(
    nextAssignmentGeneration({
      previousGeneration: 2,
      previousDriverId: null,
      nextDriverId: DRIVER_B,
      rematching: false,
    }),
    3,
  );
  assertEquals(
    nextAssignmentGeneration({
      previousGeneration: 3,
      previousDriverId: DRIVER_B,
      nextDriverId: DRIVER_B,
      rematching: false,
    }),
    3,
  );
  assertEquals(
    nextAssignmentGeneration({
      previousGeneration: 3,
      previousDriverId: DRIVER_B,
      nextDriverId: DRIVER_B,
      rematching: false,
      previousVehicleRegistration: "LG22 KKZ",
      nextVehicleRegistration: "KX14 HLD",
    }),
    4,
  );
});

Deno.test("rematch projection clears driver/vehicle and bumps generation", () => {
  const previous = buildCustomerLiveTripProjection({
    trip: {
      id: "t1",
      status: "en_route_to_pickup",
      confirmed_driver_id: DRIVER_A,
      eta_minutes: 8,
      driver: {
        id: DRIVER_A,
        first_name: "James",
        rating: 4.9,
        rating_count: 10,
        photo_url: "https://cdn.example/a.jpg",
        vehicle: {
          make: "Toyota",
          model: "Prius",
          colour: "Silver",
          license_plate: "LG22 KKZ",
        },
      },
    },
    customerUserId: "u1",
    nowMs: 1_000,
  })!;

  const rematch = buildCustomerLiveTripProjection({
    trip: {
      id: "t1",
      status: "searching_new_driver",
      cancelled_driver_ids: [DRIVER_A],
    },
    customerUserId: "u1",
    previous,
    nowMs: 2_000,
  })!;

  assertEquals(rematch.eligible, true);
  assertEquals(rematch.lifecycle_stage, "finding_new_driver");
  assertEquals(rematch.status_title, "Finding a new driver");
  assertEquals(rematch.assigned_driver_id, null);
  assertEquals(rematch.driver_first_name, null);
  assertEquals(rematch.vehicle_registration, null);
  assertEquals(rematch.eta_minutes, null);
  assertEquals(rematch.assignment_generation, previous.assignment_generation + 1);
  assertEquals(rematch.presentation_version, previous.presentation_version + 1);
});

Deno.test("replacement Driver B is atomic and never mixes A vehicle", () => {
  const previous = buildCustomerLiveTripProjection({
    trip: {
      id: "t1",
      status: "searching_new_driver",
    },
    customerUserId: "u1",
    previous: {
      assignment_generation: 2,
      presentation_version: 2,
      assigned_driver_id: null,
    },
    nowMs: 3_000,
  })!;

  const next = buildCustomerLiveTripProjection({
    trip: {
      id: "t1",
      status: "en_route_to_pickup",
      confirmed_driver_id: DRIVER_B,
      eta_minutes: 6,
      driver: {
        id: DRIVER_B,
        first_name: "Sam",
        rating: 4.8,
        rating_count: 20,
        photo_url: "https://cdn.example/b.jpg",
        vehicle: {
          make: "Kia",
          model: "Niro",
          colour: "White",
          license_plate: "BK71 XYZ",
        },
      },
    },
    customerUserId: "u1",
    previous,
    nowMs: 4_000,
  })!;

  assertEquals(next.assigned_driver_id, DRIVER_B);
  assertEquals(next.driver_first_name, "Sam");
  assertEquals(next.vehicle_make, "Kia");
  assertEquals(next.vehicle_registration, "BK71 XYZ");
  assertEquals(next.eta_minutes, 6);
  assertEquals(next.lifecycle_stage, "heading_to_pickup");
  assertEquals(next.content_state.showDriverVehicle, true);
});

Deno.test("scheduled pre-activation projection is ineligible", () => {
  const row = buildCustomerLiveTripProjection({
    trip: {
      id: "t1",
      status: "accepted",
      is_scheduled: true,
      scheduled_status: "marketplace_accepted",
      scheduled_at: "2026-12-01T18:00:00Z",
      confirmed_driver_id: DRIVER_A,
    },
    customerUserId: "u1",
    nowMs: Date.parse("2026-06-01T12:00:00Z"),
  })!;
  assertEquals(row.eligible, false);
  assertEquals(row.assigned_driver_id, null);
});

Deno.test("finding must not highlight Driver assigned progress (MK-261116-013)", () => {
  const finding = buildCustomerLiveTripProjection({
    trip: {
      id: "t1",
      status: "searching",
    },
    customerUserId: "u1",
    nowMs: 4_500,
  })!;
  assertEquals(finding.lifecycle_stage, "finding_driver");
  assertEquals(finding.status_title, "Finding your driver");
  assertEquals(finding.progress_step_index, -1);
  assertEquals(finding.content_state.progressStepIndex, -1);

  const assigned = buildCustomerLiveTripProjection({
    trip: {
      id: "t1",
      status: "accepted",
      confirmed_driver_id: DRIVER_A,
      driver: {
        id: DRIVER_A,
        first_name: "Alex",
        vehicle: { license_plate: "AB12 CDE" },
      },
    },
    customerUserId: "u1",
    previous: finding,
    nowMs: 4_600,
  })!;
  assertEquals(assigned.lifecycle_stage, "driver_assigned");
  assertEquals(assigned.status_title, "Driver assigned");
  assertEquals(assigned.progress_step_index, 0);
});

Deno.test("heading_to_pickup title is On the way (not stuck on Driver assigned)", () => {
  const row = buildCustomerLiveTripProjection({
    trip: {
      id: "t1",
      status: "en_route_to_pickup",
      confirmed_driver_id: DRIVER_A,
      driver: {
        id: DRIVER_A,
        first_name: "Alex",
        rating: 4.9,
        rating_count: 12,
        vehicle: {
          make: "Toyota",
          model: "Prius",
          colour: "Black",
          license_plate: "AB12 CDE",
        },
      },
    },
    customerUserId: "u1",
    nowMs: 5_000,
  })!;
  assertEquals(row.lifecycle_stage, "heading_to_pickup");
  assertEquals(row.status_title, "On the way");
  assertEquals(row.driver_first_name, "Alex");
  assertEquals(row.vehicle_registration, "AB12 CDE");
  assertEquals(row.content_state.statusTitle, "On the way");
});

Deno.test("publish hydrates identity — bare trips row alone cannot fill name/vehicle", () => {
  // Documents the MK-261116-011 defect class: without nested driver, identity is null.
  const bare = buildCustomerLiveTripProjection({
    trip: {
      id: "t1",
      status: "en_route_to_pickup",
      confirmed_driver_id: DRIVER_A,
    },
    customerUserId: "u1",
    nowMs: 6_000,
  })!;
  assertEquals(bare.assigned_driver_id, DRIVER_A);
  assertEquals(bare.driver_first_name, null);
  assertEquals(bare.vehicle_make, null);
});

Deno.test(
  "APNs content_state always includes ActivityKit-required assignmentEventMs (MK-261117-004)",
  () => {
    // OneCabLiveTripAttributes.ContentState.assignmentEventMs is non-optional Double.
    // Omitting it makes ActivityKit drop remote updates → Lock Screen stuck on Finding.
    const requiredKeys = [
      "phase",
      "statusTitle",
      "statusDescription",
      "progressStepIndex",
      "showDriverVehicle",
      "assignedDriverId",
      "assignmentEpoch",
      "assignmentEventMs",
      "updatedAtMs",
    ] as const;

    const finding = buildCustomerLiveTripProjection({
      trip: { id: "t1", status: "searching" },
      customerUserId: "u1",
      nowMs: 7_000,
    })!;
    for (const key of requiredKeys) {
      assertEquals(
        finding.content_state[key] !== undefined,
        true,
        `missing content_state.${key}`,
      );
    }
    assertEquals(finding.content_state.assignmentEventMs, 7_000);
    assertEquals(finding.content_state.updatedAtMs, 7_000);

    const arrived = buildCustomerLiveTripProjection({
      trip: {
        id: "t1",
        status: "arrived_at_pickup",
        confirmed_driver_id: DRIVER_A,
        driver: {
          id: DRIVER_A,
          first_name: "Alex",
          vehicle: { license_plate: "AB12 CDE" },
        },
      },
      customerUserId: "u1",
      previous: finding,
      nowMs: 7_100,
    })!;
    assertEquals(arrived.content_state.assignmentEventMs, 7_100);
    assertEquals(arrived.lifecycle_stage, "at_pickup");
  },
);
