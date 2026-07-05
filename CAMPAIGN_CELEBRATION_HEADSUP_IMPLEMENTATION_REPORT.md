# Campaign / Celebration Heads-Up — Implementation Report

**Date:** 2026-07-05  
**Scope:** System B — admin-controlled, reusable, targeted, scheduled promotional heads-up notifications  
**Hard rule:** Operational 12-template heads-up (System A) is unchanged.

---

## Architecture

### System A (unchanged)

| Property | Value |
|----------|-------|
| Source | Backend trip/payment events only |
| Templates | 12 fixed events in `customerHeadsUpEvents.ts` / `customerHeadsUpTemplates.ts` |
| Editable | No |
| Priority | Highest |
| Queue | `CustomerHeadsUpQueue.ts` |
| Push path | `send-trip-notification` → `resolveHeadsUpEventFromPushType` |

### System B (new)

| Property | Value |
|----------|-------|
| Source | Admin → Notifications & Alerts → **Campaign / Celebration** tab |
| Templates | 32 seeded reusable Mojo templates (editable per send) |
| Editable | Yes — title, subtitle, emoji, gradient, CTA, targeting, schedule |
| Priority | Lower — suppressed during active trip / ride workflow |
| Queue | `CampaignHeadsUpQueue.ts` (separate dedupe namespace) |
| Push path | `send-campaign-heads-up` with `layer=campaign`, `type=campaign_heads_up` |

```
Admin UI ──► campaign_heads_up_campaigns ──► send-campaign-heads-up
                                                    │
                    ┌───────────────────────────────┴───────────────────────────────┐
                    ▼                                                               ▼
         customer_push_tokens                                              push_tokens (driver)
                    │                                                               │
                    ▼                                                               ▼
         CampaignHeadsUpProvider (z-55)                              CampaignHeadsUpProvider (z-55)
         (yields to CustomerHeadsUpQueue z-60)                       (suppressed on active-trip / offer)
```

---

## Database

**Migration:** `supabase/migrations/20260705120000_campaign_heads_up_system.sql`

| Table | Purpose |
|-------|---------|
| `campaign_heads_up_templates` | 32 reusable seeded templates (Sports, Religious, Celebration, Promotion, Announcement) |
| `campaign_heads_up_campaigns` | Admin-created campaign instances (draft, scheduled, sent) |
| `campaign_heads_up_deliveries` | Per-user delivery + analytics (delivered, opened, dismissed, tapped, failed) |

**Trigger:** `bump_campaign_heads_up_delivery_counts` rolls up delivery status changes to campaign aggregate counters.

**RLS:** Staff read/write campaigns; users read/update own delivery rows for analytics.

---

## Admin UI

**Location:** Admin → Notifications & Alerts → **Campaign / Celebration** tab (no new page).

**Component:** `src/components/notifications/CampaignHeadsUpSection.tsx`

Features:
- Analytics overview cards (Sent, Delivered, Open Rate, Tap Rate, Dismiss Rate)
- Create form: category, template picker, title, message, CTA, accent/gradient, target app, scope (global/region/service area), priority, schedule mode, expiry
- Live heads-up preview (4s auto-dismiss note)
- Pre-built Mojo template gallery (all 32 seeds)
- History table with per-campaign metrics and Send action for drafts

**Shared SSOT:** `shared/campaignHeadsUpTemplates.ts` — categories, seeds, constants.

---

## Edge function

**`send-campaign-heads-up`** (`supabase/functions/send-campaign-heads-up/index.ts`)

- Loads campaign from `campaign_heads_up_campaigns`
- Resolves `customer_push_tokens` / `push_tokens` by target app
- Sends FCM with `layer=campaign`, never through `send-trip-notification`
- Upserts `campaign_heads_up_deliveries` with dedupe key `campaignId:userId:app`
- Updates campaign status to `sent` with aggregate counts

**Deploy:** Apply migration, then `supabase functions deploy send-campaign-heads-up`.

---

## Customer app

| File | Role |
|------|------|
| `shared/campaignHeadsUpTemplates.ts` | Constants |
| `src/lib/campaignHeadsUpDedupe.ts` | Separate localStorage dedupe |
| `src/lib/CampaignHeadsUpQueue.ts` | Single-slot queue, 4s auto-dismiss |
| `src/components/CampaignHeadsUpBanner.tsx` | Premium gradient card UI |
| `src/components/CampaignHeadsUpProvider.tsx` | Mount + navigation |
| `src/lib/pushNotifications.ts` | Routes `layer=campaign` before operational path |
| `src/lib/CustomerHeadsUpQueue.ts` | Added `getCustomerHeadsUpVisiblePayload()` for priority gate |

