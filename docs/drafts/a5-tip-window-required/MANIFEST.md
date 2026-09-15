# A5 package: tip window / tip money REQUIRED set

## Included (REQUIRED)
- `20261109510000` tip_window columns
- `20261109560000` tip column write lock
- `20261109580000` tip refund reverses captured tip
- `20261109590000` retire legacy completion tip triggers
- `20261109600000` final has_work (session_order)

## Excluded on purpose
- `095200`–`095500`, `095700` — SUPERSEDED incremental has_work bodies
- FM passthrough / WhatsApp phone — separate workstreams
- Do not apply without Ahmed approval / schema_migrations preflight
