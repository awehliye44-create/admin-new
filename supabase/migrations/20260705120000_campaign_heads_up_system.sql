-- Campaign / Celebration Heads-Up (System B) — separate from operational trip heads-up (System A).

CREATE TABLE IF NOT EXISTS public.campaign_heads_up_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  category text NOT NULL CHECK (category IN ('sports', 'religious', 'celebration', 'promotion', 'announcement')),
  name text NOT NULL,
  title text NOT NULL,
  subtitle text NOT NULL,
  emoji text,
  accent_color text NOT NULL DEFAULT 'blue',
  gradient_from text NOT NULL DEFAULT '#1e3a8a',
  gradient_to text NOT NULL DEFAULT '#3b82f6',
  background_image_url text,
  cta_label text,
  cta_url text,
  deep_link text,
  default_target_app text NOT NULL DEFAULT 'customer' CHECK (default_target_app IN ('customer', 'driver', 'both')),
  default_priority text NOT NULL DEFAULT 'normal',
  supported_languages jsonb NOT NULL DEFAULT '["en"]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.campaign_heads_up_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid REFERENCES public.campaign_heads_up_templates(id) ON DELETE SET NULL,
  template_slug text,
  category text NOT NULL,
  title text NOT NULL,
  subtitle text NOT NULL,
  emoji text,
  accent_color text NOT NULL DEFAULT 'blue',
  gradient_from text NOT NULL DEFAULT '#1e3a8a',
  gradient_to text NOT NULL DEFAULT '#3b82f6',
  background_image_url text,
  cta_label text,
  cta_url text,
  deep_link text,
  target_scope text NOT NULL DEFAULT 'global' CHECK (target_scope IN ('global', 'region', 'service_area', 'users')),
  target_app text NOT NULL DEFAULT 'customer' CHECK (target_app IN ('customer', 'driver', 'both')),
  target_region_id uuid REFERENCES public.regions(id) ON DELETE SET NULL,
  target_service_area_id uuid REFERENCES public.service_areas(id) ON DELETE SET NULL,
  target_user_segment text,
  target_user_ids uuid[],
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  schedule_mode text NOT NULL DEFAULT 'instant' CHECK (schedule_mode IN ('instant', 'scheduled', 'repeat_yearly', 'repeat_monthly')),
  scheduled_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'expired')),
  languages jsonb NOT NULL DEFAULT '["en"]'::jsonb,
  sent_count int NOT NULL DEFAULT 0,
  delivered_count int NOT NULL DEFAULT 0,
  opened_count int NOT NULL DEFAULT 0,
  dismissed_count int NOT NULL DEFAULT 0,
  tapped_count int NOT NULL DEFAULT 0,
  failed_count int NOT NULL DEFAULT 0,
  created_by uuid,
  sent_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.campaign_heads_up_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaign_heads_up_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_app text NOT NULL CHECK (user_app IN ('customer', 'driver')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'opened', 'dismissed', 'tapped', 'failed')),
  delivered_at timestamptz,
  opened_at timestamptz,
  dismissed_at timestamptz,
  tapped_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, user_id, user_app)
);

