-- Remove rider feedback whose rider no longer exists (hard-deleted riders leave orphans
-- that inflate the Rider Feedback counter), then enforce the link so it cannot recur.
DELETE FROM public.rider_feedback f
WHERE f.customer_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = f.customer_id);

ALTER TABLE public.rider_feedback
  ADD CONSTRAINT rider_feedback_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;