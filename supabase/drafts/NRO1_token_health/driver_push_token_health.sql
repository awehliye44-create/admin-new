-- DRAFT ONLY. Do not apply.
-- Read-only token health for the authenticated driver. No trip, payment,
-- wallet, or commission writes. Not wired into production until approved.
--
-- Go-online in the driver app already returns tokenHealth from the local
-- bind attempt. This function is the optional server echo of the same check.

create or replace function public.driver_push_token_health()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ready', exists (
      select 1
      from public.driver_active_devices d
      join public.push_tokens t
        on t.driver_id = d.driver_id
       and t.device_id = d.device_id
       and t.app_type = 'driver'
       and t.is_active = true
      where d.driver_id = public.current_driver_id()
    ),
    'has_active_device', exists (
      select 1
      from public.driver_active_devices d
      where d.driver_id = public.current_driver_id()
    ),
    'active_platform', (
      select d.platform
      from public.driver_active_devices d
      where d.driver_id = public.current_driver_id()
    )
  );
$$;

revoke all on function public.driver_push_token_health() from public;
grant execute on function public.driver_push_token_health() to authenticated;
