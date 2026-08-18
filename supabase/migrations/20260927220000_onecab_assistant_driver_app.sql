-- ONECAB Assistant — enable authenticated driver_app without changing website.
-- Idempotent. Does not enable customer_app or corporate_portal.
-- Does not alter the website config row's enabled flag or budget.

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
  'driver_app',
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
  'driver-v1'
)
on conflict (platform) do update
  set enabled = true,
      knowledge_version = excluded.knowledge_version,
      max_questions_per_session = excluded.max_questions_per_session,
      max_questions_per_ip_hour = excluded.max_questions_per_ip_hour,
      updated_at = now();

-- Keep website knowledge version labelled; do not flip website.enabled.
update public.onecab_assistant_config
  set knowledge_version = coalesce(nullif(knowledge_version, ''), 'website-v1')
  where platform = 'website';

update public.onecab_assistant_config
  set enabled = false
  where platform in ('customer_app', 'corporate_portal');

insert into public.onecab_assistant_config (platform, enabled, knowledge_version)
values
  ('customer_app', false, 'disabled'),
  ('corporate_portal', false, 'disabled')
on conflict (platform) do update
  set enabled = false;

alter table public.onecab_assistant_rate_limits
  drop constraint if exists onecab_assistant_rate_limits_scope_check;

alter table public.onecab_assistant_rate_limits
  add constraint onecab_assistant_rate_limits_scope_check
  check (scope in ('session', 'ip', 'identity', 'device'));

-- Platform-scoped usage so website and driver_app budgets stay separate.
create or replace function public.onecab_assistant_usage_for_platform(p_platform text)
returns table (day_usd numeric, month_usd numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(cost_usd) filter (where created_at >= date_trunc('day', now())), 0),
    coalesce(sum(cost_usd) filter (where created_at >= date_trunc('month', now())), 0)
  from public.onecab_assistant_events
  where platform = p_platform;
$$;

revoke all on function public.onecab_assistant_usage_for_platform(text) from public, anon, authenticated;
grant execute on function public.onecab_assistant_usage_for_platform(text) to service_role;

-- Existing no-arg usage stays website-only so mixed events cannot share the website cap.
create or replace function public.onecab_assistant_usage()
returns table (day_usd numeric, month_usd numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(cost_usd) filter (where created_at >= date_trunc('day', now())), 0),
    coalesce(sum(cost_usd) filter (where created_at >= date_trunc('month', now())), 0)
  from public.onecab_assistant_events
  where platform = 'website';
$$;

-- Recreate quota RPC with optional identity + device scopes (backward compatible defaults).
drop function if exists public.onecab_assistant_consume_quota(text, text, text, integer, integer);

create or replace function public.onecab_assistant_consume_quota(
  p_session_ref text,
  p_ip_hash text,
  p_platform text,
  p_session_limit integer,
  p_ip_hour_limit integer,
  p_identity_ref text default null,
  p_identity_limit integer default null,
  p_device_ref text default null,
  p_device_limit integer default null
) returns table (allowed boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_ok boolean := false;
  v_ip_ok boolean := false;
  v_identity_ok boolean := false;
  v_device_ok boolean := false;
  v_hour timestamptz := date_trunc('hour', now());
begin
  insert into public.onecab_assistant_rate_limits
    (scope, key_hash, platform, window_start, expires_at, count)
  values ('session', p_session_ref, p_platform, 'epoch'::timestamptz, now() + interval '24 hours', 1)
  on conflict (scope, key_hash, window_start) do update
    set count = public.onecab_assistant_rate_limits.count + 1,
        expires_at = now() + interval '24 hours'
    where public.onecab_assistant_rate_limits.count < p_session_limit
  returning true into v_session_ok;

  if not coalesce(v_session_ok, false) then
    return query select false, 'session'::text;
    return;
  end if;

  if p_identity_ref is not null and p_identity_limit is not null then
    insert into public.onecab_assistant_rate_limits
      (scope, key_hash, platform, window_start, expires_at, count)
    values ('identity', p_identity_ref, p_platform, 'epoch'::timestamptz, now() + interval '24 hours', 1)
    on conflict (scope, key_hash, window_start) do update
      set count = public.onecab_assistant_rate_limits.count + 1,
          expires_at = now() + interval '24 hours'
      where public.onecab_assistant_rate_limits.count < p_identity_limit
    returning true into v_identity_ok;

    if not coalesce(v_identity_ok, false) then
      return query select false, 'session'::text;
      return;
    end if;
  end if;

  if p_device_ref is not null and p_device_limit is not null then
    insert into public.onecab_assistant_rate_limits
      (scope, key_hash, platform, window_start, expires_at, count)
    values ('device', p_device_ref, p_platform, 'epoch'::timestamptz, now() + interval '24 hours', 1)
    on conflict (scope, key_hash, window_start) do update
      set count = public.onecab_assistant_rate_limits.count + 1,
          expires_at = now() + interval '24 hours'
      where public.onecab_assistant_rate_limits.count < p_device_limit
    returning true into v_device_ok;

    if not coalesce(v_device_ok, false) then
      return query select false, 'session'::text;
      return;
    end if;
  end if;

  insert into public.onecab_assistant_rate_limits
    (scope, key_hash, platform, window_start, expires_at, count)
  values ('ip', p_ip_hash, p_platform, v_hour, v_hour + interval '2 hours', 1)
  on conflict (scope, key_hash, window_start) do update
    set count = public.onecab_assistant_rate_limits.count + 1
    where public.onecab_assistant_rate_limits.count < p_ip_hour_limit
  returning true into v_ip_ok;

  if not coalesce(v_ip_ok, false) then
    return query select false, 'ip'::text;
    return;
  end if;

  return query select true, null::text;
end;
$$;

revoke all on function public.onecab_assistant_consume_quota(text, text, text, integer, integer, text, integer, text, integer)
  from public, anon, authenticated;
grant execute on function public.onecab_assistant_consume_quota(text, text, text, integer, integer, text, integer, text, integer)
  to service_role;

revoke all on public.onecab_assistant_config from anon, authenticated;
grant all on public.onecab_assistant_config to service_role;
alter table public.onecab_assistant_config enable row level security;

revoke all on public.onecab_assistant_events from anon, authenticated;
grant all on public.onecab_assistant_events to service_role;
alter table public.onecab_assistant_events enable row level security;

revoke all on public.onecab_assistant_rate_limits from anon, authenticated;
grant all on public.onecab_assistant_rate_limits to service_role;
alter table public.onecab_assistant_rate_limits enable row level security;
