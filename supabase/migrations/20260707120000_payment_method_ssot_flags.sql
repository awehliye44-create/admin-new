-- Provider-neutral payment method SSOT flags per service area.
ALTER TABLE public.service_area_payment_methods
  ADD COLUMN IF NOT EXISTS saved_card_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mobile_wallet_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pay_by_bank_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.service_area_payment_methods.saved_card_enabled IS
  'When true, customers may save/tokenise payment methods via the area primary provider vault (Stripe, Revolut, mobile wallet).';

COMMENT ON COLUMN public.service_area_payment_methods.mobile_wallet_enabled IS
  'When true, Africa/mobile-wallet collection methods (EVC+, M-Pesa, etc.) are offered where the provider supports them.';

COMMENT ON COLUMN public.service_area_payment_methods.pay_by_bank_enabled IS
  'Optional pay-by-bank / open banking — off by default until provider adapter is live.';

-- Africa providers: enable mobile wallet toggle when catalog provider is selected.
UPDATE public.service_area_payment_methods sapm
SET mobile_wallet_enabled = true
FROM public.service_areas sa
WHERE sapm.service_area_id = sa.id
  AND sa.payment_provider IN ('sifalo_pay', 'intasend', 'waafi_pay', 'sahal_pay')
  AND sapm.mobile_wallet_enabled = false;
