/**
 * Fail-closed merchant-vault Add Card gate (setup-revolut-card only).
 *
 * Env (Edge secrets / function env — NOT client-supplied):
 *   MERCHANT_VAULT_ADD_CARD_GATE = off | allowlist | on
 *     unset / unknown → off (fail closed)
 *   MERCHANT_VAULT_ADD_CARD_ALLOWLIST_USER_IDS = comma-separated auth user UUIDs
 *     used when gate=allowlist (Ahmed / test customers)
 *
 * Independent of Book / create-preauth / saved-card CIT reuse.
 * Reversible without app downgrade: set GATE=off (or empty allowlist).
 */

export type MerchantVaultAddCardGateMode = "off" | "allowlist" | "on";

export function parseMerchantVaultAddCardGateMode(
  raw: string | null | undefined,
): MerchantVaultAddCardGateMode {
  const mode = String(raw ?? "").trim().toLowerCase();
  if (mode === "on" || mode === "allowlist" || mode === "off") return mode;
  return "off";
}

export function parseMerchantVaultAddCardAllowlist(
  raw: string | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const part of String(raw ?? "").split(",")) {
    const id = part.trim();
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Server decision for JWT auth user id. Never trusts client customer id body fields.
 */
export function resolveMerchantVaultAddCardAllowed(input: {
  gateMode: MerchantVaultAddCardGateMode;
  allowlistUserIds: Set<string>;
  authUserId: string;
}): { allowed: boolean; reason: "on" | "allowlist_hit" | "gate_off" | "allowlist_miss" } {
  const userId = String(input.authUserId ?? "").trim();
  if (!userId) return { allowed: false, reason: "gate_off" };

  if (input.gateMode === "on") return { allowed: true, reason: "on" };
  if (input.gateMode === "off") return { allowed: false, reason: "gate_off" };

  if (input.allowlistUserIds.has(userId)) {
    return { allowed: true, reason: "allowlist_hit" };
  }
  return { allowed: false, reason: "allowlist_miss" };
}

export function readMerchantVaultAddCardGateFromEnv(env: {
  get(key: string): string | undefined;
} = Deno.env): {
  mode: MerchantVaultAddCardGateMode;
  allowlistUserIds: Set<string>;
} {
  return {
    mode: parseMerchantVaultAddCardGateMode(env.get("MERCHANT_VAULT_ADD_CARD_GATE")),
    allowlistUserIds: parseMerchantVaultAddCardAllowlist(
      env.get("MERCHANT_VAULT_ADD_CARD_ALLOWLIST_USER_IDS"),
    ),
  };
}
