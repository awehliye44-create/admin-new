#!/usr/bin/env python3
"""Wrap one migration file so it applies at most once, under its own version.

    scripts/build-guarded-migration-apply.py supabase/migrations/<version>_<name>.sql > /tmp/apply.sql
    supabase db query --linked -f /tmp/apply.sql

The output is a single transaction: abort if the version is already recorded,
run the migration, then record it in supabase_migrations.schema_migrations with
the file's own version and full text (the convention production already uses).
schema_migrations.version is the primary key, so a duplicate can never commit.

Use this instead of the MCP apply_migration tool, which records the current
time as the version and makes a later `supabase db push` re-apply the file.
"""
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
m = re.fullmatch(r"(\d{14})_(.+)\.sql", path.name)
if not m:
    sys.exit(f"not a migration file name: {path.name}")
version, name = m.groups()
src = path.read_text()

tag = f"$MIGSRC{version}$"
if tag in src:
    sys.exit("dollar-quote tag collides with file content")

# A file that manages its own transaction is run inside ours instead.
lines = src.split("\n")
own = [i for i, line in enumerate(lines) if re.fullmatch(r"\s*(BEGIN|COMMIT)\s*;\s*", line, re.I)]
if own and len(own) != 2:
    sys.exit("file has an unexpected number of top-level BEGIN/COMMIT lines")
for i in own:
    lines[i] = "-- (outer transaction)"
body = "\n".join(lines)

sys.stdout.write(
    "BEGIN;\n"
    "DO $guard$ BEGIN\n"
    f"  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '{version}') THEN\n"
    f"    RAISE EXCEPTION 'migration {version} already recorded; refusing to re-apply';\n"
    "  END IF;\n"
    "END $guard$;\n"
    f"{body}\n;\n"
    "INSERT INTO supabase_migrations.schema_migrations (version, name, statements)\n"
    f"VALUES ('{version}', '{name}', ARRAY[{tag}{src}{tag}]);\n"
    "COMMIT;\n"
)
