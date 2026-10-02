/**
 * AES-GCM encryption for company payee bank identifiers.
 * Shared crypto — works in Deno edges and Vitest (Web Crypto).
 * Ciphertext only stored; never return plaintext to frontend.
 */

const ENCRYPTION_KEY_ENV = "PAYOUT_DESTINATION_ENCRYPTION_KEY";

function readEncryptionSeed(): string {
  try {
    const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } }; process?: { env?: Record<string, string | undefined> } };
    const fromDeno = g.Deno?.env.get(ENCRYPTION_KEY_ENV)?.trim();
    if (fromDeno && fromDeno.length >= 32) return fromDeno;
    const fromProcess = g.process?.env?.[ENCRYPTION_KEY_ENV]?.trim();
    if (fromProcess && fromProcess.length >= 32) return fromProcess;
  } catch {
    /* ignore */
  }
  return "onecab-company-payee-default-key-v1-do-not-use-in-prod-without-env";
}

async function deriveKeyBytes(): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(readEncryptionSeed()));
  return new Uint8Array(digest);
}

async function importAesKey(): Promise<CryptoKey> {
  const keyBytes = await deriveKeyBytes();
  return crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function bytesToB64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    return btoa(String.fromCharCode(...bytes));
  }
  // Node/Vitest fallback
  return Buffer.from(bytes).toString("base64");
}

function b64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64") as unknown as ArrayLike<number>);
}

export async function encryptCompanyPayeeSecret(plaintext: string): Promise<string> {
  const key = await importAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext.trim());
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return bytesToB64(combined);
}

export async function decryptCompanyPayeeSecret(ciphertextB64: string): Promise<string> {
  const key = await importAesKey();
  const combined = b64ToBytes(ciphertextB64);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(plain);
}

declare const Buffer: { from(data: Uint8Array | string, enc?: string): { toString(enc: string): string } };
