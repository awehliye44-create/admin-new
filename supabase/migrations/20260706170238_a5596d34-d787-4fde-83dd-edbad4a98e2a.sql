UPDATE public.payment_provider_configs SET is_primary = false WHERE is_primary = true;

UPDATE public.payment_provider_configs
SET environment = 'live',
    status = 'live',
    is_enabled = true,
    is_primary = true,
    supports_customer_payments = true,
    supports_driver_payouts = true,
    apple_pay_enabled = true,
    google_pay_enabled = true,
    last_error_message = NULL,
    updated_at = now()
WHERE provider = 'revolut';
