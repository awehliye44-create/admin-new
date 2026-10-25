/**
 * Admin lock: account deletion requests.
 *
 * - At most one pending (open/waiting) account_deletion request per customer
 *   profile and per driver profile, enforced by partial unique indexes.
 * - Admin completes the deletion: admin-delete-account resolves the pending
 *   request and revokes every session for the user.
 * - Session revocation is service-role only.
 * - A signed-in user may cancel only their own pending request; cancelling
 *   closes the ticket and never deactivates, deletes or signs out the account.
 *
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));

const migration = read("migrations/20261209120000_account_deletion_request_dedupe.sql");
const customerMinimise = read("migrations/20261209130000_customer_deletion_minimise.sql");
const cancelRequest = read("migrations/20261209140000_account_deletion_request_cancel.sql");
const adminDelete = read("functions/admin-delete-account/index.ts");

Deno.test("one pending account_deletion request per customer and per driver", () => {
  for (const column of ["customer_id", "driver_id"]) {
    assertMatch(
      migration,
      new RegExp(
        `CREATE UNIQUE INDEX[^;]*ON public\\.support_conversations \\(${column}\\)\\s*` +
          `WHERE category = 'account_deletion'\\s*AND status IN \\('open', 'waiting'\\)\\s*` +
          `AND ${column} IS NOT NULL;`,
      ),
    );
  }
});

Deno.test("session revocation is service-role only and deletes auth.sessions", () => {
  assertMatch(migration, /FUNCTION public\.admin_revoke_user_sessions\(p_user_id uuid\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = ''/);
  assertMatch(migration, /DELETE FROM auth\.sessions WHERE user_id = p_user_id;/);
  assertMatch(migration, /REVOKE ALL ON FUNCTION public\.admin_revoke_user_sessions\(uuid\) FROM PUBLIC;/);
  assertMatch(migration, /REVOKE ALL ON FUNCTION public\.admin_revoke_user_sessions\(uuid\) FROM anon, authenticated;/);
  assertMatch(migration, /GRANT EXECUTE ON FUNCTION public\.admin_revoke_user_sessions\(uuid\) TO service_role;/);
});

Deno.test("admin-delete-account stays admin-only", () => {
  assertMatch(adminDelete, /\.eq\('role', 'admin'\)/);
  assertMatch(adminDelete, /Forbidden: admin role required/);
});

Deno.test("admin-delete-account resolves the pending request it completes", () => {
  assertMatch(adminDelete, /const PENDING_DELETION_STATUSES = \['open', 'waiting'\];/);
  const lookup = adminDelete.indexOf(".eq('category', 'account_deletion')");
  const profileDelete = adminDelete.indexOf("// 5. Remove the role profile.");
  assert(lookup > 0 && profileDelete > lookup, "pending requests must be read before the profile is removed");
  assertMatch(adminDelete, /\.update\(\{ status: 'resolved', resolved_at: /);
});

Deno.test("admin-delete-account signs the user out everywhere", () => {
  assertMatch(adminDelete, /admin\.auth\.admin\.deleteUser\(targetUserId\)/);
  assertMatch(adminDelete, /admin\.rpc\('admin_revoke_user_sessions', \{\s*p_user_id: targetUserId,/);
  assertMatch(adminDelete, /let sessionsRevoked = authUserDeleted;/);
});

Deno.test("admin-delete-account keeps the driver soft delete that retains payout history", () => {
  assertMatch(adminDelete, /driver_status: 'deleted'/);
  assert(!/from\('drivers'\)\s*\.delete\(\)/.test(adminDelete), "drivers must never be hard-deleted");
});

Deno.test("customers are minimised and detached, never hard-deleted", () => {
  assert(!/\.delete\(\)/.test(adminDelete), "admin-delete-account must not hard-delete any profile");
  assertMatch(adminDelete, /admin\.rpc\('admin_minimise_deleted_customer', \{\s*p_customer_id: profile_id,/);
  assertMatch(customerMinimise, /ALTER TABLE public\.customers ALTER COLUMN user_id DROP NOT NULL;/);
  assertMatch(customerMinimise, /SET rider_status = 'deleted',[\s\S]*user_id = NULL,[\s\S]*phone = NULL,/);
  assertMatch(customerMinimise, /GRANT EXECUTE ON FUNCTION public\.admin_minimise_deleted_customer\(uuid\) TO service_role;/);
  assertMatch(customerMinimise, /REVOKE ALL ON FUNCTION public\.admin_minimise_deleted_customer\(uuid\) FROM anon, authenticated;/);
  // The detach must happen before the Auth delete so customers_user_id_fkey cannot cascade.
  const minimise = adminDelete.indexOf("admin_minimise_deleted_customer");
  const authDelete = adminDelete.indexOf("admin.auth.admin.deleteUser(targetUserId)");
  assert(minimise > 0 && authDelete > minimise, "customer must be detached before the Auth user is deleted");
});

Deno.test("users can cancel only their own pending request, and nothing else changes", () => {
  assertMatch(cancelRequest, /FUNCTION public\.cancel_account_deletion_request\(p_app text\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = ''/);
  assertMatch(cancelRequest, /v_user_id uuid := auth\.uid\(\);/);
  assertMatch(cancelRequest, /WHERE c\.user_id = v_user_id\s*AND c\.deleted_at IS NULL\s*AND c\.rider_status <> 'deleted'/);
  assertMatch(cancelRequest, /WHERE d\.user_id = v_user_id\s*AND d\.deleted_at IS NULL/);
  assertMatch(cancelRequest, /RAISE EXCEPTION 'account_deletion_not_cancellable'/);
  assertMatch(cancelRequest, /AND sc\.status IN \('open', 'waiting'\)/);
  assertMatch(cancelRequest, /SET status = 'closed',[\s\S]*'cancelled_by_user'/);
  assertMatch(cancelRequest, /'cancellation_reason', 'cancelled_by_user'/);
  assertMatch(cancelRequest, /INSERT INTO public\.support_messages/);
  assertMatch(cancelRequest, /REVOKE ALL ON FUNCTION public\.cancel_account_deletion_request\(text\) FROM anon;/);
  assertMatch(cancelRequest, /GRANT EXECUTE ON FUNCTION public\.cancel_account_deletion_request\(text\) TO authenticated;/);
  // Cancelling must never touch the account itself or its sessions.
  for (const forbidden of [/UPDATE public\.customers/, /UPDATE public\.drivers/, /auth\.sessions/, /auth\.users/, /DELETE FROM/]) {
    assert(!forbidden.test(cancelRequest), `cancel must not match ${forbidden}`);
  }
});
