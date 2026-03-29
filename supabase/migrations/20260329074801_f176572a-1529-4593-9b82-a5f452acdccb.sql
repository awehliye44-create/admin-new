-- Backfill financial_outcome for completed trips that are missing it
UPDATE trips 
SET financial_outcome = 'COMPLETED'
WHERE status = 'completed' 
  AND financial_outcome IS NULL;