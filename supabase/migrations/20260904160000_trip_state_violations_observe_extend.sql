-- Additive observe-mode extension — does not block writes.
-- Extends log_trip_state_violation to cover matrix invariants beyond I1/I2:
--   I3: no_show with assigned driver
--   I4: in_progress without assigned driver
--   I5: queued with started_at set (queued marked in progress)
-- Aligns with assertTripLifecycleInvariants (observe only).

CREATE OR REPLACE FUNCTION public.log_trip_state_violation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_terminal boolean;
  v_active_dispatch boolean;
  v_cancel boolean;
  v_new_violates boolean;
  v_old_violates boolean;
  v_type text;
  v_status text;
  v_dispatch text;
  v_assigned boolean;
  v_in_progress boolean;
  v_queued boolean;
  v_i1 boolean;
  v_i2 boolean;
  v_i3 boolean;
  v_i4 boolean;
  v_i5 boolean;
  v_old_i1 boolean;
  v_old_i2 boolean;
  v_old_i3 boolean;
  v_old_i4 boolean;
  v_old_i5 boolean;
begin
  begin
    v_status := lower(coalesce(NEW.status, ''));
    v_dispatch := lower(coalesce(NEW.dispatch_status, ''));
    v_assigned := (NEW.confirmed_driver_id is not null) or (NEW.driver_id is not null);
    v_in_progress := v_status in ('in_progress','on_trip','started','ongoing','passenger_onboard');
    v_queued := v_status = 'queued';

    v_terminal := NEW.status in ('cancelled','customer_cancelled','expired','no_driver_found','no_show','completed');
    v_active_dispatch := v_dispatch in ('assigned','broadcasting','offering','offered','pending');
    v_cancel := NEW.status in ('cancelled','customer_cancelled','expired','no_driver_found');

    v_i1 := v_terminal and v_active_dispatch;
    v_i2 := v_cancel and NEW.confirmed_driver_id is not null;
    v_i3 := v_status = 'no_show' and v_assigned;
    v_i4 := v_in_progress and not v_assigned;
    v_i5 := v_queued and NEW.started_at is not null;
    v_new_violates := v_i1 or v_i2 or v_i3 or v_i4 or v_i5;

    if v_new_violates then
      if TG_OP = 'INSERT' then
        v_old_violates := false;
      else
        v_old_i1 := OLD.status in ('cancelled','customer_cancelled','expired','no_driver_found','no_show','completed')
          and lower(coalesce(OLD.dispatch_status,'')) in ('assigned','broadcasting','offering','offered','pending');
        v_old_i2 := OLD.status in ('cancelled','customer_cancelled','expired','no_driver_found')
          and OLD.confirmed_driver_id is not null;
        v_old_i3 := lower(coalesce(OLD.status,'')) = 'no_show'
          and (OLD.confirmed_driver_id is not null or OLD.driver_id is not null);
        v_old_i4 := lower(coalesce(OLD.status,'')) in ('in_progress','on_trip','started','ongoing','passenger_onboard')
          and OLD.confirmed_driver_id is null and OLD.driver_id is null;
        v_old_i5 := lower(coalesce(OLD.status,'')) = 'queued' and OLD.started_at is not null;
        v_old_violates := v_old_i1 or v_old_i2 or v_old_i3 or v_old_i4 or v_old_i5;
      end if;

      if not v_old_violates then
        v_type := case
          when v_i1 and v_i2 then 'I1+I2'
          when v_i1 then 'I1'
          when v_i2 then 'I2'
          when v_i3 then 'I3_no_show_assigned'
          when v_i4 then 'I4_in_progress_unassigned'
          when v_i5 then 'I5_queued_started'
          else 'INVARIANT'
        end;
        insert into public.trip_state_violations(
          op, trip_id, trip_code, old_status, new_status, dispatch_status,
          confirmed_driver_id, driver_id, violation_type,
          writer_application_name, writer_role, request_path, txid)
        values(
          TG_OP, NEW.id, NEW.trip_code,
          case when TG_OP='UPDATE' then OLD.status else null end,
          NEW.status, NEW.dispatch_status, NEW.confirmed_driver_id, NEW.driver_id, v_type,
          current_setting('application_name', true), current_user,
          current_setting('request.path', true), txid_current());
      end if;
    end if;
  exception when others then
    null;
  end;
  return null;
end;
$function$;

COMMENT ON FUNCTION public.log_trip_state_violation() IS
  'AFTER INSERT/UPDATE trips: observe-mode log for I1–I5 lifecycle invariant introductions. Never blocks writes.';
