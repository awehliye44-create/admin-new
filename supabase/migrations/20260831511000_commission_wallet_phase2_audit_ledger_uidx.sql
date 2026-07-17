-- Phase 2 harden: one audit row per ledger credit entry (idempotent backfill safe).
CREATE UNIQUE INDEX IF NOT EXISTS commission_wallet_admin_audit_ledger_uidx
  ON public.commission_wallet_admin_audit (ledger_entry_id)
  WHERE ledger_entry_id IS NOT NULL;
