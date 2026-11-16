# Make backend fixes deployable again (unblocks the campaign send fix)

## What's wrong
- Sending a campaign to riders fails with "Cannot read properties of null (reading 'ok')". The code fix (removing the old duplicate permission check in `send-campaign-heads-up`) is already done, but it can't go live.
- Every backend function upload includes the whole shared folder. That folder is now 6.29 MB, and the upload limit is about 4.5 MB, so **no** backend function can be deployed. The same blocker is holding back the payout, preset offer, driver rating, corporate fare and reminder fixes.

## What I'll change
Make the shared folder smaller without changing how anything behaves:

1. **Move shared tests out of the upload** (87 files, 0.56 MB) into `supabase/tests/_shared/`. This location is already used for other backend tests. Their import paths get rewritten to point back to `supabase/functions/_shared/`.
2. **Move code used by only one function** (159 files, 1.26 MB) into that function's own folder (`<function>/lib/`). Every import that points at them gets rewritten: in that function, in the moved tests, in `src/`, `tests/` and `shared/` (including `@shared/...` alias imports and file-path strings in source-lock tests).
3. **Delete shared files that no function uses** and that nothing else references (dead code, per the cleanup rule). Files still referenced by front-end tests are moved instead.

Expected result: the shared folder drops to about 4.26 MB, under the limit.

## Verification
- `deno check` on every backend function's entry file, before and after, so no function loses an import.
- Run the vitest suite and compare against the known 21 pre-existing failures. No new failures are allowed.
- Deploy `send-campaign-heads-up`, then confirm a send from Notifications & Alerts no longer crashes.
- Then deploy the other functions with pending fixes (weekly payout, get-preset-offers, driver profile, lost-property, stop-waiting, and so on).

## Risks
- This is a large file move across the backend. Behaviour does not change, but a missed import would break a function. The `deno check` sweep is the safety net.
- 4.26 MB is close to the 4.5 MB limit. If the upload is still rejected, the next step is splitting the biggest shared files used by only 2 functions (for example the Revolut pre-auth and capture code) into those two functions.

## Technical details
- One script builds an old-path to new-path map. It then rewrites relative `import`/`export from`, dynamic `import()`, `new URL(..., import.meta.url)` and `@shared/` specifiers in every `.ts`/`.tsx` file in `supabase/`, `src/`, `tests/` and `shared/`.
- Add an AGENTS.md rule: `_shared/` holds only code imported by two or more functions, tests live in `supabase/tests/`. Why: every function upload includes all of `_shared/`, which is capped at about 4.5 MB.
