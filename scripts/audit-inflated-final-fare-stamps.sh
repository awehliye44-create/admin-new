#!/usr/bin/env bash
# Read-only audit: trips whose final_fare_pence stamps look like force-complete double-count.
# Does not mutate data. Requires linked Supabase project (supabase link).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SQL="SELECT trip_code, status, final_customer_fare_pence, final_fare_pence, locked_base_fare_pence, customer_modification_charge_pence, gross_fare_pence, completed_at FROM trips WHERE customer_modification_charge_pence IS NOT NULL AND customer_modification_charge_pence <> 0 AND final_customer_fare_pence IS NOT NULL AND final_customer_fare_pence > 0 AND ((final_fare_pence IS NOT NULL AND final_fare_pence > final_customer_fare_pence + 50) OR (locked_base_fare_pence IS NOT NULL AND locked_base_fare_pence > 0 AND customer_modification_charge_pence > 0 AND final_customer_fare_pence >= locked_base_fare_pence + customer_modification_charge_pence + 50 AND COALESCE(gross_fare_pence, final_customer_fare_pence) <= final_customer_fare_pence)) ORDER BY completed_at DESC NULLS LAST LIMIT 50;"

echo "Auditing inflated final_fare_pence stamps (read-only)..."
out="$(supabase db query --linked "$SQL" 2>&1)" || {
  echo "WARN: audit query failed — run manually when linked: $SQL" >&2
  exit 0
}

if echo "$out" | grep -q '"rows": \[\]'; then
  echo "OK: no suspicious inflated final_fare_pence stamps found (sample heuristic)."
else
  echo "REVIEW REQUIRED — suspicious stamps:"
  echo "$out"
fi
