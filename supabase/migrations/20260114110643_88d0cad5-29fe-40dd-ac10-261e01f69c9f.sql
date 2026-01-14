-- Create notifications table for system-wide notifications and alerts
CREATE TABLE public.notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  type text NOT NULL DEFAULT 'info',
  category text NOT NULL DEFAULT 'system',
  title text NOT NULL,
  message text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  target_audience text NOT NULL DEFAULT 'all',
  target_region_id uuid REFERENCES public.regions(id) ON DELETE SET NULL,
  target_service_area_id uuid REFERENCES public.service_areas(id) ON DELETE SET NULL,
  target_user_id uuid,
  is_read boolean NOT NULL DEFAULT false,
  is_dismissed boolean NOT NULL DEFAULT false,
  action_url text,
  action_label text,
  metadata jsonb DEFAULT '{}'::jsonb,
  expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  
  CONSTRAINT notification_type_check CHECK (type IN ('info', 'success', 'warning', 'error', 'alert')),
  CONSTRAINT notification_category_check CHECK (category IN ('system', 'trip', 'driver', 'rider', 'payment', 'dispatch', 'maintenance', 'security', 'promotion')),
  CONSTRAINT notification_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT notification_target_check CHECK (target_audience IN ('all', 'admins', 'drivers', 'riders', 'region', 'service_area', 'user'))
);

-- Create notification templates table for reusable notification templates
CREATE TABLE public.notification_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL UNIQUE,
  type text NOT NULL DEFAULT 'info',
  category text NOT NULL DEFAULT 'system',
  title_template text NOT NULL,
  message_template text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT template_type_check CHECK (type IN ('info', 'success', 'warning', 'error', 'alert')),
  CONSTRAINT template_category_check CHECK (category IN ('system', 'trip', 'driver', 'rider', 'payment', 'dispatch', 'maintenance', 'security', 'promotion')),
  CONSTRAINT template_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
);

-- Create notification settings table for user preferences
CREATE TABLE public.notification_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  setting_key text NOT NULL UNIQUE,
  setting_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  description text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;

-- RLS Policies for notifications
CREATE POLICY "Admins can manage all notifications"
  ON public.notifications FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Users can view notifications targeted to them"
  ON public.notifications FOR SELECT
  USING (
    target_audience = 'all' OR
    (target_audience = 'user' AND target_user_id = auth.uid()) OR
    (target_audience = 'admins' AND has_role(auth.uid(), 'admin'::app_role))
  );

CREATE POLICY "Users can update their own notifications (mark as read)"
  ON public.notifications FOR UPDATE
  USING (target_user_id = auth.uid() OR target_audience = 'all')
  WITH CHECK (target_user_id = auth.uid() OR target_audience = 'all');

-- RLS Policies for notification templates
CREATE POLICY "Admins can manage notification templates"
  ON public.notification_templates FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can read active notification templates"
  ON public.notification_templates FOR SELECT
  USING (is_active = true);

-- RLS Policies for notification settings
CREATE POLICY "Admins can manage notification settings"
  ON public.notification_settings FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can read notification settings"
  ON public.notification_settings FOR SELECT
  USING (true);

-- Create indexes for better query performance
CREATE INDEX idx_notifications_type ON public.notifications(type);
CREATE INDEX idx_notifications_category ON public.notifications(category);
CREATE INDEX idx_notifications_priority ON public.notifications(priority);
CREATE INDEX idx_notifications_target ON public.notifications(target_audience);
CREATE INDEX idx_notifications_created_at ON public.notifications(created_at DESC);
CREATE INDEX idx_notifications_is_read ON public.notifications(is_read);

-- Insert default notification settings
INSERT INTO public.notification_settings (setting_key, setting_value, description) VALUES
  ('email_notifications', '{"enabled": true, "trip_updates": true, "driver_alerts": true, "payment_alerts": true, "system_alerts": true}'::jsonb, 'Email notification preferences'),
  ('push_notifications', '{"enabled": true, "trip_updates": true, "driver_alerts": true, "payment_alerts": true, "system_alerts": true}'::jsonb, 'Push notification preferences'),
  ('sms_notifications', '{"enabled": false, "urgent_only": true}'::jsonb, 'SMS notification preferences'),
  ('alert_thresholds', '{"low_driver_count": 5, "high_wait_time_minutes": 10, "high_cancellation_rate": 20, "payment_failure_count": 3}'::jsonb, 'Alert trigger thresholds'),
  ('quiet_hours', '{"enabled": false, "start": "22:00", "end": "07:00", "timezone": "Europe/London"}'::jsonb, 'Quiet hours for notifications');

-- Insert default notification templates
INSERT INTO public.notification_templates (name, type, category, title_template, message_template, priority) VALUES
  ('driver_went_online', 'info', 'driver', 'Driver Online', '{{driver_name}} is now online in {{service_area}}', 'low'),
  ('driver_went_offline', 'info', 'driver', 'Driver Offline', '{{driver_name}} went offline in {{service_area}}', 'low'),
  ('new_trip_request', 'info', 'trip', 'New Trip Request', 'New trip request from {{pickup}} to {{dropoff}}', 'normal'),
  ('trip_completed', 'success', 'trip', 'Trip Completed', 'Trip #{{trip_code}} completed. Fare: {{fare}}', 'normal'),
  ('trip_cancelled', 'warning', 'trip', 'Trip Cancelled', 'Trip #{{trip_code}} was cancelled. Reason: {{reason}}', 'normal'),
  ('payment_received', 'success', 'payment', 'Payment Received', 'Payment of {{amount}} received for trip #{{trip_code}}', 'normal'),
  ('payment_failed', 'error', 'payment', 'Payment Failed', 'Payment failed for trip #{{trip_code}}. Error: {{error}}', 'high'),
  ('low_driver_availability', 'warning', 'dispatch', 'Low Driver Availability', 'Only {{count}} drivers available in {{service_area}}', 'high'),
  ('high_demand_alert', 'alert', 'dispatch', 'High Demand Alert', 'High demand detected in {{service_area}}. Consider surge pricing.', 'high'),
  ('system_maintenance', 'info', 'maintenance', 'Scheduled Maintenance', 'System maintenance scheduled for {{datetime}}', 'normal'),
  ('security_alert', 'error', 'security', 'Security Alert', '{{message}}', 'urgent'),
  ('new_driver_signup', 'info', 'driver', 'New Driver Signup', '{{driver_name}} has signed up and is pending approval', 'normal'),
  ('document_expiring', 'warning', 'driver', 'Document Expiring', '{{driver_name}}''s {{document_type}} expires on {{expiry_date}}', 'high');

-- Create function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_notification_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers
CREATE TRIGGER update_notifications_updated_at
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION update_notification_updated_at();

CREATE TRIGGER update_notification_templates_updated_at
  BEFORE UPDATE ON public.notification_templates
  FOR EACH ROW EXECUTE FUNCTION update_notification_updated_at();

CREATE TRIGGER update_notification_settings_updated_at
  BEFORE UPDATE ON public.notification_settings
  FOR EACH ROW EXECUTE FUNCTION update_notification_updated_at();