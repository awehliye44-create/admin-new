#!/usr/bin/env python3
"""Compare a deployed Edge Function with a local supabase/functions tree.

    scripts/verify-edge-function-against-tree.py <get_edge_function.json> <functions_root>

<get_edge_function.json> is the Management API / MCP get_edge_function response.
Every deployed file must exist locally with identical content. Files only in
the local tree are expected (the deployed bundle omits type-only modules).
Exit 0 on an exact match, 1 otherwise.
"""
import json
import re
import sys
from pathlib import Path

dump, root = Path(sys.argv[1]), Path(sys.argv[2])
raw = dump.read_text()
data = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
if isinstance(data.get("result"), str):
    data = json.loads(data["result"])

print(f"version {data.get('version')} verify_jwt {data.get('verify_jwt')} import_map {data.get('import_map')}")
missing, differ = [], []
for f in data["files"]:
    rel = re.sub(r"^(supabase/)?functions/", "", re.sub(r"^.*?/source/", "", f["name"]))
    local = root / rel
    if not local.exists():
        missing.append(rel)
    elif local.read_text() != f["content"]:
        differ.append(rel)

print(f"deployed files {len(data['files'])}  missing locally {missing}  content differs {differ}")
sys.exit(0 if not missing and not differ else 1)
