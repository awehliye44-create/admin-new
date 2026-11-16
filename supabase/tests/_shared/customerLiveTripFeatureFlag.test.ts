/**
 * deno test --allow-read --allow-env supabase/tests/_shared/customerLiveTripFeatureFlag.test.ts
 *
 * Env kill-switches override DB. False env must keep fanout off even when DB
 * enabled=true (MK-261116-007 class: native live, flags still off).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveCustomerLiveTripPlatformGates } from "../../functions/_shared/customerLiveTripFeatureFlag.ts";

function fakeAdmin(row: {
  enabled: boolean;
  android_enabled?: boolean;
  ios_enabled?: boolean;
} | null) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: row, error: null }),
              };
            },
          };
        },
      };
    },
  };
}

function clearEnv() {
  Deno.env.delete("CUSTOMER_LIVE_TRIP_ENABLED");
  Deno.env.delete("CUSTOMER_LIVE_TRIP_ANDROID_ENABLED");
  Deno.env.delete("CUSTOMER_LIVE_TRIP_IOS_ENABLED");
  // APNs trio absent → ios stays off unless env forces and credentials exist.
  Deno.env.delete("APNS_KEY_ID");
  Deno.env.delete("APNS_TEAM_ID");
  Deno.env.delete("APNS_AUTH_KEY_P8");
  Deno.env.delete("APNS_CUSTOMER_BUNDLE_ID");
}

Deno.test("env false overrides DB enabled true (global + android)", async () => {
  clearEnv();
  Deno.env.set("CUSTOMER_LIVE_TRIP_ENABLED", "false");
  Deno.env.set("CUSTOMER_LIVE_TRIP_ANDROID_ENABLED", "false");
  const gates = await resolveCustomerLiveTripPlatformGates(
    fakeAdmin({ enabled: true, android_enabled: true, ios_enabled: true }),
  );
  assertEquals(gates.globalEnabled, false);
  assertEquals(gates.androidEnabled, false);
  clearEnv();
});

Deno.test("DB enabled + env unset → android on, iOS requires APNs", async () => {
  clearEnv();
  const gates = await resolveCustomerLiveTripPlatformGates(
    fakeAdmin({ enabled: true, android_enabled: true, ios_enabled: true }),
  );
  assertEquals(gates.globalEnabled, true);
  assertEquals(gates.androidEnabled, true);
  assertEquals(gates.iosEnabled, false);
  assertEquals(gates.apnsConfigured, false);
  clearEnv();
});

Deno.test("DB disabled + env unset → everything off", async () => {
  clearEnv();
  const gates = await resolveCustomerLiveTripPlatformGates(
    fakeAdmin({ enabled: false, android_enabled: true, ios_enabled: true }),
  );
  assertEquals(gates.globalEnabled, false);
  assertEquals(gates.androidEnabled, false);
  clearEnv();
});

Deno.test("env true enables global when DB false (env wins)", async () => {
  clearEnv();
  Deno.env.set("CUSTOMER_LIVE_TRIP_ENABLED", "true");
  Deno.env.set("CUSTOMER_LIVE_TRIP_ANDROID_ENABLED", "true");
  const gates = await resolveCustomerLiveTripPlatformGates(
    fakeAdmin({ enabled: false, android_enabled: false, ios_enabled: false }),
  );
  assertEquals(gates.globalEnabled, true);
  assertEquals(gates.androidEnabled, true);
  clearEnv();
});
