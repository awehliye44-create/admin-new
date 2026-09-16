import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import {
  resolveAuthoritativeCorporateAccountId,
  assertCorporateAccountBookable,
  assertServiceAreaInOrgScope,
  assertClientActionIdOrgBound,
  assertPaymentMethodAllowed,
} from "../../functions/_shared/corporateBookAuthoritySSOT.ts";

const orgA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const userAdminA = "user-admin-a";
const userAdminB = "user-admin-b";
const userUnauth = "user-unauth";

const memberships = [
  { userId: userAdminA, corporateAccountId: orgA, role: "admin" },
  { userId: userAdminB, corporateAccountId: orgB, role: "admin" },
];

Deno.test("cannot create booking for another organisation", () => {
  const r = resolveAuthoritativeCorporateAccountId({
    memberships,
    requestedCorporateAccountId: orgB,
    userId: userAdminA,
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "CORPORATE_ORG_MISMATCH");
});

Deno.test("unauthorised user denied", () => {
  const r = resolveAuthoritativeCorporateAccountId({
    memberships,
    requestedCorporateAccountId: orgA,
    userId: userUnauth,
  });
  assertEquals(r.ok, false);
});

Deno.test("admin A may book only org A", () => {
  const r = resolveAuthoritativeCorporateAccountId({
    memberships,
    requestedCorporateAccountId: orgA,
    userId: userAdminA,
  });
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.corporateAccountId, orgA);
});

Deno.test("suspended / unapproved accounts fail closed", () => {
  assertEquals(
    assertCorporateAccountBookable({ id: orgA, status: "suspended", service_area_id: "sa" }).ok,
    false,
  );
  assertEquals(
    assertCorporateAccountBookable({ id: orgA, status: "pending", service_area_id: "sa" }).ok,
    false,
  );
  assertEquals(
    assertCorporateAccountBookable({ id: orgA, status: "active", service_area_id: "sa" }).ok,
    true,
  );
});

Deno.test("cannot inject service area outside org scope", () => {
  const account = { id: orgA, status: "active", service_area_id: "sa-mk" };
  const r = assertServiceAreaInOrgScope({
    account,
    requestedServiceAreaId: "sa-kampala",
    serviceArea: { id: "sa-kampala", currency: "UGX", financial_model: "PLATFORM_COLLECTED" },
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "SERVICE_AREA_OUT_OF_SCOPE");
});

Deno.test("currency mismatch fail closed", () => {
  const account = { id: orgA, status: "active", service_area_id: "sa-mk" };
  const r = assertServiceAreaInOrgScope({
    account,
    requestedServiceAreaId: "sa-mk",
    serviceArea: { id: "sa-mk", currency: "GBP", financial_model: "PLATFORM_COLLECTED" },
    clientCurrency: "UGX",
  });
  assertEquals(r.ok, false);
});

Deno.test("cannot reuse another org client_action_id", () => {
  const r = assertClientActionIdOrgBound({
    sessionCorporateAccountId: orgB,
    authoritativeCorporateAccountId: orgA,
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, "CLIENT_ACTION_ORG_REUSE_DENIED");
});

Deno.test("wallet/invoice unavailable unless implemented+enabled", () => {
  assertEquals(
    assertPaymentMethodAllowed({
      method: "wallet",
      cardEnabled: true,
      walletImplementedAndEnabled: false,
      invoiceImplementedAndEnabled: false,
    }).ok,
    false,
  );
  assertEquals(
    assertPaymentMethodAllowed({
      method: "card",
      cardEnabled: true,
      walletImplementedAndEnabled: false,
      invoiceImplementedAndEnabled: false,
    }).ok,
    true,
  );
});

Deno.test("cross-org passenger/trip/invoice/report/chat denied by org mismatch helper", () => {
  // Same gate used for any org-scoped resource access.
  const r = resolveAuthoritativeCorporateAccountId({
    memberships,
    requestedCorporateAccountId: orgA,
    userId: userAdminB,
  });
  assertEquals(r.ok, false);
});
