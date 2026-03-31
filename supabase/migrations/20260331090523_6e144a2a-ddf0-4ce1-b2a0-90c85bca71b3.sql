
-- Backfill 8 trips: update financial_outcome
UPDATE trips SET financial_outcome = 'COMPLETED'
WHERE id IN (
  'd52e0d2b-666b-4cef-b7af-2c3bf01c0c27','58e8e7ea-fb42-4a9c-8feb-6e5eee862fb7',
  '14b7521c-d15e-4d5f-8a52-7a173b836e38','4fae5f6c-2e4f-4e39-bb50-68d83db72ff3',
  '2e79fbd1-6953-4a33-a8ef-383a4134c190','ea5fa6d7-f3aa-4a2c-b95f-9e3f8a6fe831',
  '56ff48dd-2329-409a-af2f-169e073e43f9','6fa3d31e-ab0b-4655-9d76-e955a6de7dba'
) AND financial_outcome IS NULL;

-- Insert trip_finance records
INSERT INTO trip_finance (trip_id, driver_id, service_area_id, financial_status, revenue_type, is_financially_countable, base_fare_pence, pickup_waiting_charge_pence, stop_waiting_charge_pence, stop_modification_charge_pence, destination_change_charge_pence, extras_charge_pence, tip_amount_pence, commissionable_subtotal_pence, commission_rate_pct, platform_commission_pence, driver_net_before_tip_pence, driver_total_earnings_pence, final_trip_total_pence, payment_method, currency_code, settlement_status, settled_at)
VALUES
  ('d52e0d2b-666b-4cef-b7af-2c3bf01c0c27','d0d7cad6-5903-4910-9cad-96dcc3517918','dcd095fc-8847-491d-895a-c37443ae89c0','recognized','completed_trip_revenue',true,2826,0,0,0,0,0,0,2826,13,367,2459,2459,2826,'CASH','INR','settled','2026-03-30T08:59:44.681Z'),
  ('58e8e7ea-fb42-4a9c-8feb-6e5eee862fb7','d0d7cad6-5903-4910-9cad-96dcc3517918','dcd095fc-8847-491d-895a-c37443ae89c0','recognized','completed_trip_revenue',true,3966,0,0,0,0,0,0,3966,13,516,3450,3450,3966,'CASH','INR','settled','2026-03-30T09:29:25.655Z'),
  ('14b7521c-d15e-4d5f-8a52-7a173b836e38','d0d7cad6-5903-4910-9cad-96dcc3517918','dcd095fc-8847-491d-895a-c37443ae89c0','recognized','completed_trip_revenue',true,7042,0,0,0,0,0,0,7042,13,915,6127,6127,7042,'CASH','INR','settled','2026-03-30T08:18:53.709Z'),
  ('4fae5f6c-2e4f-4e39-bb50-68d83db72ff3','d0d7cad6-5903-4910-9cad-96dcc3517918','dcd095fc-8847-491d-895a-c37443ae89c0','recognized','completed_trip_revenue',true,3115,0,0,0,0,0,0,3115,13,405,2710,2710,3115,'CASH','INR','settled','2026-03-30T09:40:54.606Z'),
  ('2e79fbd1-6953-4a33-a8ef-383a4134c190','d0d7cad6-5903-4910-9cad-96dcc3517918','dcd095fc-8847-491d-895a-c37443ae89c0','recognized','completed_trip_revenue',true,3926,0,0,0,0,0,0,3926,13,510,3416,3416,3926,'CASH','INR','settled','2026-03-30T08:46:18.109Z'),
  ('ea5fa6d7-f3aa-4a2c-b95f-9e3f8a6fe831','d0d7cad6-5903-4910-9cad-96dcc3517918','dcd095fc-8847-491d-895a-c37443ae89c0','recognized','completed_trip_revenue',true,3926,0,0,0,0,0,0,3926,13,510,3416,3416,3926,'CASH','INR','settled','2026-03-30T09:11:44.485Z'),
  ('56ff48dd-2329-409a-af2f-169e073e43f9','d0d7cad6-5903-4910-9cad-96dcc3517918','dcd095fc-8847-491d-895a-c37443ae89c0','recognized','completed_trip_revenue',true,3702,0,0,0,0,0,0,3702,13,481,3221,3221,3702,'CASH','INR','settled','2026-03-30T11:04:26.747Z'),
  ('6fa3d31e-ab0b-4655-9d76-e955a6de7dba','d0d7cad6-5903-4910-9cad-96dcc3517918','dcd095fc-8847-491d-895a-c37443ae89c0','recognized','completed_trip_revenue',true,532,0,0,0,0,0,0,532,13,69,463,463,532,'CASH','INR','settled','2026-03-30T07:59:59.085Z')
