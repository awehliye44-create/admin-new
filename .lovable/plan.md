# Make telemetry outages non-blocking

## Goal
Prevent a temporary Supabase/Cloudflare timeout from surfacing as an application runtime error or blank screen while preserving best-effort performance reporting.

## Changes
- Harden the browser telemetry sender with a short timeout, explicit response handling, and a cooldown circuit breaker for transient 5xx/522 failures.
- Keep failed telemetry disposable rather than retrying and adding load during an outage.
- Harden `ingest-telemetry` so database/gateway failures return a sanitized no-op success instead of raw upstream HTML or a 500.
- Preserve validation responses for invalid methods, oversized payloads, and rate limits.
- Add focused deterministic tests for transient outage handling and sanitized responses.

## Verification
- Run focused telemetry tests and the frontend typecheck.
- Check the preview build result and telemetry function logs.
- Do not deploy or modify production data.
