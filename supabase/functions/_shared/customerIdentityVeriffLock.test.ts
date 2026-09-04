/**
 * Lock: mandatory customer identity blocks book; optional never blocks.
 */

import {
  assertCustomerIdentityBookAllowed,
  mapVeriffDecisionStatus,
} from "./customerIdentityVeriff.ts";

Deno.test("mapVeriffDecisionStatus maps approved/declined", () => {
  if (mapVeriffDecisionStatus("approved") !== "approved") {
    throw new Error("approved");
  }
  if (mapVeriffDecisionStatus("declined") !== "declined") {
    throw new Error("declined");
  }
});

Deno.test("assertCustomerIdentityBookAllowed skips when mode not mandatory", async () => {
  const supabase = {
    from(table: string) {
      if (table === "service_area_customer_identity_settings") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: {
                      service_area_id: "sa1",
                      mode: "optional",
                      provider: "manual",
                      provider_workflow_id: null,
                      maximum_attempts: 3,
                      session_expiry_minutes: 60,
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  const result = await assertCustomerIdentityBookAllowed(
    supabase as never,
    "user-1",
    "sa1",
  );
  if (!result.ok) throw new Error("optional must allow book");
});

Deno.test("assertCustomerIdentityBookAllowed blocks mandatory unverified", async () => {
  const supabase = {
    from(table: string) {
      if (table === "service_area_customer_identity_settings") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: {
                      service_area_id: "sa1",
                      mode: "mandatory",
                      provider: "manual",
                      provider_workflow_id: null,
                      maximum_attempts: 3,
                      session_expiry_minutes: 60,
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      if (table === "customers") {
        return {
          select() {
            return {
              eq() {
                return {
                  is() {
                    return {
                      maybeSingle: async () => ({
                        data: { id: "c1", identity_verified_at: null },
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  const result = await assertCustomerIdentityBookAllowed(
    supabase as never,
    "user-1",
    "sa1",
  );
  if (result.ok || result.code !== "CUSTOMER_IDENTITY_VERIFICATION_REQUIRED") {
    throw new Error("mandatory unverified must block");
  }
});
