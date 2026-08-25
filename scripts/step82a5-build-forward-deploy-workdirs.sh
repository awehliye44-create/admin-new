#!/usr/bin/env bash
# Step 8.2A.5 forward workdirs — delegates to Step 8.2B3.1 recursive closure builder.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "$REPO/scripts/step82b31-build-forward-workdirs.sh"
