/**
 * Phase 5 capability gate — global flag alone is insufficient.
 * Capability comes from the loaded OTA bind token — never native version alone.
 * Production key is scheduled_departure_ack_v2 (hydration-corrected OTA).
 * Run: deno test --no-check --allow-read supabase/functions/_shared/scheduledDepartureAckCapabilitySSOT.test.ts
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
  SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
  driverSupportsDepartureAck,
  isAppVersionAtLeast,
  normalizeCapabilityList,
  resolveDepartureAckCapabilityConfig,
  resolveDepartureAckExecutionModeForDriver,
} from "./scheduledDepartureAckCapabilitySSOT.ts";

const capableV2Snap = {
  capabilities: [
    SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
    SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
  ],
  appVersion: "1.0.6",
  deviceId: "install-capable-v2",
};

const v1OnlySnap = {
  capabilities: [SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1],
  appVersion: "1.0.6",
  deviceId: "install-v1-only",
};

Deno.test("default capability key is v2 (hydration-corrected OTA)", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
  });
  assertEquals(config.capabilityKey, SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2);
});

Deno.test("global flag off → ack_nro even when device advertises v2", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: false,
    scheduled_departure_ack_capability_key: SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
  });
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: capableV2Snap,
    }),
    "ack_nro",
  );
  assertEquals(
    driverSupportsDepartureAck({ config, snapshot: capableV2Snap }).reason,
    "global_flag_disabled",
  );
});

Deno.test("v1-only device with key=v2 → temporary Phase 4 ack_nro", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_capability_key: SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
  });
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: v1OnlySnap,
    }),
    "ack_nro",
  );
  assertEquals(
    driverSupportsDepartureAck({ config, snapshot: v1OnlySnap }).reason,
    "capability_missing",
  );
});

Deno.test("fresh v2 device with key=v2 → departure_ack", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_capability_key: SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
  });
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: capableV2Snap,
    }),
    "departure_ack",
  );
});

Deno.test("global flag on + missing capability → ack_nro (older OTA / same native)", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
  });
  // Same native app_version as capable build, but no OTA-advertised token.
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: {
        capabilities: [],
        appVersion: "1.0.6",
        deviceId: "install-legacy-ota",
      },
    }),
    "ack_nro",
  );
  assertEquals(
    driverSupportsDepartureAck({
      config,
      snapshot: {
        capabilities: [],
        appVersion: "1.0.6",
        deviceId: "install-legacy-ota",
      },
    }).reason,
    "capability_missing",
  );
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: null,
    }),
    "ack_nro",
  );
});

Deno.test("app_version alone never grants departure_ack", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_min_app_version: "1.0.0",
  });
  const highVersionNoCap = {
    capabilities: [] as string[],
    appVersion: "9.9.9",
    deviceId: "install-version-only",
  };
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: highVersionNoCap,
    }),
    "ack_nro",
  );
});

Deno.test("rollback bind clears v2 → ack_nro (empty replace)", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_capability_key: SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
  });
  // Simulate older OTA rebind that omitted client_capabilities → []
  assertEquals(normalizeCapabilityList(undefined), []);
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: {
        capabilities: normalizeCapabilityList(undefined),
        appVersion: "1.0.6",
        deviceId: "install-after-rollback",
      },
    }),
    "ack_nro",
  );
});

Deno.test("stale / missing active device_id fails closed", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_capability_key: SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
  });
  assertEquals(
    driverSupportsDepartureAck({
      config,
      snapshot: {
        capabilities: [
          SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
          SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
        ],
        appVersion: "1.0.6",
        deviceId: null,
      },
    }).reason,
    "no_active_device_id",
  );
});

Deno.test("mixed-device: only sole active device snapshot is evaluated", () => {
  // Secondary device may advertise v2; gate only sees sole active row snapshot.
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_capability_key: SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
  });
  const activeV1 = {
    capabilities: [SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1],
    appVersion: "1.0.6",
    deviceId: "active-phone",
  };
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({ config, snapshot: activeV1 }),
    "ack_nro",
  );
  const activeV2 = {
    capabilities: [
      SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
      SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
    ],
    appVersion: "1.0.6",
    deviceId: "active-phone",
  };
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({ config, snapshot: activeV2 }),
    "departure_ack",
  );
});

Deno.test("optional min app version floor rejects older builds after token present", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_capability_key: SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
    scheduled_departure_ack_min_app_version: "1.0.6",
  });
  assertEquals(isAppVersionAtLeast("1.0.5", "1.0.6"), false);
  assertEquals(isAppVersionAtLeast("1.0.6", "1.0.6"), true);
  assertEquals(isAppVersionAtLeast("1.0.6(64)", "1.0.6"), true);
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: {
        capabilities: [
          SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
          SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
        ],
        appVersion: "1.0.5",
        deviceId: "install-old",
      },
    }),
    "ack_nro",
  );
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: {
        capabilities: [
          SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
          SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
        ],
        appVersion: "1.0.6",
        deviceId: "install-ok",
      },
    }),
    "departure_ack",
  );
});

Deno.test("legacy key=v1 still grants with v1-only device (temporary compat)", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_capability_key: SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
  });
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: v1OnlySnap,
    }),
    "departure_ack",
  );
});

Deno.test("normalizeCapabilityList accepts array and JSON string", () => {
  assertEquals(normalizeCapabilityList(["Scheduled_Departure_Ack_V2"]), [
    "scheduled_departure_ack_v2",
  ]);
  assertEquals(
    normalizeCapabilityList(
      JSON.stringify([
        SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
        SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
      ]),
    ),
    [SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1, SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2],
  );
});
