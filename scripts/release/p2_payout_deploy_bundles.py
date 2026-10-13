#!/usr/bin/env python3
"""Build P2 payout reliability deploy bundles as "live snapshot + P2 overlay".

Same contract as p1_security_deploy_bundles.py, plus one extra guard: every
overlay file must be byte-identical on live to the P2 base commit, so the
overlay ships exactly the P2 diff and nothing else.

  python3 scripts/release/p2_payout_deploy_bundles.py --live /tmp/p2-live --out /tmp/p2-deploy
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from p1_security_deploy_bundles import files_under  # noqa: E402

STATEMENT_RE = re.compile(
    r"""(?P<stmt>(?:import|export)\s+(?P<type>type\s+)?[^;'"]*?from\s*['"](?P<a>\.{1,2}/[^'"]+)['"])"""
    r"""|import\s*\(\s*['"](?P<b>\.{1,2}/[^'"]+)['"]\s*\)"""
    r"""|import\s+['"](?P<c>\.{1,2}/[^'"]+)['"]""",
    re.S,
)


def unresolved_value_imports(root: str, entry: str) -> tuple[list[str], list[str]]:
    """Walk value imports only. Missing type-only targets are erased at deploy
    (the CLI download omits them too); a missing value import is fatal."""
    seen, stack, missing_value, missing_type = set(), [entry], [], set()
    while stack:
        rel = stack.pop()
        if rel in seen:
            continue
        seen.add(rel)
        src = open(os.path.join(root, rel), encoding="utf-8").read()
        for m in STATEMENT_RE.finditer(src):
            target = m.group("a") or m.group("b") or m.group("c")
            dep = os.path.normpath(os.path.join(os.path.dirname(rel), target))
            exists = os.path.exists(os.path.join(root, dep))
            if m.group("a") and m.group("type"):
                if not exists:
                    missing_type.add(dep)
                continue
            if not exists:
                missing_value.append(f"{rel} -> {dep}")
                continue
            stack.append(dep)
    return missing_value, sorted(missing_type)

P2_COMMIT = "be107023"

FUNCTIONS = {
    "admin-execute-weekly-payout-occurrence": [
        "admin-execute-weekly-payout-occurrence/index.ts",
        "_shared/driverPayoutSubmissionSSOT.ts",
        "_shared/weeklyDriverPayoutBatchWorkflowSSOT.ts",
        "_shared/weeklyPayoutOrchestratorSSOT.ts",
    ],
    "admin-weekly-payout-scheduler": [
        "admin-weekly-payout-scheduler/index.ts",
        "_shared/weeklyDriverPayoutBatchWorkflowSSOT.ts",
    ],
    "driver-withdraw": [
        "driver-withdraw/index.ts",
        "_shared/driverPayoutSubmissionSSOT.ts",
    ],
    "admin-submit-driver-payout-payment": [
        "admin-submit-driver-payout-payment/index.ts",
        "_shared/driverPayoutSubmissionSSOT.ts",
    ],
}


def base_bytes(repo: str, rel: str) -> bytes | None:
    try:
        return subprocess.check_output(
            ["git", "-C", repo, "show", f"{P2_COMMIT}^:supabase/functions/{rel}"],
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))
    args = ap.parse_args()

    ok = True
    for fn, overlay in FUNCTIONS.items():
        live = os.path.join(args.live, fn)
        out = os.path.join(args.out, fn)
        if not os.path.isdir(os.path.join(live, "supabase/functions", fn)):
            print(f"[{fn}] missing live snapshot at {live}")
            ok = False
            continue

        for rel in overlay:
            live_path = os.path.join(live, "supabase/functions", rel)
            live_src = open(live_path, "rb").read() if os.path.exists(live_path) else None
            if live_src != base_bytes(args.repo, rel):
                print(f"[{fn}] LIVE != P2 BASE for {rel}; overlay would ship unrelated changes")
                ok = False

        if os.path.exists(out):
            shutil.rmtree(out)
        shutil.copytree(live, out, symlinks=False, ignore=shutil.ignore_patterns("err.txt", "node_modules"))
        shutil.copy2(os.path.join(args.repo, "supabase/functions/deno.json"), os.path.join(out, "supabase/functions/deno.json"))
        for rel in overlay:
            shutil.copy2(os.path.join(args.repo, "supabase/functions", rel), os.path.join(out, "supabase/functions", rel))

        missing, type_only = unresolved_value_imports(out, f"supabase/functions/{fn}/index.ts")
        before = files_under(os.path.join(live, "supabase"))
        after = files_under(os.path.join(out, "supabase"))
        changed = sorted(k for k in after if before.get(k) != after[k] and not k.endswith("deno.json"))
        drift = [k for k in changed if k.removeprefix("functions/") not in overlay]
        print(f"[{fn}] changed={[k.removeprefix('functions/') for k in changed]}")
        if type_only:
            print(f"    type-only imports absent (erased at deploy, same as live): {type_only}")
        if missing:
            print(f"    UNRESOLVED value imports: {missing}")
            ok = False
        if drift:
            print(f"    UNEXPECTED drift outside overlay: {drift}")
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
