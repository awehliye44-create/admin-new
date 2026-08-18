-- ONECAB Assistant — enable authenticated customer_app without changing website
-- or driver_app. Idempotent.
-- Does not alter website or driver_app enabled flags, budgets, or knowledge versions.

alter table public.onecab_assistant_config
  add column if not exists knowledge_version text not null default 'website-v1';

insert into public.onecab_assistant_config (
  platform,
  enabled,
  model,
  monthly_budget_usd,
  monthly_warning_usd,
  max_questions_per_session,
  max_questions_per_ip_hour,
  max_input_characters,
  max_output_tokens,
  max_output_words,
  request_timeout_ms,
  knowledge_version
) values (
  'customer_app',
  true,
  'gpt-5.6-luna',
  25,
  20,
  20,
  40,
  500,
  400,
  150,
  20000,
  'customer-v1'
)
on conflict (platform) do update
  set enabled = true,
      knowledge_version = excluded.knowledge_version,
      max_questions_per_session = excluded.max_questions_per_session,
      max_questions_per_ip_hour = excluded.max_questions_per_ip_hour,
      max_input_characters = excluded.max_input_characters,
      max_output_tokens = excluded.max_output_tokens,
      max_output_words = excluded.max_output_words,
      request_timeout_ms = excluded.request_timeout_ms,
      updated_at = now();

-- Keep corporate disabled. Do not rewrite website or driver_app rows.
insert into public.onecab_assistant_config (platform, enabled, knowledge_version)
values ('corporate_portal', false, 'disabled')
on conflict (platform) do update
  set enabled = false;

revoke all on public.onecab_assistant_config from anon, authenticated;
grant all on public.onecab_assistant_config to service_role;
alter table public.onecab_assistant_config enable row level security;
