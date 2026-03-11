
-- Create staff role enum
CREATE TYPE public.staff_role AS ENUM (
  'super_admin', 'admin', 'operator', 'finance_manager', 'customer_support', 'compliance_officer'
);

-- Staff ID sequences per role prefix
CREATE TABLE public.staff_id_sequences (
  role_prefix TEXT PRIMARY KEY,
  current_value INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.staff_id_sequences (role_prefix) VALUES 
  ('SA'), ('AD'), ('OP'), ('FM'), ('CS'), ('CO');

-- Staff profiles with auto-generated human-friendly IDs
CREATE TABLE public.staff_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  staff_role_id TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  username TEXT UNIQUE,
  role staff_role NOT NULL DEFAULT 'operator',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.staff_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff profiles viewable by authenticated" ON public.staff_profiles
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff profiles insert by admin" ON public.staff_profiles
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff profiles update by admin" ON public.staff_profiles
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff profiles delete by admin" ON public.staff_profiles
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Staff service area assignments
CREATE TABLE public.staff_service_areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID REFERENCES public.staff_profiles(id) ON DELETE CASCADE NOT NULL,
  service_area_id UUID REFERENCES public.service_areas(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(staff_id, service_area_id)
);

ALTER TABLE public.staff_service_areas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff service areas viewable by authenticated" ON public.staff_service_areas
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff service areas insert by admin" ON public.staff_service_areas
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff service areas update by admin" ON public.staff_service_areas
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff service areas delete by admin" ON public.staff_service_areas
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Role page permissions (defines which roles can access which pages)
CREATE TABLE public.role_page_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role staff_role NOT NULL,
  page_slug TEXT NOT NULL,
  can_access BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(role, page_slug)
);

ALTER TABLE public.role_page_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Role permissions viewable by authenticated" ON public.role_page_permissions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Role permissions insert by admin" ON public.role_page_permissions
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Role permissions update by admin" ON public.role_page_permissions
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Role permissions delete by admin" ON public.role_page_permissions
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Function to get role prefix from staff_role
CREATE OR REPLACE FUNCTION public.get_staff_role_prefix(p_role staff_role)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_role
    WHEN 'super_admin' THEN 'SA'
    WHEN 'admin' THEN 'AD'
    WHEN 'operator' THEN 'OP'
    WHEN 'finance_manager' THEN 'FM'
    WHEN 'customer_support' THEN 'CS'
    WHEN 'compliance_officer' THEN 'CO'
  END;
$$;

-- Auto-generate staff_role_id on INSERT
CREATE OR REPLACE FUNCTION public.generate_staff_role_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix TEXT;
  v_seq INTEGER;
BEGIN
  v_prefix := get_staff_role_prefix(NEW.role);
  
  INSERT INTO staff_id_sequences (role_prefix, current_value)
  VALUES (v_prefix, 1)
  ON CONFLICT (role_prefix)
  DO UPDATE SET current_value = staff_id_sequences.current_value + 1, updated_at = now()
  RETURNING current_value INTO v_seq;
  
  NEW.staff_role_id := v_prefix || LPAD(v_seq::TEXT, 3, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_generate_staff_role_id
  BEFORE INSERT ON public.staff_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_staff_role_id();

-- Re-generate staff_role_id when role changes
CREATE OR REPLACE FUNCTION public.update_staff_role_id_on_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix TEXT;
  v_seq INTEGER;
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    v_prefix := get_staff_role_prefix(NEW.role);
    
    INSERT INTO staff_id_sequences (role_prefix, current_value)
    VALUES (v_prefix, 1)
    ON CONFLICT (role_prefix)
    DO UPDATE SET current_value = staff_id_sequences.current_value + 1, updated_at = now()
    RETURNING current_value INTO v_seq;
    
    NEW.staff_role_id := v_prefix || LPAD(v_seq::TEXT, 3, '0');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_update_staff_role_id
  BEFORE UPDATE ON public.staff_profiles
  FOR EACH ROW
  WHEN (NEW.role IS DISTINCT FROM OLD.role)
  EXECUTE FUNCTION public.update_staff_role_id_on_change();

-- updated_at trigger
CREATE TRIGGER tr_staff_profiles_updated_at
  BEFORE UPDATE ON public.staff_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Sync staff to user_roles for RLS compatibility (all staff get admin role)
CREATE OR REPLACE FUNCTION public.sync_staff_user_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.user_id, 'admin')
  ON CONFLICT (user_id, role) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_sync_staff_user_role
  AFTER INSERT ON public.staff_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_staff_user_role();

