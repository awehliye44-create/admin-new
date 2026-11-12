/**
 * Phase 5 capability gate — global flag alone is insufficient.
 * Capability comes from the loaded OTA bind token — never native version alone.
 * Run: deno test --no-check --allow-read supabase/functions/_shared/scheduledDepartureAckCapabilitySSOT.test.ts
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
  driverSupportsDepartureAck,
  isAppVersionAtLeast,
  normalizeCapabilityList,
  resolveDepartureAckCapabilityConfig,
  resolveDepartureAckExecutionModeForDriver,
} from "./scheduledDepartureAckCapabilitySSOT.ts";

const capableSnap = {
  capabilities: [SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1],
  appVersion: "1.0.6",
  deviceId: "install-capable-01",
};

Deno.test("global flag off → ack_nro even when device advertises capability", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: false,
    scheduled_departure_ack_capability_key: SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
  });
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: capableSnap,
    }),
    "ack_nro",
  );
  assertEquals(
    driverSupportsDepartureAck({ config, snapshot: capableSnap }).reason,
    "global_flag_disabled",
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

Deno.test("global flag on + capability → departure_ack", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_capability_key: SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1,
  });
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: capableSnap,
    }),
    "departure_ack",
  );
});

Deno.test("rollback bind clears capability → ack_nro (empty replace)", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
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
  });
  assertEquals(
    driverSupportsDepartureAck({
      config,
      snapshot: {
        capabilities: [SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1],
        appVersion: "1.0.6",
        deviceId: null,
      },
    }).reason,
    "no_active_device_id",
  );
});

Deno.test("optional min app version floor rejects older builds after token present", () => {
  const config = resolveDepartureAckCapabilityConfig({
    scheduled_departure_ack_enabled: true,
    scheduled_departure_ack_min_app_version: "1.0.6",
  });
  assertEquals(isAppVersionAtLeast("1.0.5", "1.0.6"), false);
  assertEquals(isAppVersionAtLeast("1.0.6", "1.0.6"), true);
  assertEquals(isAppVersionAtLeast("1.0.6(64)", "1.0.6"), true);
  assertEquals(
    resolveDepartureAckExecutionModeForDriver({
      config,
      snapshot: {
        capabilities: [SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1],
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
        capabilities: [SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1],
        appVersion: "1.0.6",
        deviceId: "install-ok",
      },
    }),
    "departure_ack",
  );
});

Deno.test("normalizeCapabilityList accepts array and JSON string", () => {
  assertEquals(normalizeCapabilityList(["Scheduled_Departure_Ack_V1"]), [
    "scheduled_departure_ack_v1",
  ]);
  assertEquals(
    normalizeCapabilityList(JSON.stringify([SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1])),
    [SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1],
  );
});
