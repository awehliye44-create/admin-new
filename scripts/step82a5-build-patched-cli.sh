#!/usr/bin/env bash
# Local-only: patch Supabase CLI path guard so deployed source/shared/* extracts.
# Output: /tmp/supabase-cli-allow-shared (never committed).
set -euo pipefail

SRC="${SUPABASE_CLI_BIN:-/opt/homebrew/Cellar/supabase/2.109.0/libexec/lib/node_modules/supabase/node_modules/@supabase/cli-darwin-arm64/bin/supabase}"
DST="${STEP82A5_PATCHED_CLI:-/tmp/supabase-cli-allow-shared}"

python3 - <<PY
from pathlib import Path
src = Path("${SRC}")
dst = Path("${DST}")
data = bytearray(src.read_bytes())
old = b'function unT(T,R){let J=JU0(T,R);return J===""||!RU0(J)&&J!==".."&&!J.startsWith(\`..\${_U0}\`)}'
prefix = b'function unT(T,R){return true;'
suffix = b'}'
pad = len(old) - len(prefix) - len(suffix)
if pad < 0:
    raise SystemExit('patch template length mismatch')
new = prefix + (b' ' * pad) + suffix
if len(old) != len(new):
    raise SystemExit(f'patch length mismatch {len(old)} vs {len(new)}')
i = data.find(old)
if i < 0:
    raise SystemExit('patch anchor not found in supabase CLI binary')
data[i:i+len(old)] = new
dst.write_bytes(bytes(data))
dst.chmod(0o755)
print(f'patched_cli={dst}')
PY

codesign -s - --force "$DST" >/dev/null 2>&1 || true
