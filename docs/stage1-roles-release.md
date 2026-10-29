# Stage 1 — Owner-only Roles & Permissions release notes

## Frontend rollback plan
- Roll back the published frontend only via Lovable version history to the build before Stage 1 (commit before `d9dc4f5f`).
- Do NOT revert Stage 1 database migrations. Server rules (`staff_has_action`, `staff_has_page_access`,
  `protect_owner_staff_profile`, `tr_block_non_delegable_*`) stay in force; an older frontend still works
  because it calls the same staff RPCs, and any non-owner attempt to manage roles is rejected server-side.

## Legacy failing tests (pre-existing, not caused by Stage 1)
Identical 21 failures on the pre-Stage-1 baseline (`d9dc4f5f~1`) and current HEAD. Not modified; to investigate separately:
- adminFinanceFourPageSSOT, demandZoneBookingSurgeLock, frNavigationSimplification, mapBounds,
  phase3Batch3bAdminFinancialRpcAuthzLock, phase3Batch3d1CriticalMoneyRpcExecuteLock,
  phase3PlatformCollectedCashInsertGuardLock, phaseA8B10FinanceAssertAndInternalExecuteLock,
  phaseA8B12IdentityHelperExecuteLock, phaseA8B13AForceDriverOfflineAuthzLock, phaseA8B20IsAdminAuthzLock,
  phaseA8B21LogCorporateAuditAuthzLock, phaseA8B26LostPropertyAdminUnreadCountAuthzLock,
  phaseA8B27LostPropertyRequireAdminPageGate, phaseA8B9OrphanEdgePostgresExecuteLock, presetFareOffersLock,
  tripHistoryArrival014, tripHistoryNoHardCapLock, tripHistoryNoShow015,
  tripHistoryTerminalOutcomeDisplaySSOT, tripInvoicePaymentStateSSOT
