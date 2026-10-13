#!/usr/bin/env python3
"""Build P1 security deploy bundles as "live snapshot + P1 overlay".

Each function is redeployed from its own live source with only the P1 files
replaced, so no unrelated drift between this branch and production ships with
the security release.

  python3 scripts/release/p1_security_deploy_bundles.py --live /tmp/p1-live --out /tmp/p1-deploy

--live must contain one directory per function holding the unbundled live
source (`supabase functions download <fn> --use-api` run inside <live>/<fn>; for
auto-dispatch, which imports ../../../shared/, extract the get_edge_function
payload into the same layout). Exits non-zero if any file outside the overlay
would change or any relative import fails to resolve.
"""
import argparse
import hashlib
import os
import re
import shutil
import sys

FUNCTIONS = {
    "late-cancellation-check": [
        "late-cancellation-check/index.ts",
        "_shared/lateCancellationCallerAuthSSOT.ts",
        "_shared/tripTerminalDispatch.ts",
        "_shared/internalAuth.ts",
        "_shared/edgeAuth.ts",
        "_shared/customerReceivableLifecycle.ts",
    ],
    "admin-trip-actions": [
        "admin-trip-actions/index.ts",
        "_shared/paymentProviders/types.ts",
        "_shared/revolutCustomers.ts",
        "_shared/revolutCitBrowserEnvironmentSSOT.ts",
    ],
    "record-financial-outcome": [
        "record-financial-outcome/index.ts",
        "_shared/financialOutcomeEntitlementGuardSSOT.ts",
    ],
    "auto-dispatch": [
        "auto-dispatch/index.ts",
        "_shared/tripTerminalDispatch.ts",
    ],
    "scheduled-dispatch": [
        "scheduled-dispatch/index.ts",
        "_shared/tripTerminalDispatch.ts",
        "_shared/supabaseClientTypes.ts",
    ],
    "decline-offer": [
        "decline-offer/index.ts",
        "_shared/tripTerminalDispatch.ts",
    ],
    "admin-cancel-trip-negotiation": [
        "admin-cancel-trip-negotiation/index.ts",
    ],
}

# Only allowed when the live snapshot does not already carry the file.
ADD_ONLY_IF_ABSENT = {
    "_shared/internalAuth.ts",
    "_shared/edgeAuth.ts",
    "_shared/customerReceivableLifecycle.ts",
    "_shared/paymentProviders/types.ts",
    "_shared/revolutCustomers.ts",
    "_shared/revolutCitBrowserEnvironmentSSOT.ts",
    "_shared/supabaseClientTypes.ts",
}

IMPORT_RE = re.compile(
    r"""(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}/[^'"]+)['"]"""
    r"""|import\s*\(\s*['"](\.{1,2}/[^'"]+)['"]\s*\)"""
    r"""|import\s+['"](\.{1,2}/[^'"]+)['"]""",
)


def sha(path: str) -> str:
    return hashlib.sha256(open(path, "rb").read()).hexdigest()[:16]


def unresolved_imports(root: str, entry: str) -> list[str]:
    seen, stack, missing = set(), [entry], []
    while stack:
        rel = stack.pop()
        if rel in seen:
            continue
        seen.add(rel)
        path = os.path.join(root, rel)
        if not os.path.exists(path):
            missing.append(rel)
            continue
        for m in IMPORT_RE.finditer(open(path, encoding="utf-8").read()):
            target = next(g for g in m.groups() if g)
            stack.append(os.path.normpath(os.path.join(os.path.dirname(rel), target)))
    return missing


def files_under(root: str) -> dict[str, str]:
    out = {}
    for d, _, names in os.walk(root):
        for n in names:
            p = os.path.join(d, n)
            out[os.path.relpath(p, root)] = sha(p)
    return out


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
        if os.path.exists(out):
            shutil.rmtree(out)
        shutil.copytree(live, out, symlinks=False, ignore=shutil.ignore_patterns("err.txt", "node_modules"))
        shutil.copy2(os.path.join(args.repo, "supabase/functions/deno.json"), os.path.join(out, "supabase/functions/deno.json"))

        changed = []
        for rel in overlay:
            dst = os.path.join(out, "supabase/functions", rel)
            if rel in ADD_ONLY_IF_ABSENT and os.path.exists(dst):
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(args.repo, "supabase/functions", rel), dst)
            changed.append(rel)

        missing = unresolved_imports(out, f"supabase/functions/{fn}/index.ts")
        before = files_under(os.path.join(live, "supabase"))
        after = files_under(os.path.join(out, "supabase"))
        drift = sorted(
            k for k in after
            if not k.endswith("deno.json") and before.get(k) != after[k]
            and k.removeprefix("functions/") not in overlay
        )
        print(f"[{fn}] overlay={changed}")
        for k in sorted(k for k in after if before.get(k) != after[k] and not k.endswith("deno.json")):
            print(f"    {k}  live={before.get(k, 'absent')}  bundle={after[k]}")
        if missing:
            print(f"    UNRESOLVED imports: {missing}")
            ok = False
        if drift:
            print(f"    UNEXPECTED drift outside overlay: {drift}")
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
