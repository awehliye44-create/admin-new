/**
 * Veriff Selfie2Selfie adapter — all Veriff shapes stay here.
 */

import { mapProviderDecisionPayload } from "./mapDecision.ts";
import type {
  CreateIdentitySessionInput,
  CreateIdentitySessionResult,
  DriverIdentityProvider,
  OnecabIdentityDecision,
  ProviderDecisionPayload,
  ProviderIdentityDecision,
  RawWebhookInput,
  VerifiedProviderWebhookEvent,
} from "./types.ts";

function requireEnv(name: string): string {
  const v = Deno.env.get(name)?.trim();
  if (!v) throw new Error(`missing_env:${name}`);
  return v;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return toHex(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

export class VeriffDriverIdentityProvider implements DriverIdentityProvider {
  private apiBase(): string {
    // Dedicated Selfie2Selfie integration base URL (configured by Veriff SE).
    return (
      Deno.env.get("VERIFF_SELFIE2SELFIE_BASE_URL")?.trim() ||
      Deno.env.get("VERIFF_API_BASE_URL")?.trim() ||
      "https://stationapi.veriff.com"
    ).replace(/\/$/, "");
  }

  private apiKey(): string {
    return requireEnv("VERIFF_API_KEY");
  }

  private sharedSecret(): string {
    return requireEnv("VERIFF_SHARED_SECRET");
  }

  mapDecision(input: ProviderDecisionPayload): OnecabIdentityDecision {
    return mapProviderDecisionPayload(input);
  }

  async createSession(
    input: CreateIdentitySessionInput,
  ): Promise<CreateIdentitySessionResult> {
    const base = this.apiBase();
    const apiKey = this.apiKey();
    const secret = this.sharedSecret();

    const createBody = JSON.stringify({
      verification: {
        person: {
          firstName: input.firstName ?? undefined,
          lastName: input.lastName ?? undefined,
        },
        vendorData: input.vendorData,
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      },
      endUserId: input.endUserId,
    });

    const createSig = await hmacHex(secret, createBody);
    const createResp = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AUTH-CLIENT": apiKey,
        "X-HMAC-SIGNATURE": createSig,
      },
      body: createBody,
    });
    const createJson = await createResp.json().catch(() => ({}));
    if (!createResp.ok) {
      throw new Error(`veriff_session_create_failed:${createResp.status}`);
    }

    const verification = (createJson as { verification?: Record<string, unknown> })
      .verification ?? {};
    const sessionId = String(verification.id || "");
    const sessionUrl = String(verification.url || "");
    if (!sessionId || !sessionUrl) {
      throw new Error("veriff_session_create_invalid_response");
    }

    const mime = input.referenceContentType || "image/jpeg";
    const b64 = bytesToBase64(input.referenceImageBytes);
    const mediaBody = JSON.stringify({
      image: {
        context: "face-reference",
        content: `data:${mime};base64,${b64}`,
        timestamp: new Date().toISOString(),
      },
    });
    const mediaSig = await hmacHex(secret, mediaBody);
    const mediaResp = await fetch(`${base}/v1/sessions/${sessionId}/media`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AUTH-CLIENT": apiKey,
        "X-HMAC-SIGNATURE": mediaSig,
      },
      body: mediaBody,
    });
    if (!mediaResp.ok) {
      throw new Error(`veriff_face_reference_upload_failed:${mediaResp.status}`);
    }

    return {
      provider: "veriff",
      providerSessionId: sessionId,
      sessionUrl,
      expiresAt: null,
    };
  }

  async getDecision(providerSessionId: string): Promise<ProviderIdentityDecision> {
    const base = this.apiBase();
    const apiKey = this.apiKey();
    const secret = this.sharedSecret();
    const path = `/v1/sessions/${providerSessionId}/decision`;
    const sig = await hmacHex(secret, path);
    const resp = await fetch(`${base}${path}`, {
      method: "GET",
      headers: {
        "X-AUTH-CLIENT": apiKey,
        "X-HMAC-SIGNATURE": sig,
      },
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(`veriff_decision_fetch_failed:${resp.status}`);
    }

    const verification = (json as { verification?: Record<string, unknown> })
      .verification ?? json as Record<string, unknown>;
    const status = String(verification.status || verification.decision || "");
    const decision = this.mapDecision({
      status,
      code: status,
      providerSessionId: providerSessionId,
      faceMatchResult: typeof verification.faceMatch === "string"
        ? verification.faceMatch
        : null,
    });

    return {
      providerSessionId,
      decision,
      rawDecisionCode: status,
      faceMatchResult: typeof verification.faceMatch === "string"
        ? verification.faceMatch
        : null,
      decidedAt: typeof verification.decisionTime === "string"
        ? verification.decisionTime
        : null,
    };
  }

  async verifyWebhook(
    input: RawWebhookInput,
  ): Promise<VerifiedProviderWebhookEvent> {
    const secret = this.sharedSecret();
    const signature = (
      input.headers.get("x-hmac-signature") ||
      input.headers.get("X-HMAC-SIGNATURE") ||
      ""
    ).trim().toLowerCase();
    if (!signature) {
      throw new Error("veriff_webhook_missing_signature");
    }
    const expected = (await hmacHex(secret, input.rawBody)).toLowerCase();
    if (!timingSafeEqual(signature, expected)) {
      throw new Error("veriff_webhook_invalid_signature");
    }

    const payload = JSON.parse(input.rawBody) as Record<string, unknown>;
    const verification = (payload.verification ?? payload) as Record<
      string,
      unknown
    >;
    const providerSessionId = String(verification.id || payload.id || "");
    if (!providerSessionId) {
      throw new Error("veriff_webhook_missing_session");
    }

    const status = String(verification.status || "").toLowerCase();
    const providerEventId = String(
      payload.id ||
        verification.id && status
        ? `${providerSessionId}:${status}:${verification.decisionTime || ""}`
        : providerSessionId,
    );

    // Event / progress webhooks (started, submitted) — never approve.
    if (status === "started") {
      return {
        providerEventId,
        providerSessionId,
        kind: "progress",
        progressStatus: "started",
      };
    }
    if (status === "submitted") {
      return {
        providerEventId,
        providerSessionId,
        kind: "progress",
        progressStatus: "submitted",
      };
    }

    // Decision webhook statuses.
    const decision = this.mapDecision({
      status,
      code: status,
      providerSessionId,
      faceMatchResult: typeof (verification as { faceMatch?: string }).faceMatch ===
          "string"
        ? (verification as { faceMatch: string }).faceMatch
        : null,
    });

    return {
      providerEventId,
      providerSessionId,
      kind: "decision",
      decision: {
        providerSessionId,
        decision,
        rawDecisionCode: status,
        faceMatchResult: typeof (verification as { faceMatch?: string }).faceMatch ===
            "string"
          ? (verification as { faceMatch: string }).faceMatch
          : null,
        decidedAt: typeof verification.decisionTime === "string"
          ? verification.decisionTime
          : new Date().toISOString(),
      },
    };
  }
}

export function createDriverIdentityProvider(
  providerName: string,
): DriverIdentityProvider {
  const name = providerName.toLowerCase().trim();
  if (name === "veriff") return new VeriffDriverIdentityProvider();
  throw new Error(`unsupported_identity_provider:${providerName}`);
}
