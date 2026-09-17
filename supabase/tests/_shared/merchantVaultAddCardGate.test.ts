/**
 * Pure unit tests for merchant-vault Add Card fail-closed gate.
 * Run: deno test --allow-read supabase/tests/_shared/merchantVaultAddCardGate.test.ts
 */
import {
  parseMerchantVaultAddCardAllowlist,
  parseMerchantVaultAddCardGateMode,
  resolveMerchantVaultAddCardAllowed,
} from "../../functions/_shared/merchantVaultAddCardGate.ts";

Deno.test("unset / unknown gate mode → off (fail closed)", () => {
  if (parseMerchantVaultAddCardGateMode(undefined) !== "off") {
    throw new Error("undefined must be off");
  }
  if (parseMerchantVaultAddCardGateMode("") !== "off") {
    throw new Error("empty must be off");
  }
  if (parseMerchantVaultAddCardGateMode("true") !== "off") {
    throw new Error("true must not enable — use on|allowlist|off");
  }
});

Deno.test("allowlist hit / miss / on / off", () => {
  const allow = parseMerchantVaultAddCardAllowlist("aaa, bbb");
  const hit = resolveMerchantVaultAddCardAllowed({
    gateMode: "allowlist",
    allowlistUserIds: allow,
    authUserId: "aaa",
  });
  if (!hit.allowed || hit.reason !== "allowlist_hit") {
    throw new Error("allowlist hit failed");
  }
  const miss = resolveMerchantVaultAddCardAllowed({
    gateMode: "allowlist",
    allowlistUserIds: allow,
    authUserId: "zzz",
  });
  if (miss.allowed || miss.reason !== "allowlist_miss") {
    throw new Error("allowlist miss failed");
  }
  const off = resolveMerchantVaultAddCardAllowed({
    gateMode: "off",
    allowlistUserIds: allow,
    authUserId: "aaa",
  });
  if (off.allowed) throw new Error("off must deny even allowlisted");
  const on = resolveMerchantVaultAddCardAllowed({
    gateMode: "on",
    allowlistUserIds: new Set(),
    authUserId: "anyone",
  });
  if (!on.allowed) throw new Error("on must allow");
});