**Suppression:** Campaign queue waits if operational heads-up visible or user is on `/ride-tracking` / `/rate-driver`.

**Mount order:** `CustomerHeadsUpProvider` → `CampaignHeadsUpProvider` (operational always wins).

---

## Driver app

| File | Role |
|------|------|
| `shared/campaignHeadsUpTemplates.ts` | Constants |
| `src/lib/campaignHeadsUpDedupe.ts` | Dedupe |
| `src/lib/campaignHeadsUpTripGate.ts` | Suppress during active trip / offer / payment |
| `src/lib/CampaignHeadsUpQueue.ts` | Queue (`user_app=driver`) |
| `src/components/CampaignHeadsUpBanner.tsx` | UI |
| `src/components/CampaignHeadsUpProvider.tsx` | Mount |
| `src/capacitor/useDriverNotifications.ts` | Early return for `layer=campaign` — does not enter ride-offer path |

**Suppression paths:** `/active-trip`, `/ride-offer`, `/delivery-offer`, `/confirm-payment`, `/rate-passenger`.

Ride offer overlay, dispatch, and operational heads-up lifecycle gates are untouched.

---

## Scheduling

| Mode | Status |
|------|--------|
| Send now | ✅ Invokes edge function immediately |
| Save draft | ✅ `status=draft` |
| Schedule | ✅ Stores `scheduled_at`, `status=scheduled` (cron worker follow-up) |
| Repeat yearly / monthly | ✅ Stored on campaign row; worker TBD |
| Expiry | ✅ `ends_at` field on campaign |

**Follow-up:** Add `campaign-heads-up-scheduler` cron edge function to poll `status=scheduled AND scheduled_at <= now()`.

---

## Analytics

Tracked per delivery row:
- Created → pending
- Delivered → FCM success
- Opened → banner shown (foreground)
- Dismissed → swipe/auto-dismiss
- Tapped → CTA navigation
- Failed → FCM/token error

Campaign row aggregates updated via DB trigger. Admin History tab shows sent/delivered/opened/tapped counts.

---

## Targeting

| Scope | Implementation |
|-------|----------------|
| Global | All tokens for target app |
| Region | `target_region_id` stored; token filter extension TBD |
| Service Area | `target_service_area_id` stored; token filter extension TBD |
| Specific users | `target_user_ids[]` filters token query |
| Customer / Driver / Both | `target_app` selects token table(s) |

---

## Reusable templates (32 seeded)

- **Sports (11):** Champions League Final, Europa, Conference, Euro, World Cup, AFCON, PL Final Day, FA Cup, Carabao Cup, Copa America, Olympics
- **Religious (7):** Ramadan, Eid Mubarak, Eid Al Adha, Christmas, Easter, Diwali, Lunar New Year
- **Celebration (4):** New Year, Welcome ONECAB, Anniversary, Regional Launch
- **Promotion (6):** Airport Discount, Weekend Sale, Invite Friends, Promo Code, Cashback, Ride & Save
- **Announcement (4):** App Update, New Feature, Payment Method, Service Maintenance

All editable on send — seeds are defaults, not fixed copy.

---

## Acceptance tests

| # | Test | Expected |
|---|------|----------|
| 1 | Admin creates Champions League campaign, Send Now | Campaign row `status=sent`, deliveries created |
| 2 | Customer foreground push with `layer=campaign` | Campaign banner shows; operational queue untouched |
| 3 | Customer on `/ride-tracking` receives campaign push | Banner suppressed until safe screen |
| 4 | Operational `driver_assigned` push while campaign visible | Operational banner replaces/supersedes campaign |
| 5 | Driver on `/active-trip` receives campaign push | No campaign banner; ride workflow unaffected |
| 6 | Tap campaign banner with CTA `/promotions/champions-league` | Navigation + delivery `status=tapped` |
| 7 | Auto-dismiss after 4s | Banner clears; delivery `status=dismissed` |
| 8 | Same campaign push twice | Dedupe prevents duplicate banner |
| 9 | Admin History tab | Shows sent/delivered/opened/tapped counts |
| 10 | Edit template title before send | Stored on campaign row, not mutating seed template |

---

## What was NOT changed

- 12 operational heads-up templates and event maps
- `send-trip-notification` / `emitCustomerHeadsUpPush`
- Booking, trip, payment, Stripe workflows
- Driver ride-offer heads-up / `GlobalRideOfferOverlay` / native FCM offer service
- Existing admin operational notification templates tab

---

## Final rule

**Operational notifications** remain fixed and automatic (System A).  
**Campaign / Celebration notifications** are reusable, editable, scheduled, targeted, and completely independent (System B).
