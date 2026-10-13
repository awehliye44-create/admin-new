#!/usr/bin/env bash
# Read-only: compare local migration files with production's recorded history.
#
#   scripts/check-migration-history-vs-prod.sh [VERSION ...]
#
# Lists versions recorded in production but absent locally (remote-only) and
# local files production has never recorded (local-only). Exits non-zero if any
# local-only version is not named on the command line, so a deploy can only
# apply the versions it intends to. Needs a linked project (supabase/.temp).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/supabase/migrations"

remote="$(
  supabase db query --linked --workdir "$ROOT" --output-format json \
    "select version from supabase_migrations.schema_migrations order by version" 2>/dev/null \
    | python3 -c 'import json,sys; r=sys.stdin.read(); d=json.loads(r[r.index("{"):r.rindex("}")+1]); print("\n".join(x["version"] for x in d["rows"]))'
)"
[[ -n "$remote" ]] || { echo "ERROR: could not read production migration history" >&2; exit 2; }

local_versions="$(
  find "$DIR" -maxdepth 1 -name '*.sql' -print0 | xargs -0 -n1 basename \
    | sed -n 's/^\([0-9]\{14\}\)_.*\.sql$/\1/p' | sort -u
)"

remote_only="$(comm -23 <(echo "$remote" | sort -u) <(echo "$local_versions"))"
local_only="$(comm -13 <(echo "$remote" | sort -u) <(echo "$local_versions"))"

echo "production versions: $(echo "$remote" | wc -l | tr -d ' ')  local files: $(echo "$local_versions" | wc -l | tr -d ' ')"
echo "remote-only (recorded in production, no local file):"
echo "${remote_only:-none}" | sed 's/^/  /'
echo "local-only (would be applied by a push):"
echo "${local_only:-none}" | sed 's/^/  /'

unexpected=""
for v in $local_only; do
  if [[ " $* " != *" $v "* ]]; then unexpected+="$v "; fi
done
if [[ -n "$unexpected" ]]; then
  echo "ERROR: unapproved local-only versions: $unexpected" >&2
  exit 1
fi
echo "OK: every local-only version was named explicitly"
