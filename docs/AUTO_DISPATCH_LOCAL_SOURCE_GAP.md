# auto-dispatch local source gap

**Production:** `auto-dispatch` **v518 ACTIVE** includes soft Towards Destination matching  
(`towardsDestinationPriorityBonus`, incompatible drivers remain eligible).

**Local checkout:** `supabase/functions/auto-dispatch/` and several `_shared` modules are **not present** in this tree.

## Risk

Redeploying `auto-dispatch` from this incomplete checkout would fail upload or regress soft matching.

## Rule

Do **not** run `supabase functions deploy auto-dispatch` until the full production sources are restored into the repo (download from Management API / known-good branch). Production v518 remains the source of truth.
