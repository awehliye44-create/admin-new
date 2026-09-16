/**
 * Service-side database adapter for the ONECAB Assistant.
 * Uses the service role only — the browser has no access to these tables.
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { AssistantConfig, AssistantDb, EventRow, Platform } from "./handler.ts";

export function createAssistantDb(url: string, serviceRoleKey: string): AssistantDb {
  const admin: SupabaseClient = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

  return {
    async loadConfig(platform: Platform) {
      const { data, error } = await admin
        .from("onecab_assistant_config")
        .select(
          "enabled, model, monthly_budget_usd, monthly_warning_usd, max_questions_per_session, max_questions_per_ip_hour, max_input_characters, max_output_tokens, max_output_words, request_timeout_ms",
        )
        .eq("platform", platform)
        .maybeSingle();
      if (error) throw new Error("config_unavailable");
      return (data ?? null) as Partial<AssistantConfig> | null;
    },

    async consumeQuota(args) {
      const { data, error } = await admin.rpc("onecab_assistant_consume_quota", {
        p_session_ref: args.sessionHash,
        p_ip_hash: args.ipHash,
        p_platform: args.platform,
        p_session_limit: args.sessionLimit,
        p_ip_hour_limit: args.ipHourLimit,
        p_identity_ref: args.identityHash ?? null,
        p_identity_limit: args.identityLimit ?? null,
        p_device_ref: args.deviceHash ?? null,
        p_device_limit: args.deviceLimit ?? null,
      });
      if (error) throw new Error("quota_unavailable");
      const row = Array.isArray(data) ? data[0] : data;
      return {
        allowed: Boolean(row?.allowed),
        reason: (row?.reason ?? null) as "session" | "ip" | null,
      };
    },

    async logEvent(row: EventRow) {
      await admin.from("onecab_assistant_events").insert(row);
    },

    async usage(platform: Platform) {
      const { data, error } = await admin.rpc("onecab_assistant_usage_for_platform", {
        p_platform: platform,
      });
      if (error) throw new Error("usage_unavailable");
      const row = Array.isArray(data) ? data[0] : data;
      return {
        day_usd: Number(row?.day_usd ?? 0),
        month_usd: Number(row?.month_usd ?? 0),
      };
    },
  };
}
