## Fix pre-existing typecheck build errors (batch 2026-09-02)

- [x] Fix pre-existing typecheck build errors (2026-09-03)

## Telemetry outage isolation

- [x] Make browser telemetry non-blocking during Supabase/Cloudflare outages
- [x] Sanitize telemetry storage failures without exposing upstream HTML
- [x] Verify focused tests, typecheck, and preview build

## Driver preset offer access

- [x] Verify and restore trip-specific access for the offered driver without exposing unrelated trips
- [x] Test authorization and negotiation gates; resolve the selected monitoring finding
- [ ] Deploy the corrected offer service — blocked by the existing 5.3 MB shared-code upload exceeding the 4.5 MB limit
