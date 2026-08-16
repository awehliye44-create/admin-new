-- ONECAB Assistant (central, platform-neutral) — configuration, operational
-- metadata, atomic rate limits, usage rollups and retention cleanup.

create table if not exists public.onecab_assistant_config (
  platform text primary key
    check (platform in ('website','customer_app','driver_app','corporate_portal')),
  enabled boolean not null default true,
  model text not null default 'gpt-5.6-luna'
    check (model in ('gpt-5.6-luna')),
  monthly_budget_usd numeric(10,2) not null default 25 check (monthly_budget_usd > 0),
  monthly_warning_usd numeric(10,2) not null default 20 check (monthly_warning_usd > 0),
  max_questions_per_session integer not null default 10 check (max_questions_per_session between 1 and 100),
  max_questions_per_ip_hour integer not null default 30 check (max_questions_per_ip_hour between 1 and 1000),
  max_input_characters integer not null default 500 check (max_input_characters between 1 and 4000),
  max_output_tokens integer not null default 400 check (max_output_tokens between 1 and 4000),
  max_output_words integer not null default 150 check (max_output_words between 1 and 1000),
  request_timeout_ms integer not null default 20000 check (request_timeout_ms between 1000 and 60000),
  updated_at timestamptz not null default now()
);

revoke all on public.onecab_assistant_config from anon, authenticated;
grant all on public.onecab_assistant_config to service_role;
alter table public.onecab_assistant_config enable row level security;

insert into public.onecab_assistant_config (platform) values ('website')
on conflict (platform) do nothing;

create table if not exists public.onecab_assistant_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  session_ref text not null,
  ip_hash text not null,
  platform text not null
    check (platform in ('website','customer_app','driver_app','corporate_portal')),
  outcome text not null,
  success boolean not null default true,
  quick_action text,
  model text,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  cached_input_tokens integer not null default 0 check (cached_input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_usd numeric(12,6) not null default 0 check (cost_usd >= 0),
  pricing_version text,
  safety_outcome text,
  rate_limit_outcome text
);

revoke all on public.onecab_assistant_events from anon, authenticated;
grant all on public.onecab_assistant_events to service_role;
alter table public.onecab_assistant_events enable row level security;

create index if not exists onecab_assistant_events_created_idx
  on public.onecab_assistant_events (created_at desc);
create index if not exists onecab_assistant_events_platform_created_idx
  on public.onecab_assistant_events (platform, created_at desc);

create table if not exists public.onecab_assistant_rate_limits (
  scope text not null check (scope in ('session','ip')),
  key_hash text not null,
  platform text not null,
  window_start timestamptz not null,
  expires_at timestamptz not null,
  count integer not null default 0 check (count >= 0),
  primary key (scope, key_hash, window_start)
);

revoke all on public.onecab_assistant_rate_limits from anon, authenticated;
grant all on public.onecab_assistant_rate_limits to service_role;
alter table public.onecab_assistant_rate_limits enable row level security;

create index if not exists onecab_assistant_rate_limits_expiry_idx
  on public.onecab_assistant_rate_limits (expires_at);

create or replace function public.onecab_assistant_consume_quota(
  p_session_ref text,
  p_ip_hash text,
  p_platform text,
  p_session_limit integer,
  p_ip_hour_limit integer
) returns table (allowed boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_ok boolean := false;
  v_ip_ok boolean := false;
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

revoke all on function public.onecab_assistant_consume_quota(text,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.onecab_assistant_consume_quota(text,text,text,integer,integer) to service_role;

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
  from public.onecab_assistant_events;
$$;

revoke all on function public.onecab_assistant_usage() from public, anon, authenticated;
grant execute on function public.onecab_assistant_usage() to service_role;

create or replace function public.onecab_assistant_cleanup()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.onecab_assistant_rate_limits where expires_at < now();
  delete from public.onecab_assistant_events where created_at < now() - interval '90 days';
end;
$$;

revoke all on function public.onecab_assistant_cleanup() from public, anon, authenticated;
grant execute on function public.onecab_assistant_cleanup() to service_role;

create extension if not exists pg_cron with schema cron;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
    from cron.job
    where jobname = 'onecab-assistant-cleanup';

    perform cron.schedule(
      'onecab-assistant-cleanup',
      '17 * * * *',
      $cron$select public.onecab_assistant_cleanup()$cron$
    );
  else
    raise notice 'pg_cron unavailable: schedule public.onecab_assistant_cleanup() hourly via the platform scheduler.';
  end if;
end;
$$;