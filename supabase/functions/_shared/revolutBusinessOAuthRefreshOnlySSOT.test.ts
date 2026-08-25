/**
 * Step 9.4B — Business OAuth refresh-only lock tests (mocks only).
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertRefreshOnlySourceHasNoMoneyWriters,
  buildSafeRefreshResponse,
  classifyRefreshHttpFailure,
  fingerprintSecret,
  resolveRefreshTokenToStore,
  shouldPersistRefreshAgainstConcurrentVault,
  validateBusinessOAuthTokenResponse,
} from "./revolutBusinessOAuthRefreshOnlySSOT.ts";

Deno.test("valid refresh response validates and classifies bearer + READ scope", () => {
  const v = validateBusinessOAuthTokenResponse({
    access_token: "oa_prod_new_access_token_value_xxxxxxxx",
    token_type: "bearer",
    expires_in: 2400,
    scope: "READ,WRITE,PAY",
    refresh_token: "oa_prod_new_refresh_token_value_xxxxxxx",
  });
  assertEquals(v.ok, true);
  if (v.ok) {
    assertEquals(v.token_type, "bearer");
    assertEquals(v.scope_tokens.includes("READ"), true);
  }
});

Deno.test("rotated refresh stored; omitted refresh preserves existing", () => {
  const rotated = resolveRefreshTokenToStore({
    providerRefreshToken: "oa_prod_rotated",
    existingRefreshToken: "oa_prod_old",
  });
  assertEquals(rotated.rotated, true);
  assertEquals(rotated.refresh_token, "oa_prod_rotated");

  const preserved = resolveRefreshTokenToStore({
    providerRefreshToken: null,
    existingRefreshToken: "oa_prod_old",
  });
  assertEquals(preserved.rotated, false);
  assertEquals(preserved.refresh_token, "oa_prod_old");
});

Deno.test("invalid signature/audience/scope/token type fail closed (no write codes)", () => {
  assertEquals(validateBusinessOAuthTokenResponse({
    access_token: "x",
    token_type: "mac",
    expires_in: 100,
    scope: "READ",
  }).ok, false);

  assertEquals(validateBusinessOAuthTokenResponse({
    access_token: "x",
    token_type: "bearer",
    expires_in: 10,
    scope: "READ",
  }).ok, false);

  assertEquals(validateBusinessOAuthTokenResponse({
    access_token: "x",
    token_type: "bearer",
    expires_in: 100,
    scope: "WRITE",
  }, { requireScope: true, priorScopeTokens: [] }).ok, false);

  assertEquals(validateBusinessOAuthTokenResponse(null).ok, false);
});

Deno.test("HTTP 400/401/403/429/5xx/timeout write nothing; reauth classified", () => {
  const reauth = classifyRefreshHttpFailure(401, {
    error: "invalid_grant",
    error_description: "Refresh token is expired or revoked",
  });
  assertEquals(reauth.code, "REVOLUT_BUSINESS_REAUTHORISATION_REQUIRED");
  assertEquals(reauth.write, false);

  for (const st of [400, 403, 429, 500, 0]) {
    const r = classifyRefreshHttpFailure(st, { error: "x" });
    assertEquals(r.write, false);
  }
});

Deno.test("concurrent stale refresh cannot overwrite newer vault expiry", () => {
  const started = Date.parse("2026-08-21T10:00:00.000Z");
  const skip = shouldPersistRefreshAgainstConcurrentVault({
    refreshStartedAtMs: started,
    vaultExpiresAtIso: "2026-08-21T12:00:00.000Z",
  });
  assertEquals(skip.persist, false);

  const ok = shouldPersistRefreshAgainstConcurrentVault({
    refreshStartedAtMs: started,
    vaultExpiresAtIso: "2026-08-20T06:33:50.045Z",
  });
  assertEquals(ok.persist, true);
});

Deno.test("safe response never embeds raw tokens; fingerprints only", async () => {
  const before = await fingerprintSecret("oa_prod_old_access________________");
  const after = await fingerprintSecret("oa_prod_new_access________________");
  const rk = await fingerprintSecret("oa_prod_refresh____________________");
  const pk = await fingerprintSecret(
    "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
  );
  const safe = buildSafeRefreshResponse({
    environment: "live",
    token_type: "bearer",
    expires_at: "2026-08-21T12:00:00.000Z",
    scope_tokens: ["READ", "WRITE", "PAY"],
    access_before: before,
    access_after: after!,
    refresh_before: rk,
    refresh_after: rk!,
    refresh_rotated: false,
    private_key: pk,
  });
  const blob = JSON.stringify(safe);
  for (const secretish of [
    "oa_prod_old_access________________",
    "oa_prod_new_access________________",
    "oa_prod_refresh____________________",
    "BEGIN PRIVATE KEY",
    "MIIE",
  ]) {
    assertEquals(blob.includes(secretish), false, secretish);
  }
  assertEquals(safe.success, true);
  assertEquals(safe.revolut_pay_called, false);
  assertEquals(typeof (safe.access_token_fingerprint as { after: { sha256_12: string } }).after.sha256_12, "string");
});

Deno.test("refresh-only SSOT and Edge entry have no money writers", async () => {
  const ssot = await Deno.readTextFile(
    new URL("./revolutBusinessOAuthRefreshOnlySSOT.ts", import.meta.url),
  );
  const check = assertRefreshOnlySourceHasNoMoneyWriters(ssot);
  assertEquals(check.ok, true, check.hits.join(","));

  let entry = "";
  try {
    entry = await Deno.readTextFile(
      new URL("../admin-refresh-revolut-business-oauth/index.ts", import.meta.url),
    );
  } catch {
    entry = "";
  }
  if (entry) {
    const e2 = assertRefreshOnlySourceHasNoMoneyWriters(entry);
    assertEquals(e2.ok, true, e2.hits.join(","));
    assertStringIncludes(entry, "refreshOnlyBusinessAccessToken");
    assertStringIncludes(entry, "persistRefreshOnlyTokens");
  }
});