-- Seed default role page permissions
DO $$
DECLARE
  all_pages TEXT[] := ARRAY[
    'dashboard',
    'fleet-tracking', 'active-trips', 'auto-dispatch', 'scheduled-rides', 'missed-cancelled', 'trip-history', 'manual-trip', 'dispatch',
    'drivers', 'vehicles', 'vehicle-types', 'documents', 'driver-categories',
    'regions', 'services', 'service-area-pricing',
    'promo-codes', 'custom-zones', 'zone-pricing', 'corporate-fares', 'fare-simulator',
    'airports',
    'corporate-accounts', 'account-requests', 'corporate-billing', 'corporate-reports', 'corporate-settings',
    'riders', 'rider-feedback',
    'suspensions', 'complaints', 'live-chat', 'tickets', 'categories',
    'admin-payments', 'driver-wallet', 'admin-settlements', 'payout-batches', 'disputes', 'dispute-settings',
    'onecab-documents',
    'content',
    'general-settings', 'integrations', 'webhooks', 'system', 'roles', 'notifications', 'profile'
  ];
  
  operator_pages TEXT[] := ARRAY[
    'dashboard',
    'fleet-tracking', 'active-trips', 'auto-dispatch', 'scheduled-rides', 'missed-cancelled', 'trip-history', 'manual-trip', 'dispatch',
    'drivers', 'vehicles', 'vehicle-types', 'documents', 'driver-categories',
    'riders', 'rider-feedback',
    'profile'
  ];
  
  finance_pages TEXT[] := ARRAY[
    'dashboard', 'trip-history',
    'admin-payments', 'driver-wallet', 'admin-settlements', 'payout-batches', 'disputes', 'dispute-settings',
    'corporate-billing', 'corporate-reports',
    'profile'
  ];
  
  support_pages TEXT[] := ARRAY[
    'dashboard', 'active-trips', 'trip-history',
    'riders', 'rider-feedback',
    'suspensions', 'complaints', 'live-chat', 'tickets', 'categories',
    'drivers',
    'profile'
  ];
  
  compliance_pages TEXT[] := ARRAY[
    'dashboard',
    'drivers', 'documents', 'driver-categories',
    'onecab-documents',
    'trip-history',
    'profile'
  ];
  
  p TEXT;
  r public.staff_role;
BEGIN
  -- Super Admin and Admin get ALL pages
  FOREACH r IN ARRAY ARRAY['super_admin', 'admin']::staff_role[] LOOP
    FOREACH p IN ARRAY all_pages LOOP
      INSERT INTO role_page_permissions (role, page_slug, can_access) VALUES (r, p, true)
      ON CONFLICT (role, page_slug) DO NOTHING;
    END LOOP;
  END LOOP;
  
  -- Operator
  FOREACH p IN ARRAY all_pages LOOP
    INSERT INTO role_page_permissions (role, page_slug, can_access) 
    VALUES ('operator', p, p = ANY(operator_pages))
    ON CONFLICT (role, page_slug) DO NOTHING;
  END LOOP;
  
  -- Finance Manager
  FOREACH p IN ARRAY all_pages LOOP
    INSERT INTO role_page_permissions (role, page_slug, can_access) 
    VALUES ('finance_manager', p, p = ANY(finance_pages))
    ON CONFLICT (role, page_slug) DO NOTHING;
  END LOOP;
  
  -- Customer Support
  FOREACH p IN ARRAY all_pages LOOP
    INSERT INTO role_page_permissions (role, page_slug, can_access) 
    VALUES ('customer_support', p, p = ANY(support_pages))
    ON CONFLICT (role, page_slug) DO NOTHING;
  END LOOP;
  
  -- Compliance Officer
  FOREACH p IN ARRAY all_pages LOOP
    INSERT INTO role_page_permissions (role, page_slug, can_access) 
    VALUES ('compliance_officer', p, p = ANY(compliance_pages))
    ON CONFLICT (role, page_slug) DO NOTHING;
  END LOOP;
END $$;
