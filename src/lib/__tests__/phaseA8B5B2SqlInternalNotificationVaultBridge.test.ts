/**
 * Lock: Phase A8B5B2-SQL Vault internal notification header bridge draft.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../..");
const CANONICAL =
  "supabase/migrations/20261109170000_phase_a8b5b2_sql_internal_notification_vault_bridge.sql";
const ROLLBACK =
  "supabase/migrations/rollback/rollback_20261109170000_phase_a8b5b2_sql_internal_notification_vault_bridge.sql";

const CALLERS = [
  "notify_driver_lost_property",
  "notify_driver_on_trip_cancelled",
  "notify_driver_trip_change_request",
  "notify_drivers_trip_cancelled",
  "notify_offer_drivers_on_trip_terminal",
  "ride_offer_dispatch_push_delivery",
  "tg_driver_alerts_push_on_raise",
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("phaseA8B5B2SqlInternalNotificationVaultBridge", () => {
  it("drafts Vault header helper + auth-only SQL caller rewrites without secrets", () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);

    expect(sql).toMatch(/NOT APPLIED/i);
    expect(sql).toMatch(/extension supabase_vault is unavailable/i);
    expect(sql).toMatch(/vault\.decrypted_secrets is unavailable/i);
    expect(sql).toMatch(/onecab_internal_notification_token/);
    expect(sql).toMatch(/DO \$resolve\$/);
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.onecab_internal_notification_http_headers\(\)/i,
    );
    expect(sql).toMatch(/SET search_path = pg_catalog, vault/i);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.onecab_internal_notification_http_headers\(\) FROM service_role/i,
    );

    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    expect(sql).not.toMatch(/Authorization/i);
    expect(sql).not.toMatch(/\bBearer\b/);
    expect(sql).not.toMatch(/cron_edge_auth_token\s*\(/i);

    for (const name of CALLERS) {
      expect(sql).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}`, "i"));
      expect(rb).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}`, "i"));
    }
    expect(sql).toMatch(/headers := public\.onecab_internal_notification_http_headers\(\)/);
    expect(rb).toMatch(/headers := public\.onecab_internal_notification_http_headers\(\)/);

    expect(rb).toMatch(/Level A — Edge rollback/i);
    expect(rb).toMatch(/Level B — Full database rollback/i);
    expect(rb).toMatch(/KEEP public\.onecab_internal_notification_http_headers/i);
    expect(rb).not.toMatch(/cron_edge_auth_token\s*\(/i);
    expect(rb).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    expect(rb).not.toMatch(/\bBearer\b/);
    expect(rb).not.toMatch(/DROP FUNCTION/i);
    expect(rb).toMatch(
      /CREATE OR REPLACE FUNCTION public\.onecab_internal_notification_http_headers\(\)/i,
    );
  });
});
