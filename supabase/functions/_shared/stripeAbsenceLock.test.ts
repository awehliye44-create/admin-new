/**
 * Lock: live Edge/shared code must not reintroduce Stripe runtime, secrets, or SDK.
 * Forbidden strings may appear only in this file (FORBIDDEN list) and intentional
 * absence assertions inside *Lock.test.ts / *AbsenceLock.test.ts files.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { walkSync } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const FORBIDDEN = [
  "stripe_payment_intent_id",
  "stripe_account_id",
  "stripe_refund_id",
  "stripe_transfer_id",
  "stripe_payout_id",
  "processed_stripe_events",
  "STRIPE_SECRET_KEY",
  "api.stripe.com",
  "connect.stripe",
  "npm:stripe",
  "new Stripe",
  "assertStripeMutationAllowed",
  "stripeRuntimeDisabled",
  "stripeRetirementGuard",
  "stripePreauthCustomerError",
] as const;

const FORBIDDEN_REGEX = [
  /new\s+Stripe\b/,
] as const;

/** admin-new repo root (…/supabase/functions/_shared → ../../..) */
const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));
const SCAN_ROOTS = [
  join(REPO_ROOT, "supabase", "functions"),
  join(REPO_ROOT, "shared"),
  join(REPO_ROOT, "src"),
];

function isExcluded(path: string): boolean {
  const norm = path.replaceAll("\\", "/");
  if (norm.includes("/migrations/")) return true;
  if (norm.endsWith(".md")) return true;
  if (norm.includes("/.tmp/")) return true;
  if (norm.includes("/node_modules/")) return true;
  if (norm.includes("/dist/")) return true;
  // This lock and other lock tests may mention forbidden strings as assertions.
  if (norm.endsWith("Lock.test.ts") || norm.endsWith("AbsenceLock.test.ts")) return true;
  return false;
}

Deno.test("stripe absence lock — no live Stripe secrets/SDK/theater columns", () => {
  const hits: string[] = [];

  for (const root of SCAN_ROOTS) {
    for (const entry of walkSync(root, { exts: [".ts", ".tsx"], includeDirs: false })) {
      if (isExcluded(entry.path)) continue;
      const text = Deno.readTextFileSync(entry.path);
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) {
          hits.push(`${entry.path}: contains ${needle}`);
        }
      }
      for (const re of FORBIDDEN_REGEX) {
        if (re.test(text)) {
          hits.push(`${entry.path}: matches ${re}`);
        }
      }
    }
  }

  assertEquals(hits, [], hits.join("\n"));
});
