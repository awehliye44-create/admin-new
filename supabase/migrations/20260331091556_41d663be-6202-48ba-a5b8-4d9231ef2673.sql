
-- ============================================================
-- PHASE C: Performance indexes for slow queries
-- Target: trips, trip_finance, driver_ledger, ops_alerts, 
--         app_performance_events, ops_logs
-- ============================================================

-- 1. TRIPS table — most queried table
-- Dashboard: filter by created_at + service_area_id + status
CREATE INDEX IF NOT EXISTS idx_trips_created_at ON trips (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_service_area_created ON trips (service_area_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips (status);
CREATE INDEX IF NOT EXISTS idx_trips_driver_status ON trips (driver_id, status);
CREATE INDEX IF NOT EXISTS idx_trips_financial_outcome ON trips (financial_outcome) WHERE financial_outcome IS NOT NULL;

-- 2. TRIP_FINANCE — money screens (payments, earnings, commission)
CREATE INDEX IF NOT EXISTS idx_trip_finance_trip_id ON trip_finance (trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_finance_driver_id ON trip_finance (driver_id);
CREATE INDEX IF NOT EXISTS idx_trip_finance_service_area ON trip_finance (service_area_id);
CREATE INDEX IF NOT EXISTS idx_trip_finance_settlement ON trip_finance (settlement_status);

-- 3. DRIVER_LEDGER — wallet, earnings, payout screens (CRITICAL for money)
CREATE INDEX IF NOT EXISTS idx_driver_ledger_driver_id ON driver_ledger (driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_ledger_trip_id ON driver_ledger (trip_id);
CREATE INDEX IF NOT EXISTS idx_driver_ledger_entry_type ON driver_ledger (entry_type);
CREATE INDEX IF NOT EXISTS idx_driver_ledger_driver_type ON driver_ledger (driver_id, entry_type);

-- 4. OPS_ALERTS — OpsIntelligence page
CREATE INDEX IF NOT EXISTS idx_ops_alerts_status_severity ON ops_alerts (status, severity);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_category ON ops_alerts (category);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_created ON ops_alerts (created_at DESC);

-- 5. OPS_LOGS — LogsExplorer (P95: 5802ms)
CREATE INDEX IF NOT EXISTS idx_ops_logs_created ON ops_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_logs_level ON ops_logs (level);
CREATE INDEX IF NOT EXISTS idx_ops_logs_source ON ops_logs (source);

-- 6. APP_PERFORMANCE_EVENTS — PerformanceTab queries
CREATE INDEX IF NOT EXISTS idx_perf_events_app_screen ON app_performance_events (app_name, screen_name);
CREATE INDEX IF NOT EXISTS idx_perf_events_created ON app_performance_events (created_at DESC);

-- 7. DRIVERS — frequently filtered
CREATE INDEX IF NOT EXISTS idx_drivers_approval ON drivers (approval_status);
CREATE INDEX IF NOT EXISTS idx_drivers_online ON drivers (is_online) WHERE is_online = true;

-- 8. DOCUMENTS — document management queries
CREATE INDEX IF NOT EXISTS idx_documents_driver ON documents (driver_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status);

-- 9. DISPATCH_CANDIDATES_LOG — dispatch debugging
CREATE INDEX IF NOT EXISTS idx_dispatch_log_trip ON dispatch_candidates_log (trip_id);
