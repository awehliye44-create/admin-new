#!/usr/bin/env bash
# Clean-tree gate for Admin web production publish from admin-new.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck source=lib/canonical-tree-publish-guard.sh
source "$(cd "$(dirname "$0")" && pwd)/lib/canonical-tree-publish-guard.sh"

canonical_publish_begin \
  --branch "${WEB_GIT_BRANCH:-main}" \
  --freeze-paths "src public package.json vite.config.ts index.html" \
  || exit 1

echo "ADMIN_WEB_PUBLISH_PREFLIGHT: HEAD=$CANONICAL_PUBLISH_SHA is clean and frozen."
echo "Proceed only with the approved Admin publish path for this exact revision."

canonical_publish_end || exit 1
