/**
 * Unit coverage for trusted face-reference provenance gates.
 * Public/CDN URLs and unapproved profile photos must never become available.
 */

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveTrustedIdentityReference } from "./resolveTrustedReference.ts";

type QueryResult = { data: unknown; error: null };

function makeClient(opts: {
  profilePhotoUrl?: string | null;
  documents?: Array<Record<string, unknown>>;
}) {
  return {
    from(table: string) {
      if (table === "drivers") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async (): Promise<QueryResult> => ({
                data: { profile_photo_url: opts.profilePhotoUrl ?? null },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "documents") {
        const rows = opts.documents ?? [];
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async (): Promise<QueryResult> => ({
                    data: rows,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

Deno.test("public http profile URL is untrusted / falls through to missing", async () => {
  const supabase = makeClient({
    profilePhotoUrl: "https://cdn.example.com/public/face.jpg",
    documents: [],
  });
  const result = await resolveTrustedIdentityReference(supabase as never, {
    driverId: "drv-1",
    userId: "usr-1",
  });
  assertEquals(result.status, "unavailable");
  if (result.status === "unavailable") {
    assertEquals(result.reason, "missing");
  }
});

Deno.test("profile URL without approved matching document is not available", async () => {
  const path = "usr-1/profile_photo/face.jpg";
  const supabase = makeClient({
    profilePhotoUrl: path,
    documents: [
      {
        id: "d1",
        status: "pending",
        file_url: path,
        reviewed_at: null,
        updated_at: "2026-01-01T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
  const result = await resolveTrustedIdentityReference(supabase as never, {
    driverId: "drv-1",
    userId: "usr-1",
  });
  assertEquals(result.status, "unavailable");
  if (result.status === "unavailable") {
    assertEquals(result.reason, "not_approved");
  }
});

Deno.test("approved matching profile_photo document is available", async () => {
  const path = "usr-1/profile_photo/face.jpg";
  const supabase = makeClient({
    profilePhotoUrl: path,
    documents: [
      {
        id: "d1",
        status: "approved",
        file_url: path,
        reviewed_at: "2026-02-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
  const result = await resolveTrustedIdentityReference(supabase as never, {
    driverId: "drv-1",
    userId: "usr-1",
  });
  assertEquals(result, {
    status: "available",
    source: "driver_profile_photo",
    privateObjectPath: path,
    contentType: "image/jpeg",
    approvedAt: "2026-02-01T00:00:00Z",
  });
});
