-- Staff Work Patterns (internal staff only — not drivers)

CREATE TYPE public.staff_work_pattern_type AS ENUM ('fixed_weekly', 'rotating', 'custom');

CREATE TYPE public.staff_shift_length_preset AS ENUM ('8h', '10h', '12h', 'night_12h', 'custom');

CREATE TYPE public.staff_shift_type AS ENUM ('day', 'late', 'night', 'morning', 'off');

CREATE TABLE public.staff_work_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  pattern_type public.staff_work_pattern_type NOT NULL DEFAULT 'fixed_weekly',
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  description TEXT,
  shift_length_preset public.staff_shift_length_preset NOT NULL DEFAULT 'custom',
  schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
  weekly_hours_minutes INTEGER NOT NULL DEFAULT 0,
  staff_role public.staff_role,
  region_id UUID REFERENCES public.regions(id) ON DELETE SET NULL,
  service_area_id UUID REFERENCES public.service_areas(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  effective_from DATE,
  effective_to DATE,
  archived_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.staff_pattern_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id UUID NOT NULL REFERENCES public.staff_work_patterns(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by UUID,
  UNIQUE (pattern_id, staff_id)
);

ALTER TABLE public.staff_profiles
  ADD COLUMN IF NOT EXISTS assigned_pattern_id UUID REFERENCES public.staff_work_patterns(id) ON DELETE SET NULL;

CREATE TABLE public.staff_coverage_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_name TEXT NOT NULL,
  staff_role public.staff_role NOT NULL,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  required_staff_count INTEGER NOT NULL DEFAULT 1 CHECK (required_staff_count >= 0),
  region_id UUID REFERENCES public.regions(id) ON DELETE SET NULL,
  service_area_id UUID REFERENCES public.service_areas(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.staff_leave_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES public.staff_profiles(id) ON DELETE CASCADE,
  leave_date DATE NOT NULL,
  leave_type TEXT NOT NULL,
  start_time TIME,
  end_time TIME,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_staff_work_patterns_active ON public.staff_work_patterns (is_active) WHERE archived_at IS NULL;
CREATE INDEX idx_staff_pattern_assignments_pattern ON public.staff_pattern_assignments (pattern_id) WHERE is_active = true;
CREATE INDEX idx_staff_pattern_assignments_staff ON public.staff_pattern_assignments (staff_id) WHERE is_active = true;
CREATE INDEX idx_staff_coverage_requirements_day ON public.staff_coverage_requirements (day_of_week, staff_role) WHERE is_active = true;

ALTER TABLE public.staff_work_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_pattern_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_coverage_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_leave_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff work patterns viewable by authenticated"
  ON public.staff_work_patterns FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff work patterns insert by admin"
  ON public.staff_work_patterns FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff work patterns update by admin"
  ON public.staff_work_patterns FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff work patterns delete by admin"
  ON public.staff_work_patterns FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff pattern assignments viewable by authenticated"
  ON public.staff_pattern_assignments FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff pattern assignments insert by admin"
  ON public.staff_pattern_assignments FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff pattern assignments update by admin"
  ON public.staff_pattern_assignments FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff pattern assignments delete by admin"
  ON public.staff_pattern_assignments FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff coverage requirements viewable by authenticated"
  ON public.staff_coverage_requirements FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff coverage requirements insert by admin"
  ON public.staff_coverage_requirements FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff coverage requirements update by admin"
  ON public.staff_coverage_requirements FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff coverage requirements delete by admin"
  ON public.staff_coverage_requirements FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff leave exceptions viewable by authenticated"
  ON public.staff_leave_exceptions FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff leave exceptions insert by admin"
  ON public.staff_leave_exceptions FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff leave exceptions update by admin"
  ON public.staff_leave_exceptions FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff leave exceptions delete by admin"
  ON public.staff_leave_exceptions FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES
  ('super_admin', 'staff-work-patterns', true),
  ('admin', 'staff-work-patterns', true),
  ('operator', 'staff-work-patterns', true)
ON CONFLICT (role, page_slug) DO UPDATE SET can_access = EXCLUDED.can_access;
