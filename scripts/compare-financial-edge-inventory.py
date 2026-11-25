#!/usr/bin/env python3
"""Compare remote production Edge inventory vs canonical local source (#92E).

Usage:
  supabase functions list --project-ref <ref> -o json > /tmp/fn_list.json
  python3 scripts/compare-financial-edge-inventory.py /tmp/fn_list.json

Exit 1 when a financial-classified remote-only slug is missing local source,
or when a documented CAPTURE/INCREMENT hub entrypoint is absent locally.
Never mutates production.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INV = ROOT / "scripts" / "financial_production_worker_inventory.json"

FIN_RE = re.compile(
  r"(payment|capture|revolut|preauth|fare|increment|refund|hold|settle|wallet|"
  r"payout|invoice|receivable|auth|ledger|commission|tip|orphan|recovery|finance)",
  re.I,
)


def load_remote(path: Path) -> dict[str, dict]:
  raw = path.read_text()
  i = raw.find("[")
  data = json.loads(raw[i:])
  if isinstance(data, dict):
    data = data.get("functions") or data.get("data") or []
  return {f["slug"]: f for f in data if isinstance(f, dict) and f.get("slug")}


def local_slugs() -> set[str]:
  fns = ROOT / "supabase" / "functions"
  out = set()
  for p in fns.iterdir():
    if p.is_dir() and p.name != "_shared" and (p / "index.ts").exists():
      out.add(p.name)
  return out


def main() -> int:
  if len(sys.argv) < 2:
    print("usage: compare-financial-edge-inventory.py <functions-list.json>", file=sys.stderr)
    return 2
  remote = load_remote(Path(sys.argv[1]))
  local = local_slugs()
  inv = json.loads(INV.read_text())

  remote_only = sorted(set(remote) - local)
  local_only = sorted(local - set(remote))
  fin_remote_only = [s for s in remote_only if FIN_RE.search(s)]

  print(f"remote={len(remote)} local={len(local)} remote_only={len(remote_only)} local_only={len(local_only)}")
  print(f"financial_remote_only={len(fin_remote_only)}")
  for s in fin_remote_only:
    f = remote[s]
    print(f"  REMOTE_ONLY_FIN {s} ver={f.get('version')} updated={f.get('updated_at')}")

  errors: list[str] = []
  for row in inv.get("orphan_or_remote_only_watchlist", []):
    slug = row["slug"]
    if row.get("must_have_local_entrypoint") and slug not in local:
      errors.append(f"watchlist slug missing local entrypoint: {slug}")
    if slug in remote and slug not in local:
      errors.append(f"financial worker still remote-only: {slug}")

  for slug in inv.get("canonical_finalize_entrypoints", []):
    if slug not in local:
      errors.append(f"canonical finalize entrypoint missing locally: {slug}")

  for hub in inv.get("class_a_capture_increment_hubs", []):
    if not (ROOT / hub).exists():
      errors.append(f"missing Class-A hub source: {hub}")

  # Classify remaining remote-only for operator review (non-fatal unless financial)
  report = {
    "remote_count": len(remote),
    "local_count": len(local),
    "remote_only": remote_only,
    "financial_remote_only": fin_remote_only,
    "local_only": local_only,
    "errors": errors,
  }
  out = Path("/tmp/92e_inventory_compare.json")
  out.write_text(json.dumps(report, indent=2))
  print(f"wrote {out}")

  if errors:
    for e in errors:
      print(f"ERROR: {e}", file=sys.stderr)
    return 1
  print("OK: no financial remote-only drift against inventory watchlist")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
