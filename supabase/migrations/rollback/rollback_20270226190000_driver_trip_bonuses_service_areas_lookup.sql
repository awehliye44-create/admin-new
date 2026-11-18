-- Remove driver-trip-bonuses from service_areas lookup allowlist.

CREATE OR REPLACE FUNCTION public._admin_service_areas_lookup_page_allowed(p_page_slug text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT lower(p_page_slug) = ANY (ARRAY[
    'dashboard','drivers','services','regions','fleet-tracking','active-trips',
    'scheduled-rides','missed-cancelled','trip-history','manual-trip','dispatch',
    'dispatch-metrics','driver-demand-zones','staff-work-patterns',
    'document-management','documents',
    'service-area-pricing','fare-simulator','custom-zones','zone-pricing','offers','promo-codes',
    'corporate-accounts','account-requests','corporate-billing','corporate-reports',
    'corporate-settings','corporate-fares',
    'payment-sessions','financial-reconciliation','driver-wallet-ledger','commission-wallet',
    'payout-ledger','invoices','statement-runs','invoice-templates','annual-taxi-report',
    'onecab-revenue-profit','lost-property','notifications','roles','disputes',
    'auto-dispatch'
  ]);
$fn$;
