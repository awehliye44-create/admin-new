-- Step 8.2B1 — single-row READ-ONLY financial fingerprint (no writes)
SELECT jsonb_build_object(
  'driver_wallet_ledger', (
    SELECT jsonb_build_object(
      'row_count', count(*)::bigint,
      'amount_sum_pence', coalesce(sum(amount_pence), 0)::bigint,
      'max_created_at', coalesce(max(created_at)::text, ''),
      'content_md5', coalesce(md5(string_agg(
        id::text || '|' || type || '|' || coalesce(related_trip_id::text, '') || '|' ||
        amount_pence::text || '|' || coalesce(created_at::text, '') || '|' ||
        coalesce(description, ''),
        E'\n' ORDER BY id
      )), md5(''))
    ) FROM public.driver_wallet_ledger
  ),
  'refund_debit', (
    SELECT jsonb_build_object(
      'count', count(*)::bigint,
      'sum_pence', coalesce(sum(amount_pence), 0)::bigint,
      'affected_trip_ids_md5', coalesce(md5(string_agg(related_trip_id::text, ',' ORDER BY related_trip_id)), md5(''))
    ) FROM public.driver_wallet_ledger WHERE type = 'REFUND_DEBIT'
  ),
  'payment_session_refunds', (
    SELECT jsonb_build_object(
      'row_count', count(*)::bigint,
      'sum_pence', coalesce(sum(amount_pence), 0)::bigint,
      'content_md5', coalesce(md5(string_agg(
        id::text || '|' || coalesce(payment_provider, '') || '|' ||
        coalesce(provider_refund_id, '') || '|' || amount_pence::text,
        E'\n' ORDER BY id
      )), md5(''))
    ) FROM public.payment_session_refunds
  ),
  'payment_sessions', (
    SELECT jsonb_build_object(
      'row_count', count(*)::bigint,
      'max_updated_at', coalesce(max(updated_at)::text, '')
    ) FROM public.payment_sessions
  ),
  'trips', (
    SELECT jsonb_build_object(
      'row_count', count(*)::bigint,
      'max_updated_at', coalesce(max(updated_at)::text, '')
    ) FROM public.trips
  ),
  'payout_items', (
    SELECT jsonb_build_object(
      'row_count', count(*)::bigint,
      'net_sum_pence', coalesce(sum(net_driver_payout_pence), 0)::bigint
    ) FROM public.payout_items
  ),
  'payout_batches', (SELECT count(*)::bigint FROM public.payout_batches),
  'driver_payout_payment_intents', (SELECT count(*)::bigint FROM public.driver_payout_payment_intents),
  'driver_payout_reservations', (SELECT count(*)::bigint FROM public.driver_payout_reservations),
  'payout_item_ledger_allocations', (SELECT count(*)::bigint FROM public.payout_item_ledger_allocations),
  'financial_ssot_mismatches', (SELECT count(*)::bigint FROM public.financial_ssot_mismatches),
  'financial_ssot_repairs', (SELECT count(*)::bigint FROM public.financial_ssot_repairs),
  'driver_commission_wallet_accounts', (SELECT count(*)::bigint FROM public.driver_commission_wallet_accounts),
  'driver_commission_wallet_ledger', (
    SELECT jsonb_build_object(
      'row_count', count(*)::bigint,
      'amount_minor_sum', coalesce(sum(amount_minor), 0)::bigint
    ) FROM public.driver_commission_wallet_ledger
  )
) AS fingerprints;
