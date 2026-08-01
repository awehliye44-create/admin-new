/**
 * Server-side trusted face-reference resolver.
 * Never returns signed URLs or private paths to the mobile client.
 *
 * Candidate order (both still gated for provenance/quality):
 * 1. drivers.profile_photo_url → private driver-documents object only
 * 2. Approved documents row document_type = profile_photo
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { IdentityReferenceResolution } from "./types.ts";

const ALLOWED_CONTENT = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

function parseStoragePath(urlOrPath: string): string | null {
  const raw = urlOrPath.trim();
  if (!raw) return null;
  if (!raw.includes("://")) {
    return raw.replace(/^\/+/, "");
  }
  try {
    const u = new URL(raw);
    const marker = "/object/";
    const idx = u.pathname.indexOf(marker);
    if (idx >= 0) {
      const rest = u.pathname.slice(idx + marker.length);
      const parts = rest.split("/").filter(Boolean);
      if (parts.length >= 3) {
        return parts.slice(2).join("/");
      }
    }
    // Public CDN / arbitrary http(s) URLs are not trusted enrolment references.
    if (u.protocol === "http:" || u.protocol === "https:") {
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function guessContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function pathOwnedByDriver(
  path: string,
  input: { driverId: string; userId: string },
): boolean {
  if (path.startsWith(`${input.userId}/`) || path.includes(`/${input.userId}/`)) {
    return true;
  }
  if (path.includes(input.driverId)) return true;
  return false;
}

function evaluatePath(
  path: string | null,
  input: { driverId: string; userId: string },
):
  | { ok: true; path: string; contentType: string }
  | { ok: false; reason: Extract<IdentityReferenceResolution, { status: "unavailable" }>["reason"] } {
  if (!path) return { ok: false, reason: "untrusted_source" };
  if (!pathOwnedByDriver(path, input)) {
    return { ok: false, reason: "untrusted_source" };
  }
  const contentType = guessContentType(path);
  if (!ALLOWED_CONTENT.has(contentType)) {
    return { ok: false, reason: "unsupported_format" };
  }
  return { ok: true, path, contentType };
}

export async function resolveTrustedIdentityReference(
  supabase: SupabaseClient,
  input: { driverId: string; userId: string },
): Promise<IdentityReferenceResolution> {
  // 1) drivers.profile_photo_url — only if private object path with ownership.
  const { data: driver } = await supabase
    .from("drivers")
    .select("profile_photo_url")
    .eq("id", input.driverId)
    .maybeSingle();

  const profileUrl = typeof driver?.profile_photo_url === "string"
    ? driver.profile_photo_url.trim()
    : "";

  if (profileUrl) {
    const evaluated = evaluatePath(parseStoragePath(profileUrl), input);
    if (evaluated.ok) {
      // Column URL alone has weak provenance — require matching approved document
      // for the same object path before treating as biometric enrolment reference.
      const { data: matchingDocs } = await supabase
        .from("documents")
        .select("id, status, file_url, reviewed_at, updated_at, created_at")
        .eq("driver_id", input.driverId)
        .eq("document_type", "profile_photo")
        .order("updated_at", { ascending: false })
        .limit(5);

      const approvedMatch = (matchingDocs ?? []).find((d) => {
        if (String(d.status || "").toLowerCase() !== "approved") return false;
        const docPath = parseStoragePath(String(d.file_url || ""));
        return docPath === evaluated.path;
      });

      if (!approvedMatch) {
        // URL present but not backed by approved compliance photo → not trusted.
        // Fall through to approved document candidate.
      } else {
        const approvedAt = String(
          approvedMatch.reviewed_at ||
            approvedMatch.updated_at ||
            approvedMatch.created_at ||
            "",
        );
        if (!approvedAt) {
          return { status: "unavailable", reason: "consent_or_provenance_missing" };
        }
        return {
          status: "available",
          source: "driver_profile_photo",
          privateObjectPath: evaluated.path,
          contentType: evaluated.contentType,
          approvedAt,
        };
      }
    } else if (evaluated.reason === "unsupported_format") {
      return { status: "unavailable", reason: "unsupported_format" };
    }
  }

  // 2) Approved private profile_photo document.
  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .select("id, status, file_url, document_type, reviewed_at, updated_at, created_at")
    .eq("driver_id", input.driverId)
    .eq("document_type", "profile_photo")
    .order("updated_at", { ascending: false })
    .limit(5);

  if (!docErr && Array.isArray(doc) && doc.length > 0) {
    const approved = doc.find((d) =>
      String(d.status || "").toLowerCase() === "approved" &&
      typeof d.file_url === "string" &&
      d.file_url.trim()
    );
    if (!approved) {
      return { status: "unavailable", reason: "not_approved" };
    }
    const evaluated = evaluatePath(parseStoragePath(String(approved.file_url)), input);
    if (!evaluated.ok) {
      return { status: "unavailable", reason: evaluated.reason };
    }
    const approvedAt = String(
      approved.reviewed_at || approved.updated_at || approved.created_at || "",
    );
    if (!approvedAt) {
      return { status: "unavailable", reason: "consent_or_provenance_missing" };
    }
    return {
      status: "available",
      source: "approved_profile_photo_document",
      privateObjectPath: evaluated.path,
      contentType: evaluated.contentType,
      approvedAt,
    };
  }

  return { status: "unavailable", reason: "missing" };
}

export async function downloadDriverDocumentBytes(
  supabase: SupabaseClient,
  privateObjectPath: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const { data, error } = await supabase.storage
    .from("driver-documents")
    .download(privateObjectPath);
  if (error || !data) return null;
  const buf = new Uint8Array(await data.arrayBuffer());
  if (buf.byteLength < 1024) return null;
  if (buf.byteLength > 8_000_000) return null;
  return { bytes: buf, contentType: guessContentType(privateObjectPath) };
}
