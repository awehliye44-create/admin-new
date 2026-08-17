-- Commission Wallet explicit ONECAB subsidy when customer promotion exceeds gross commission.
-- Must run before 20260927180100_financial_model_isolation.sql.

ALTER TYPE public.commission_wallet_entry_type
  ADD VALUE IF NOT EXISTS 'COMMISSION_SUBSIDY_CREDIT';
