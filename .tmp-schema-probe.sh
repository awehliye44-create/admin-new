#!/usr/bin/env bash
# Read-only schema probe: distinguishes "column missing" (42703) from RLS/permission errors.
set -a; . ./.env; set +a
probe() {
  local table="$1" col="$2"
  local body
  body=$(curl -s "$SUPABASE_URL/rest/v1/$table?select=$col&limit=1" \
    -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H "Authorization: Bearer $SUPABASE_PUBLISHABLE_KEY")
  if echo "$body" | grep -q '42703'; then echo "  MISSING  $table.$col"
  else echo "  present  $table.$col"; fi
}
for spec in "$@"; do
  table="${spec%%:*}"; cols="${spec#*:}"
  echo "== $table"
  IFS=',' read -ra arr <<< "$cols"
  for c in "${arr[@]}"; do probe "$table" "$c"; done
done