CREATE INDEX IF NOT EXISTS idx_campaign_heads_up_campaigns_status ON public.campaign_heads_up_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaign_heads_up_campaigns_scheduled_at ON public.campaign_heads_up_campaigns(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_campaign_heads_up_deliveries_campaign ON public.campaign_heads_up_deliveries(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_heads_up_deliveries_user ON public.campaign_heads_up_deliveries(user_id);

ALTER TABLE public.campaign_heads_up_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_heads_up_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_heads_up_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff read campaign templates"
  ON public.campaign_heads_up_templates FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Staff manage campaign templates"
  ON public.campaign_heads_up_templates FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Staff read campaigns"
  ON public.campaign_heads_up_campaigns FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Staff manage campaigns"
  ON public.campaign_heads_up_campaigns FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users read own campaign deliveries"
  ON public.campaign_heads_up_deliveries FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Staff read all campaign deliveries"
  ON public.campaign_heads_up_deliveries FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users update own campaign deliveries"
  ON public.campaign_heads_up_deliveries FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.bump_campaign_heads_up_delivery_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.campaign_heads_up_campaigns
    SET
      delivered_count = delivered_count + CASE WHEN NEW.status = 'delivered' AND OLD.status <> 'delivered' THEN 1 ELSE 0 END,
      opened_count = opened_count + CASE WHEN NEW.status = 'opened' AND OLD.status <> 'opened' THEN 1 ELSE 0 END,
      dismissed_count = dismissed_count + CASE WHEN NEW.status = 'dismissed' AND OLD.status <> 'dismissed' THEN 1 ELSE 0 END,
      tapped_count = tapped_count + CASE WHEN NEW.status = 'tapped' AND OLD.status <> 'tapped' THEN 1 ELSE 0 END,
      failed_count = failed_count + CASE WHEN NEW.status = 'failed' AND OLD.status <> 'failed' THEN 1 ELSE 0 END,
      updated_at = now()
    WHERE id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_campaign_heads_up_delivery_counts ON public.campaign_heads_up_deliveries;
CREATE TRIGGER trg_bump_campaign_heads_up_delivery_counts
  AFTER UPDATE OF status ON public.campaign_heads_up_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_campaign_heads_up_delivery_counts();

INSERT INTO public.campaign_heads_up_templates (
  slug, category, name, title, subtitle, emoji, accent_color, gradient_from, gradient_to,
  cta_label, cta_url, deep_link, default_target_app
) VALUES
  ('champions_league_final', 'sports', 'Champions League Final', 'UEFA Champions League Final! ⚽🏆', 'The ultimate showdown is here! Don''t miss the UCL Final this weekend.', '⚽', 'blue', '#1e3a8a', '#3b82f6', 'See Details', '/promotions/champions-league', '/promotions/champions-league', 'customer'),
  ('europa_league_final', 'sports', 'Europa League Final', 'Europa League Final ⚽', 'Catch every moment of the Europa League Final.', '⚽', 'orange', '#c2410c', '#fb923c', NULL, NULL, NULL, 'customer'),
  ('conference_league_final', 'sports', 'Conference League Final', 'Conference League Final ⚽', 'The Conference League Final is here!', '⚽', 'green', '#166534', '#4ade80', NULL, NULL, NULL, 'customer'),
  ('uefa_euro', 'sports', 'UEFA Euro', 'UEFA Euro 🏆', 'Europe''s finest compete — enjoy the tournament with ONECAB.', '🏆', 'blue', '#1e40af', '#60a5fa', NULL, NULL, NULL, 'customer'),
  ('fifa_world_cup', 'sports', 'FIFA World Cup', 'FIFA World Cup 2026 🌍⚽', 'The world''s biggest tournament — ride with ONECAB.', '🌍', 'red', '#991b1b', '#f87171', 'Explore', '/promotions/world-cup', '/promotions/world-cup', 'both'),
  ('afcon', 'sports', 'AFCON', 'AFCON 🦁⚽', 'Africa''s top teams battle it out — celebrate with ONECAB.', '🦁', 'green', '#14532d', '#22c55e', NULL, NULL, NULL, 'both'),
  ('premier_league_final_day', 'sports', 'Premier League Final Day', 'Premier League Final Day ⚽', 'Title deciders and drama — plan your rides ahead.', '⚽', 'purple', '#581c87', '#a855f7', NULL, NULL, NULL, 'customer'),
  ('fa_cup_final', 'sports', 'FA Cup Final', 'FA Cup Final 🏆', 'Wembley awaits — get there with ONECAB.', '🏆', 'red', '#7f1d1d', '#ef4444', NULL, NULL, NULL, 'customer'),
  ('carabao_cup_final', 'sports', 'Carabao Cup Final', 'Carabao Cup Final ⚽', 'League Cup glory — ride to the match.', '⚽', 'green', '#065f46', '#34d399', NULL, NULL, NULL, 'customer'),
  ('copa_america', 'sports', 'Copa America', 'Copa America 🏆', 'South America''s finest — celebrate every goal.', '🏆', 'blue', '#1d4ed8', '#93c5fd', NULL, NULL, NULL, 'both'),
  ('olympic_games', 'sports', 'Olympic Games', 'Olympic Games 🥇', 'The world unites — ride to every event.', '🥇', 'yellow', '#a16207', '#fde047', NULL, NULL, NULL, 'both'),
  ('ramadan_mubarak', 'religious', 'Ramadan Mubarak', 'Ramadan Mubarak 🌙', 'Wishing you a blessed and peaceful Ramadan.', '🌙', 'purple', '#4c1d95', '#c4b5fd', NULL, NULL, NULL, 'both'),
  ('eid_mubarak', 'religious', 'Eid Mubarak', 'Eid Mubarak 🕌✨', 'Wishing you joy, peace, and blessings this Eid.', '🕌', 'green', '#166534', '#86efac', NULL, NULL, NULL, 'both'),
  ('eid_al_adha', 'religious', 'Eid Al Adha', 'Eid Al Adha 🕌', 'Warm wishes on this blessed occasion.', '🕌', 'green', '#14532d', '#4ade80', NULL, NULL, NULL, 'both'),
  ('christmas', 'religious', 'Christmas', 'Merry Christmas 🎄', 'Warm wishes for a joyful Christmas season.', '🎄', 'red', '#991b1b', '#fca5a5', NULL, NULL, NULL, 'both'),
  ('easter', 'religious', 'Easter', 'Happy Easter 🐣', 'Wishing you peace and joy this Easter.', '🐣', 'yellow', '#ca8a04', '#fef08a', NULL, NULL, NULL, 'both'),
  ('diwali', 'religious', 'Diwali', 'Happy Diwali 🪔', 'May the festival of lights bring prosperity.', '🪔', 'orange', '#c2410c', '#fdba74', NULL, NULL, NULL, 'both'),
  ('lunar_new_year', 'religious', 'Lunar New Year', 'Happy Lunar New Year 🧧', 'Gong Xi Fa Cai — prosperity and good fortune!', '🧧', 'red', '#b91c1c', '#fecaca', NULL, NULL, NULL, 'both'),
  ('happy_new_year', 'celebration', 'Happy New Year', 'Happy New Year 🎆', 'Cheers to new beginnings with ONECAB!', '🎆', 'purple', '#581c87', '#d8b4fe', NULL, NULL, NULL, 'both'),
  ('welcome_onecab', 'celebration', 'Welcome to ONECAB', 'Welcome to ONECAB 🚖', 'Your premium ride experience starts here.', '🚖', 'blue', '#1e3a8a', '#60a5fa', NULL, NULL, NULL, 'both'),
  ('anniversary', 'celebration', 'Anniversary', 'ONECAB Anniversary 🎉', 'Celebrating another year of rides together.', '🎉', 'pink', '#9d174d', '#f9a8d4', NULL, NULL, NULL, 'both'),
  ('regional_launch', 'celebration', 'Regional Launch', 'ONECAB is here! 🚀', 'Premium rides now available in your city.', '🚀', 'green', '#166534', '#6ee7b7', NULL, NULL, NULL, 'both'),
  ('airport_discount', 'promotion', 'Airport Discount', 'Airport rides — save today ✈️', 'Special airport transfer discount for a limited time.', '✈️', 'blue', '#1e40af', '#93c5fd', 'Book Now', '/book-ride', '/book-ride', 'customer'),
  ('weekend_sale', 'promotion', 'Weekend Sale', 'Weekend Sale 🎉', 'Save on rides this weekend only.', '🎉', 'pink', '#be185d', '#fbcfe8', 'Ride Now', '/book-ride', '/book-ride', 'customer'),
  ('invite_friends', 'promotion', 'Invite Friends', 'Invite friends, earn rewards 🎁', 'Share ONECAB and both of you save.', '🎁', 'purple', '#6b21a8', '#d8b4fe', 'Invite', '/referrals', '/referrals', 'customer'),
  ('promo_code', 'promotion', 'Promo Code', 'Use code SAVE20 🏷️', '20% off your next ride — limited time.', '🏷️', 'orange', '#c2410c', '#fdba74', 'Apply Code', '/book-ride', '/book-ride', 'customer'),
  ('cashback', 'promotion', 'Cashback', 'Earn cashback 💰', 'Get money back on eligible rides.', '💰', 'green', '#15803d', '#86efac', NULL, NULL, NULL, 'customer'),
  ('ride_and_save', 'promotion', 'Ride & Save', 'Ride & Save 🚗', 'The more you ride, the more you save.', '🚗', 'blue', '#1d4ed8', '#bfdbfe', NULL, NULL, NULL, 'customer'),
  ('app_update', 'announcement', 'App Update', 'App update available 📱', 'Update ONECAB for the latest features and fixes.', '📱', 'blue', '#1e3a8a', '#93c5fd', NULL, NULL, NULL, 'both'),
  ('new_feature', 'announcement', 'New Feature', 'New feature unlocked ✨', 'Discover what''s new in ONECAB.', '✨', 'purple', '#581c87', '#e9d5ff', NULL, NULL, NULL, 'both'),
  ('payment_method', 'announcement', 'Payment Method', 'New payment method 💳', 'Pay your way — a new option is now available.', '💳', 'green', '#166534', '#bbf7d0', NULL, NULL, NULL, 'both'),
  ('service_maintenance', 'announcement', 'Service Maintenance', 'Scheduled maintenance 🔧', 'Brief service window — rides may be limited.', '🔧', 'yellow', '#a16207', '#fef08a', NULL, NULL, NULL, 'both')
ON CONFLICT (slug) DO UPDATE SET
  category = EXCLUDED.category,
  name = EXCLUDED.name,
  title = EXCLUDED.title,
  subtitle = EXCLUDED.subtitle,
  emoji = EXCLUDED.emoji,
  accent_color = EXCLUDED.accent_color,
  gradient_from = EXCLUDED.gradient_from,
  gradient_to = EXCLUDED.gradient_to,
  cta_label = EXCLUDED.cta_label,
  cta_url = EXCLUDED.cta_url,
  deep_link = EXCLUDED.deep_link,
  default_target_app = EXCLUDED.default_target_app,
  updated_at = now();
