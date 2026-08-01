# Driver identity re-verification — local delivery report

**Date:** 2026-07-30  
**Scope:** Local authoring only. No migrations applied, no Edge deploy, no Veriff production webhook, no EAS publish/submit.

## Backend ownership

Authoritative workspace: **`/Users/admin/admin-new`**  
Recorded in: `docs/guides/DRIVER_IDENTITY_VERIFICATION_BACKEND_OWNERSHIP.md`

Identity migrations and Edges were **not** authored in `onecab-comfy-ride`, driver/customer native, or a restored `drive-hub-buddy` snapshot.

## Product decisions implemented

| Decision | Implementation |
|---|---|
| Veriff Selfie2Selfie | `veriffProvider.ts` + SE-enabled secrets (`VERIFF_*`) |
| SDK done ≠ approved | Decision mapping + Driver result screen wait on SSOT/webhook/reconcile |
| Trusted reference gate | `resolveTrustedReference.ts` — typed `IdentityReferenceResolution` |
| `IDENTITY_REFERENCE_UNAVAILABLE` | Returned by start Edge; app opens result variant, not Veriff |
| Provider-neutral adapter | Shared types/RPCs; Veriff shapes stay in adapter |
| Android minSdk 26 | `expo-build-properties` in driver `app.config.ts` |
| SDK package | `@veriff/react-native-sdk@13.2.0` (legacy-peer-deps for RN 0.86) |

## Phase checklist

### Phase 2 — Backend foundation
- [x] Ownership note
- [x] Provider-neutral types (`_shared/driverIdentity/types.ts`)
- [x] Additive migration `20260906120000_driver_identity_verification_ssot.sql`
- [x] RLS + Realtime publication
- [x] Service-area settings table
- [x] Webhook idempotency table (`driver_identity_provider_webhook_events`)

### Phase 3 — Veriff + reference
- [x] Veriff adapter (session, face-reference upload, GET decision, webhook verify)
- [x] Trusted reference resolver + quality/provenance gate
- [x] Edges: `start-driver-identity-verification`, `get-driver-identity-verification-status`, `driver-identity-provider-webhook`, `admin-request-driver-identity-verification`

### Phase 4 — Eligibility / dispatch
- [x] `assert_driver_presence_online_eligible` gate patch (migration)
- [x] `find-drivers` / `send-driver-notification` / `auto-dispatch` offer suppression
- [x] Active / stacked work deferral (gate codes + dispatch reject reasons)

### Phase 5 — Driver app
- [x] Three-screen workflow (prep / capture / result)
- [x] Veriff SDK launch from `verification.url`
- [x] Launch destination + deferral when accepted work exists
- [x] Realtime + polling via `useVerificationStatus`

### Phase 6 — Privacy
- [x] Capture-route privacy helpers
- [x] Managed privacy-policy sheet on prep screen

### Phase 7 — Tests / audit
- [x] Deno: decision mapping, dispatch gate, reference resolver
- [x] Jest: status mapping + destination routing
- [x] `.env.example` documents `VERIFF_*` secrets (commented; no live values)
- [x] This delivery report

## Staging enablement (not done — requires separate approval)

1. Apply migration to a **non-production** Supabase project.
2. Deploy the four identity Edges to that project only.
3. Set `VERIFF_API_KEY`, `VERIFF_SHARED_SECRET`, optional base/workflow IDs from the SE-enabled integration.
4. Point Veriff decision webhook at the staging webhook Edge (signed).
5. Insert service-area identity settings rows as needed.
6. Rebuild Driver **dev client / EAS** (not Expo Go) after minSdk 26 + Veriff native module — do not submit stores.

## Explicit non-actions (still in force)

- No production migration apply
- No production Edge deploy
- No production Veriff integration / live webhook
- No Admin Panel deploy
- No mobile app publish/submit
