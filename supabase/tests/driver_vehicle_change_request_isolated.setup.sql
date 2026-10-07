-- Local harness mirroring the live objects the migration touches (read from
-- production catalog). Not a Supabase replica: only what the flow depends on.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('admin','moderator','user','driver','customer');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL AND _user_id IS NOT DISTINCT FROM auth.uid()
    AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_roles.user_id = _user_id AND user_roles.role = _role)
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $function$;

CREATE TABLE public.drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  deleted_at timestamptz,
  vehicle_locked boolean NOT NULL DEFAULT false,
  vehicle_edit_request_status text,
  approval_status text DEFAULT 'pending',
  is_pet_friendly boolean DEFAULT false,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid REFERENCES public.drivers(id) ON DELETE CASCADE,
  make text, model text, year integer, color text, license_plate text,
  is_primary boolean DEFAULT true,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  approval_status text DEFAULT 'pending', rejection_reason text,
  capacity integer DEFAULT 4, vehicle_type_id uuid
);

CREATE OR REPLACE FUNCTION public.can_driver_edit_vehicle(p_driver_id uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_vehicle_locked boolean; v_approval_status text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.drivers d WHERE d.id = p_driver_id AND d.user_id = auth.uid() AND d.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT vehicle_locked, approval_status INTO v_vehicle_locked, v_approval_status FROM drivers WHERE id = p_driver_id;
  RETURN (NOT COALESCE(v_vehicle_locked, false)) OR (v_approval_status = 'pending');
END; $function$;

CREATE OR REPLACE FUNCTION public.check_vehicle_edit_allowed()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_can_edit boolean;
BEGIN
  IF has_role(auth.uid(), 'admin'::app_role) THEN RETURN NEW; END IF;
  SELECT can_driver_edit_vehicle(NEW.driver_id) INTO v_can_edit;
  IF NOT v_can_edit THEN RAISE EXCEPTION 'Vehicle is locked. Please submit a change request for admin approval.'; END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.check_vehicle_not_approved()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.approval_status = 'approved' THEN
    IF NOT public.has_role(auth.uid(), 'admin') THEN
      RAISE EXCEPTION 'Cannot modify approved vehicle information. Please contact support.';
    END IF;
  END IF;
  IF NOT public.has_role(auth.uid(), 'admin') THEN NEW.approval_status := 'pending'; END IF;
  RETURN NEW;
END; $function$;

CREATE TRIGGER check_vehicle_edit_allowed_trigger BEFORE UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION check_vehicle_edit_allowed();
CREATE TRIGGER enforce_vehicle_approval_lock BEFORE UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION check_vehicle_not_approved();
CREATE TRIGGER update_vehicles_updated_at BEFORE UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE public.vehicle_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  requested_make text NOT NULL, requested_model text NOT NULL, requested_year integer NOT NULL,
  requested_color text NOT NULL, requested_license_plate text NOT NULL,
  status text NOT NULL DEFAULT 'pending', admin_notes text, reviewed_by uuid, reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_vehicle_change_requests_driver_id ON public.vehicle_change_requests (driver_id);
CREATE INDEX idx_vehicle_change_requests_status ON public.vehicle_change_requests (status);
ALTER TABLE public.vehicle_change_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage all change requests" ON public.vehicle_change_requests
  USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Drivers can create change requests for their vehicles" ON public.vehicle_change_requests
  FOR INSERT WITH CHECK (driver_id IN (SELECT drivers.id FROM drivers WHERE drivers.user_id = auth.uid()));
CREATE POLICY "Drivers can view their own change requests" ON public.vehicle_change_requests
  FOR SELECT USING (driver_id IN (SELECT drivers.id FROM drivers WHERE drivers.user_id = auth.uid()));
GRANT ALL ON public.vehicle_change_requests TO anon, authenticated, service_role;
GRANT SELECT ON public.drivers, public.vehicles, public.user_roles TO authenticated;
GRANT UPDATE ON public.vehicles TO authenticated;

CREATE TABLE public.document_types (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE, name text);
CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid, document_type text, document_name text,
  file_url text, status text, expiry_date date, reviewed_at timestamptz, created_at timestamptz DEFAULT now(),
  is_current boolean DEFAULT true
);

-- Controllable stand-in for the live eligibility SSOT (same output keys).
CREATE TABLE public.test_eligibility (driver_id uuid PRIMARY KEY, payload jsonb);
CREATE OR REPLACE FUNCTION public.get_driver_document_eligibility_internal(p_driver_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT payload FROM public.test_eligibility WHERE driver_id = p_driver_id $$;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM PUBLIC;

CREATE TABLE public.vehicle_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, slug text,
  is_default boolean DEFAULT false, driver_controllable boolean DEFAULT false, is_active boolean DEFAULT true
);
CREATE TABLE public.driver_vehicle_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid, vehicle_type_id uuid, is_enabled boolean,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (driver_id, vehicle_type_id)
);
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text, user_id uuid, driver_id uuid, trip_id uuid,
  details jsonb, ip_address text, user_agent text, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.driver_inbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid NOT NULL, type text, title text NOT NULL,
  body text NOT NULL, metadata jsonb, is_read boolean DEFAULT false, created_at timestamptz DEFAULT now()
);
