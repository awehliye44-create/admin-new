#!/usr/bin/env bash
# =============================================================================
# #93E — Mandatory pending-entitlement deploy contract (safe / non-monetary).
#
# Verifies against a LOCAL or explicitly targeted DB:
#   - credit_trip_earning_pending exists with exact signature
#   - financial_model::text cast present (MK-261126-003)
#   - service_role EXECUTE grant
#   - unique indexes + type check
#   - assert_credit_trip_earning_pending_contract() probe → trip_not_found
#
# Never inserts fabricated financial ledger rows.
#
#   DB_URL=postgresql://... bash scripts/verify-pending-entitlement-deploy-contract.sh
#   ALLOW_REMOTE=1 DB_URL=postgresql://...  # required for non-local
# =============================================================================
set -euo pipefail
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

DB_URL="${DB_URL:?DB_URL required}"
case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*|*@127.0.0.1/*|*@localhost/*) ;;
  *)
    if [ "${ALLOW_REMOTE:-}" != "1" ]; then
      echo "REFUSING remote DB_URL without ALLOW_REMOTE=1" >&2
      exit 2
    fi
    ;;
esac

psql "$DB_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT public.assert_credit_trip_earning_pending_contract();

DO $$
DECLARE
  def text := pg_get_functiondef(
    'public.credit_trip_earning_pending(uuid,uuid,integer,text,text)'::regprocedure
  );
BEGIN
  IF position('financial_model::text' in def) = 0 THEN
    RAISE EXCEPTION 'deploy contract: missing financial_model::text cast';
  END IF;
  IF position('SECURITY DEFINER' in def) = 0 THEN
    RAISE EXCEPTION 'deploy contract: expected SECURITY DEFINER';
  END IF;
END $$;

SELECT 'PENDING_ENTITLEMENT_DEPLOY_CONTRACT_OK' AS status;
SQL
