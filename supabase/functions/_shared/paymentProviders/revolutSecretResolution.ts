/**
 * Revolut Merchant credential resolution — vault SSOT with optional edge env backup.
 * Canonical Supabase secrets: REVOLUT_PUBLIC_KEY, REVOLUT_MERCHANT_SECRET_KEY,
 * REVOLUT_WEBHOOK_SECRET, REVOLUT_MERCHANT_ID.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ProviderEnvironment, ProviderSecrets } from "./types.ts";
import { getProviderSecrets } from "./secretManager.ts";
import {
  normalizeRevolutMerchantSecret,
  testRevolutMerchantConnection,
  validateRevolutMerchantSecret,
  type RevolutApiError,
} from "../revolutApi.ts";

export type RevolutSecretCandidate = {
  secret_key: string;
  publishable_key: string | null;
  source: string;
};

function isMaskedOrPlaceholder(value: string): boolean {
  const v = value.trim();
  return !v || v.includes("•") || v.includes("****") || v === "—";
}

function pushCandidate(
  list: RevolutSecretCandidate[],
  secret: string | null | undefined,
  publishable: string | null,
  source: string,
) {
  if (!secret || isMaskedOrPlaceholder(secret)) return;
  const normalized = normalizeRevolutMerchantSecret(secret);
  if (!normalized || list.some((c) => c.secret_key === normalized)) return;
  list.push({ secret_key: normalized, publishable_key: publishable, source });
}

/** Collect every plausible Merchant secret for probing (vault first, then edge env). */
export async function listRevolutMerchantSecretCandidates(
  supabase: SupabaseClient,
  environment: ProviderEnvironment,
): Promise<RevolutSecretCandidate[]> {
  const candidates: RevolutSecretCandidate[] = [];
  const publishableKeys = new Set<string>();

  for (const env of [environment, environment === "live" ? "test" : "live"] as ProviderEnvironment[]) {
    const { data: rows } = await supabase
      .from("payment_provider_vault")
      .select("secret_name, secret_value")
      .eq("provider", "revolut")
      .eq("environment", env);

    const byName = new Map((rows ?? []).map((r) => [r.secret_name, r.secret_value as string]));
    const pub = byName.get("publishable_key")?.trim() || null;
    if (pub && !isMaskedOrPlaceholder(pub)) publishableKeys.add(pub);

    if (env === environment) {
      pushCandidate(
        candidates,
        byName.get("secret_key"),
        pub,
        `vault:${env}:secret_key`,
      );
      if (!byName.get("secret_key") && byName.get("publishable_key")?.trim().startsWith("sk_")) {
        pushCandidate(
          candidates,
          byName.get("publishable_key"),
          null,
          `vault:${env}:publishable_key_as_secret`,
        );
      }
    }
  }

  const secrets = await getProviderSecrets(supabase, "revolut", environment);
  const pub = secrets.publishable_key?.trim() || null;
  if (pub && !isMaskedOrPlaceholder(pub)) publishableKeys.add(pub);
  const sharedPublishable = publishableKeys.values().next().value ?? pub ?? null;

  const envSecretVars = ["REVOLUT_MERCHANT_SECRET_KEY"] as const;
  for (const envVar of envSecretVars) {
    pushCandidate(candidates, Deno.env.get(envVar), sharedPublishable, `env:${envVar}`);
  }

  pushCandidate(candidates, secrets.secret_key, sharedPublishable, `getProviderSecrets:${environment}`);

  for (const env of [environment === "live" ? "test" : "live"] as ProviderEnvironment[]) {
    const { data: rows } = await supabase
      .from("payment_provider_vault")
      .select("secret_name, secret_value")
      .eq("provider", "revolut")
      .eq("environment", env);

    const byName = new Map((rows ?? []).map((r) => [r.secret_name, r.secret_value as string]));
    const otherPub = byName.get("publishable_key")?.trim() || null;
    pushCandidate(
      candidates,
      byName.get("secret_key"),
      otherPub ?? sharedPublishable,
      `vault:${env}:secret_key`,
    );
  }

  return candidates;
}

export type RevolutCredentialProbeResult =
  | {
    ok: true;
    candidate: RevolutSecretCandidate;
    api_version: string;
    endpoint_tested: string;
    warnings: string[];
  }
  | {
    ok: false;
    message: string;
    attempts: Array<{ source: string; message: string; http_status?: number }>;
  };

export async function probeRevolutMerchantCredentials(
  supabase: SupabaseClient,
  environment: ProviderEnvironment,
): Promise<RevolutCredentialProbeResult> {
  const candidates = await listRevolutMerchantSecretCandidates(supabase, environment);
  const warnings: string[] = [];
  const attempts: Array<{ source: string; message: string; http_status?: number }> = [];

  if (candidates.length === 0) {
    return {
      ok: false,
      message: "No Revolut Merchant secret found. Save Production API Secret key (sk_…) under Settings → Payment Providers → Revolut → Edit secrets (Live mode).",
      attempts: [],
    };
  }

  for (const candidate of candidates) {
    const validation = validateRevolutMerchantSecret(
      candidate.secret_key,
      candidate.publishable_key,
    );
    if (!validation.ok) {
      attempts.push({ source: candidate.source, message: validation.message });
      continue;
    }

    if (candidate.source.startsWith("vault:test:") && environment === "live") {
      warnings.push("Using Revolut secret saved under Test mode — re-save secrets in Live mode.");
    }
    if (candidate.source.startsWith("env:")) {
      warnings.push(
        `Connection uses ${candidate.source} because vault secret failed or is missing — click Edit secrets and re-save the Production API Secret key to store it in vault.`,
      );
    }

    try {
      const probe = await testRevolutMerchantConnection(
        environment,
        validation.normalized,
        candidate.publishable_key,
      );
      return {
        ok: true,
        candidate: { ...candidate, secret_key: validation.normalized },
        api_version: probe.api_version,
        endpoint_tested: probe.endpoint_tested,
        warnings,
      };
    } catch (err) {
      const e = err as RevolutApiError;
      attempts.push({
        source: candidate.source,
        message: e.message,
        http_status: e.status || undefined,
      });
    }
  }

  const authFailures = attempts.filter((a) => a.http_status === 401);
  const message = authFailures.length > 0
    ? "All stored Revolut secrets were rejected with HTTP 401. Regenerate Production API Secret key in Revolut Business → Merchant API, paste the new sk_… key in Edit secrets (Live), and test again. Do not paste keys in chat."
    : attempts[0]?.message ?? "Revolut Merchant API authentication failed";

  return { ok: false, message, attempts };
}

/** Persist working secret to vault when probe succeeded from edge env fallback. */
export async function syncRevolutVaultFromProbe(
  supabase: SupabaseClient,
  environment: ProviderEnvironment,
  candidate: RevolutSecretCandidate,
  updatedBy: string,
): Promise<void> {
  if (candidate.source.startsWith("vault:")) return;

  const { upsertProviderSecret } = await import("./secretManager.ts");
  await upsertProviderSecret(supabase, {
    provider: "revolut",
    environment,
    secretName: "secret_key",
    secretValue: candidate.secret_key,
    updatedBy,
  });

  if (candidate.publishable_key && !candidate.publishable_key.startsWith("sk_")) {
    await upsertProviderSecret(supabase, {
      provider: "revolut",
      environment,
      secretName: "publishable_key",
      secretValue: candidate.publishable_key,
      updatedBy,
    });
  }
}

export function revolutSecretFingerprint(secret: string): string {
  const n = normalizeRevolutMerchantSecret(secret);
  return `${n.slice(0, 8)}…${n.slice(-4)} (len ${n.length})`;
}
