
-- 1. Delete push tokens for customer user_ids
DELETE FROM public.customer_push_tokens
WHERE user_id IN (SELECT user_id FROM public.customers);

-- 2. Delete all customers (cascades to customer_wallets → customer_wallet_ledger;
--    SET NULL on support_conversations, passenger_ratings, call_masking_sessions)
DELETE FROM public.customers;
