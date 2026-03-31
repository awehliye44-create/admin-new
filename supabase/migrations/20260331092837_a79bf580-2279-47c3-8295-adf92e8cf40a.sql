-- Resolve the 2 critical performance alerts (root causes fixed)
UPDATE ops_alerts SET status = 'resolved', resolved_at = now() 
WHERE id IN ('1423bfc5-6e9d-4a9a-8028-850018982f4a', '57c4dddc-2555-48d3-a5c0-ff718838aa93');