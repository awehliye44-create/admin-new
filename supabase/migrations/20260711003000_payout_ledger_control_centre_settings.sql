-- Payout Ledger control-centre settings keys (idempotent).
-- admin_settings.setting_value is jsonb.
INSERT INTO public.admin_settings (setting_key, setting_value)
VALUES
  ('payout_frequency', '"weekly"'::jsonb),
  ('payout_processing_time', '"10:00"'::jsonb),
  ('payout_min_pence', '0'::jsonb),
  ('payout_max_pence', '""'::jsonb),
  ('payout_rule_negative_wallet', '"block"'::jsonb),
  ('payout_rule_pending_disputes', '"hold"'::jsonb),
  ('payout_rule_pending_chargebacks', '"block"'::jsonb),
  ('payout_rule_manual_review', '"hold"'::jsonb),
  ('payout_rule_suspended_driver', '"block"'::jsonb),
  ('payout_rule_expired_documents', '"hold"'::jsonb),
  ('early_cashout_min_pence', '500'::jsonb),
  ('early_cashout_max_pence', '""'::jsonb),
  ('early_cashout_max_per_day', '1'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;
