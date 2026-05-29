# Merchant Management — Implementation Plan

Build a single new admin page `/merchants` that controls the ONECAB Delivery marketplace. Reuses existing booking, payment, wallet, commission, dispatch, tracking, and notification systems — no parallel infrastructure.

## 1. Database (one migration)

New tables (all in `public`, with GRANTs + RLS, admin-only writes via `has_role(auth.uid(),'admin')`, authenticated read where needed):

- `merchant_categories` — enum-like reference: `food | grocery | retail | pharmacy | parcel`. Seeded. Global ON/OFF flag (`enabled boolean`) drives the "Merchant Type Controls" section. Customer app reads this.
- `service_area_merchant_settings` — `(service_area_id, category)` unique. `delivery_enabled boolean`, `enabled boolean`. Drives per-service-area visibility.
- `merchants` — business_name, category, service_area_id, owner_name, phone, email, address, city, postcode, description, logo_url, banner_url, opening_hours (jsonb), is_open, prep_time_minutes, delivery_radius_km, min_order_amount, commission_pct (nullable override; default uses global 15%), status (`pending|approved|rejected|suspended|closed`), created_at.
- `merchant_products` — merchant_id, category_section, name, description, price, image_url, image_source (`uploaded|ai_generated`), image_approved, availability, plus type-specific jsonb `attributes` (unit/weight, stock, prescription_required, parcel size, add-ons).
- `merchant_product_categories` — merchant_id, name, sort_order.
- `merchant_ai_credits` — merchant_id, credits_remaining, updated_at.
- `merchant_ai_generations` — merchant_id, prompt, image_url, status, created_at (history).

Storage buckets: `merchant-logos` (public), `merchant-banners` (public), `merchant-products` (public).

Orders tab is a **view**, not a new table — selects from existing `trips` where `booking_type='delivery'` joined by `merchant_id`.

## 2. Edge functions

- `generate-merchant-image` — calls Lovable AI Gateway image model, decrements `merchant_ai_credits`, writes to storage, inserts history row. Admin-only.
- (Reuse existing `accept-trip`, payment, wallet, commission flows. No new dispatch/payment code.)

## 3. Frontend

**Sidebar:** Add "Merchant Management" item in `AdminSidebar.tsx` under an appropriate section (Operations or new "Marketplace" group).

**Route:** `/merchants` in `App.tsx` → `src/pages/MerchantManagement.tsx`.

**Page sections (single page, tabbed):**
1. Overview cards — counts + revenue aggregates from `merchants` and delivery `trips`.
2. Global Merchant Type Controls — 5 switches bound to `merchant_categories.enabled`.
3. Per-Service-Area Controls — service area selector + 6 switches (delivery + 5 categories) bound to `service_area_merchant_settings`.
4. Merchant table — filters by service area / type / status, columns per spec, row actions (View/Edit/Approve/Reject/Suspend/Delete).
5. "Add Merchant" dialog with full form + logo/banner upload.

**Merchant detail** (`/merchants/:id`) — tabs: Overview, Orders, Menu/Products, Opening Hours, Payments, AI Images, Settings. Type-aware product editor (restaurant/grocery/retail/pharmacy/parcel forms share one component with conditional fields). AI Images tab shows credits, Generate button, history grid with approve/reject.

**Customer-app visibility:** Document that customer app must filter categories by `merchant_categories.enabled = true AND service_area_merchant_settings.enabled = true` for the active service area. No customer-app code lives in this admin repo, so this is enforced by the data layer + RLS (read policies expose only enabled rows to `anon`).

## 4. Reuse, not rebuild

- Commission: read global 15% from existing service-area pricing; `merchants.commission_pct` is an optional override only.
- Orders tab: query existing `trips` table filtered by `booking_type='delivery'` and `merchant_id`.
- Payments/Wallet/Dispatch/Tracking/Notifications: untouched — delivery trips flow through the same pipelines as ride trips.

## Technical notes

- All UI uses existing shadcn primitives + semantic tokens (gold/navy theme).
- RLS: admin full access; `anon` SELECT only on `merchant_categories`, `service_area_merchant_settings`, approved/open `merchants`, and available `merchant_products` (so customer app can read).
- File uploads go through Supabase Storage with per-bucket public read + admin write policies.
- AI image generation uses `LOVABLE_API_KEY` via edge function — never from client.
- Type-aware product schema kept flexible via `attributes jsonb` to avoid 5 separate tables.

## Scope confirmation needed

This is a large build (~1 migration, 1 edge function, 3 storage buckets, 1 list page, 1 detail page with 7 tabs, ~10+ components). I'll execute it as one coherent change once you approve. Reply "go" to proceed, or tell me which sections to trim/defer.
