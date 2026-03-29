
-- Statement schedule configuration table
CREATE TABLE public.statement_schedule_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Toggles
  is_auto_generate_enabled BOOLEAN NOT NULL DEFAULT false,
  is_auto_send_enabled BOOLEAN NOT NULL DEFAULT false,
  
  -- Frequency: 'monthly', 'weekly', 'manual'
  frequency TEXT NOT NULL DEFAULT 'monthly',
  
  -- Generation day (1-31 for monthly, 0=last day; 1-7 for weekly where 1=Monday)
  generation_day INTEGER NOT NULL DEFAULT 5,
  
  -- Send timing: 'immediate' or 'scheduled'
  send_mode TEXT NOT NULL DEFAULT 'immediate',
  send_day INTEGER,  -- day of month for scheduled sending
  send_hour INTEGER NOT NULL DEFAULT 9,  -- hour in timezone (0-23)
  
  -- Statement period: 'previous_month', 'current_month_to_date', 'custom'
  statement_period_mode TEXT NOT NULL DEFAULT 'previous_month',
  custom_period_days INTEGER,  -- for custom: N days back
  
  -- Due date
  due_days_after_generation INTEGER NOT NULL DEFAULT 7,
  
  -- Timezone
  timezone TEXT NOT NULL DEFAULT 'UTC',
  
  -- Scope: 'all', 'region', 'service_area'
  scope_type TEXT NOT NULL DEFAULT 'all',
  scope_region_id UUID REFERENCES public.regions(id) ON DELETE SET NULL,
  scope_service_area_id UUID REFERENCES public.service_areas(id) ON DELETE SET NULL,
  
  -- Run tracking
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,  -- 'success', 'failed'
  last_run_error TEXT,
  last_run_invoice_count INTEGER,
  next_run_at TIMESTAMPTZ,
  
  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Add updated_at trigger
CREATE TRIGGER update_statement_schedule_configs_updated_at
  BEFORE UPDATE ON public.statement_schedule_configs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Enable RLS
ALTER TABLE public.statement_schedule_configs ENABLE ROW LEVEL SECURITY;

-- Only authenticated users (admins) can manage schedule configs
CREATE POLICY "Authenticated users can view schedule configs"
  ON public.statement_schedule_configs FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert schedule configs"
  ON public.statement_schedule_configs FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update schedule configs"
  ON public.statement_schedule_configs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Schedule run log for audit trail
CREATE TABLE public.statement_schedule_run_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_config_id UUID REFERENCES public.statement_schedule_configs(id) ON DELETE CASCADE NOT NULL,
  statement_run_id UUID REFERENCES public.statement_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'running', 'success', 'failed'
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  invoice_count INTEGER DEFAULT 0,
  error_message TEXT,
  period_start DATE,
  period_end DATE,
  region_id UUID REFERENCES public.regions(id) ON DELETE SET NULL,
  service_area_id UUID REFERENCES public.service_areas(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.statement_schedule_run_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view run logs"
  ON public.statement_schedule_run_log FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert run logs"
  ON public.statement_schedule_run_log FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update run logs"
  ON public.statement_schedule_run_log FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Add triggered_by column to statement_runs to track auto vs manual
ALTER TABLE public.statement_runs ADD COLUMN IF NOT EXISTS triggered_by TEXT DEFAULT 'manual';
ALTER TABLE public.statement_runs ADD COLUMN IF NOT EXISTS schedule_config_id UUID REFERENCES public.statement_schedule_configs(id) ON DELETE SET NULL;
