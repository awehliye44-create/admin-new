/**
 * Static audit of the pending central-backend migration and of the shipped
 * assistant code: RLS, grants, cleanup and "no AI gateway / no key in bundle".
 */
// @ts-expect-error node types are not in the app tsconfig
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260816130000_onecab_assistant.sql",
  "utf8",
);
const handler = readFileSync("supabase/functions/onecab-assistant/handler.ts", "utf8");

const TABLES = [
  "public.onecab_assistant_config",
  "public.onecab_assistant_events",
  "public.onecab_assistant_rate_limits",
];

describe("migration: RLS and grants", () => {
  it("enables RLS on every assistant table", () => {
    for (const table of TABLES) {
      expect(sql).toContain(`alter table ${table} enable row level security`);
    }
  });

  it("revokes browser roles and grants only service_role", () => {
    for (const table of TABLES) {
      expect(sql).toContain(`revoke all on ${table} from anon, authenticated`);
      expect(sql).toContain(`grant all on ${table} to service_role`);
    }
    expect(sql).not.toMatch(/grant[^\n]*to (anon|authenticated)/i);
  });

  it("creates no policy that would expose config, usage or security data", () => {
    expect(sql).not.toMatch(/create policy/i);
  });

  it("restricts every function to service_role", () => {
    for (const fn of ["onecab_assistant_consume_quota", "onecab_assistant_usage", "onecab_assistant_cleanup"]) {
      expect(sql).toContain(`grant execute on function public.${fn}`);
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}[^;]*from public, anon, authenticated`));
      expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${fn}[^;]*to (anon|authenticated)`));
    }
  });
});

describe("migration: retention and cleanup", () => {
  it("expires rate-limit rows and purges old operational metadata", () => {
    expect(sql).toContain("delete from public.onecab_assistant_rate_limits where expires_at < now()");
    expect(sql).toContain("delete from public.onecab_assistant_events where created_at < now() - interval '90 days'");
    expect(sql).toContain("onecab_assistant_rate_limits_expiry_idx");
  });

  it("stores no message content columns", () => {
    const eventsBlock = sql.split("onecab_assistant_events (")[1].split(");")[0];
    expect(eventsBlock).not.toMatch(/message|question|reply|answer|prompt|ip_address/i);
    expect(eventsBlock).toContain("ip_hash");
  });

  it("locks the model and validates numeric config in the database too", () => {
    expect(sql).toContain("check (model in ('gpt-5.6-luna'))");
    expect(sql).toContain("check (monthly_budget_usd > 0)");
  });
});

describe("no AI gateway, no keys in the browser", () => {
  it("the server calls OpenAI directly", () => {
    expect(handler).toContain("https://api.openai.com/v1/responses");
    expect(handler).not.toContain("gateway.lovable.dev");
    expect(handler).not.toContain("LOVABLE_API_KEY");
    expect(handler).toContain('"gpt-5.6-luna"');
    expect(handler).not.toContain("openai/gpt-5.6-luna");
  });

});

describe("migration: scheduled cleanup", () => {
  it("schedules the cleanup job hourly via pg_cron", () => {
    expect(sql).toContain("create extension if not exists pg_cron");
    expect(sql).toContain("'onecab-assistant-cleanup'");
    expect(sql).toContain("'17 * * * *'");
    expect(sql).toContain("select public.onecab_assistant_cleanup()");
  });

  it("is idempotent — reapplying cannot create a duplicate job", () => {
    expect(sql).toMatch(/cron\.unschedule\(jobid\)[\s\S]*where jobname = 'onecab-assistant-cleanup'/);
    const scheduleCalls = sql.match(/cron\.schedule\(/g) ?? [];
    expect(scheduleCalls).toHaveLength(1);
  });

  it("falls back with a clear notice when pg_cron is unavailable", () => {
    expect(sql).toContain("pg_cron unavailable");
    expect(sql).toContain("where extname = 'pg_cron'");
  });
});
