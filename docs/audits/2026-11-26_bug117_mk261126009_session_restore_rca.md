# #117 — MK-261126-009 Customer session recovery / cancel UX trap

**Severity:** Critical (Customer trapped after legitimate cancel)  
**Trip:** MK-261126-009  
**Related:** Independent of #116 (broadcast rematch). Same trip, different defect.  
**Stage D:** true/true · Atomic completion: STOP

## Confirmed root cause

Customer session restore can hang inside `applyAuthenticatedCustomer` on unbounded `claim-device` / `bind-onecab-access-role` **before** `setAuthenticated`. The 12s restore deadline was cleared as soon as `getSession` succeeded, so a hung claim/bind left:

- UI: “Unable to verify access” + “Connection timed out while restoring your session…”
- Buttons: Chat with support + **Sign in** (but `onRetry` actually called restore join — a no-op while `restoreInFlight`)
- `BootSplash` latch path set `sessionRestoreRetryable` without clearing `isRestoring`, blocking foreground auto-retry
- Index never mounted trip gate → authoritative cancel could not navigate to Home

Cancel itself succeeded (`cancelled_by=rider` 18:58:42Z); hold released 18:58:47Z. The trap is client recovery, not cancel/RLS failure.

## #116 relationship

**No shared underlying cause.** #116 was `broadcast_enabled` rematch refuse. #117 is Customer auth-arming hang after #104 claim/bind overlap + #109 retryable splash surface.

## Timeline (UTC)

| Time | Event |
|------|--------|
| 18:53:35–40 | Auth + trip create |
| 18:54:58–18:57:11 | Offer / negotiation / #116 rematch abort |
| 18:58:42 | Rider cancel committed |
| 18:58:47 | Hold released (700p); Customer OTA register stamp |
| ~19:00–19:02 UK | Observed access-verify trap (after reload / restore) |
| Notification | Cancel push arrived; app stayed on access screen |

## Financial

- Session `released`, capture 0, released 700p  
- No duplicate cancel / capture / fee  
- Trip `payment_status` stamp may lag (`authorized`) while session is released — disposition authoritative on session

## Launched Customer OTA (incident)

- `loaded_update_id`: `01a218f7-dcd1-7bb5-80b4-6b4f30a1829b`
- `runtime_version`: `1.0.6(31)`
- device: `ios-8219d43ded20858efad93c2aa2fe2334`

## Driver equivalent

Driver already bounds claim (12s) and bind (8s) and clears recoverable restore. **Same defect not present** on Driver. No Driver change required for #117.

## MK-261126-008 (#116 impact)

Scheduled pickup **2026-11-27 06:40 UTC**, `driver_assigned`, `broadcast_enabled=true`, `scheduled_hold_reason=null`.  
#116 only narrows false→true reopen refuse; airport/active holds unchanged. **008 is not blocked by #116**; if a future rematch needs reopen with NULL hold, #116 helps.

## Permanent correction (Customer)

- Bound claim fetch (`AbortController` 12s) and bind invoke (8s)
- Keep restore deadline across apply; supersede stalled restore on Try again
- BootSplash latch clears `isRestoring` + surfaces retry message
- Access error label: **Try again** when `onRetry` is set (no false Sign in)
- Lock: `bug117CustomerSessionRestore.lock.test.ts`
