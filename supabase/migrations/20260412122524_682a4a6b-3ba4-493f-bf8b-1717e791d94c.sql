
UPDATE public.global_sequences
SET current_value = 0, updated_at = now()
WHERE sequence_type = 'customer';