ON CONFLICT DO NOTHING;

-- Insert CASH_COMMISSION_DEBT ledger entries
INSERT INTO driver_ledger (driver_id, trip_id, entry_type, amount_pence, currency_code, description) VALUES
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','d52e0d2b-666b-4cef-b7af-2c3bf01c0c27','CASH_COMMISSION_DEBT',-367,'INR','Commission owed from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','58e8e7ea-fb42-4a9c-8feb-6e5eee862fb7','CASH_COMMISSION_DEBT',-516,'INR','Commission owed from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','14b7521c-d15e-4d5f-8a52-7a173b836e38','CASH_COMMISSION_DEBT',-915,'INR','Commission owed from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','4fae5f6c-2e4f-4e39-bb50-68d83db72ff3','CASH_COMMISSION_DEBT',-405,'INR','Commission owed from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','2e79fbd1-6953-4a33-a8ef-383a4134c190','CASH_COMMISSION_DEBT',-510,'INR','Commission owed from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','ea5fa6d7-f3aa-4a2c-b95f-9e3f8a6fe831','CASH_COMMISSION_DEBT',-510,'INR','Commission owed from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','56ff48dd-2329-409a-af2f-169e073e43f9','CASH_COMMISSION_DEBT',-481,'INR','Commission owed from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','6fa3d31e-ab0b-4655-9d76-e955a6de7dba','CASH_COMMISSION_DEBT',-69,'INR','Commission owed from cash trip (backfill)');

-- Insert COMPANY_COMMISSION ledger entries
INSERT INTO driver_ledger (driver_id, trip_id, entry_type, amount_pence, currency_code, description) VALUES
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','d52e0d2b-666b-4cef-b7af-2c3bf01c0c27','COMPANY_COMMISSION',367,'INR','Platform commission from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','58e8e7ea-fb42-4a9c-8feb-6e5eee862fb7','COMPANY_COMMISSION',516,'INR','Platform commission from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','14b7521c-d15e-4d5f-8a52-7a173b836e38','COMPANY_COMMISSION',915,'INR','Platform commission from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','4fae5f6c-2e4f-4e39-bb50-68d83db72ff3','COMPANY_COMMISSION',405,'INR','Platform commission from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','2e79fbd1-6953-4a33-a8ef-383a4134c190','COMPANY_COMMISSION',510,'INR','Platform commission from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','ea5fa6d7-f3aa-4a2c-b95f-9e3f8a6fe831','COMPANY_COMMISSION',510,'INR','Platform commission from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','56ff48dd-2329-409a-af2f-169e073e43f9','COMPANY_COMMISSION',481,'INR','Platform commission from cash trip (backfill)'),
  ('d0d7cad6-5903-4910-9cad-96dcc3517918','6fa3d31e-ab0b-4655-9d76-e955a6de7dba','COMPANY_COMMISSION',69,'INR','Platform commission from cash trip (backfill)');

-- Resolve the alerts (resolved_by is UUID, set to NULL)
UPDATE ops_alerts SET 
  status = 'resolved',
  resolved_at = now(),
  resolved_by = NULL
WHERE severity = 'critical' 
  AND status = 'open'
  AND category IN ('commission', 'earning')
  AND related_trip_id IN (
    'd52e0d2b-666b-4cef-b7af-2c3bf01c0c27','58e8e7ea-fb42-4a9c-8feb-6e5eee862fb7',
    '14b7521c-d15e-4d5f-8a52-7a173b836e38','4fae5f6c-2e4f-4e39-bb50-68d83db72ff3',
    '2e79fbd1-6953-4a33-a8ef-383a4134c190','ea5fa6d7-f3aa-4a2c-b95f-9e3f8a6fe831',
    '56ff48dd-2329-409a-af2f-169e073e43f9','6fa3d31e-ab0b-4655-9d76-e955a6de7dba'
  );
