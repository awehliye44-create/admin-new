# P0: Admin Mapbox live audit

**Date:** 2026-06-02 (browser verification added)  
**Target:** `admin-new` dev server at `http://localhost:8080`  
**Auditor:** automated checks + Playwright (no secrets logged)

## Summary

| # | Check | Result |
|---|--------|--------|
| 1 | Dev server health (`GET /`) | **PASS** (HTTP 200) |
| 2 | `VITE_MAPBOX_WEB_TOKEN` in `.env.local` | **PASS** (present) |
| 3 | Mapbox **Styles** API + `Origin: http://localhost:8080` | **PASS** (HTTP 200) |
| 4 | Mapbox **vector tiles** + same origin | **FAIL** (HTTP **403**) |
| 5 | `VITE_MAPBOX_WEB_TOKEN` === `VITE_MAPBOX_PUBLIC_TOKEN` | **FAIL** (same native token in both) |
| 6 | Edge function `get-mapbox-token` | **PASS** (HTTP 200, `pk.*` returned) |
| 7 | Token bootstrap in served Vite modules | **PASS** (`resolveMapboxToken`, `createMapboxMap` in bundle) |
| 8 | Playwright `/__dev__/mapbox-smoke` | **PASS** (canvas ≥100×100; **403** tiles → visible error banner) |
| 9 | Playwright `/fleet-tracking` (no admin creds) | **SKIP** (auth required) |

**Overall:** **FAIL until token is fixed** — prior curl-only audit passed because it hit the Styles API (200). The **browser gray map** is explained by **vector tile 403** using the native/public token as `VITE_MAPBOX_WEB_TOKEN`.

---

## What was broken in the browser

1. **Wrong token type in `.env.local`:** `VITE_MAPBOX_WEB_TOKEN` is a copy of `VITE_MAPBOX_PUBLIC_TOKEN` (native / app token). Mapbox Styles API can return **200** while **vector tiles return 403** → Mapbox GL creates a canvas and shows the logo, but the basemap stays **gray**.
2. **Misleading prior audit:** Checking only `styles/v1/mapbox/streets-v12` does not catch tile 403.
3. **Code gaps (fixed):** Map could be constructed without re-awaiting `resolveMapboxToken()`; tile/auth failures were not always surfaced in the UI; no automated browser proof.

**Not the cause (verified):** missing CSS (imported in `mapbox.ts` + `main.tsx`), zero-height container (explicit `min-h-[500px]` / `calc(100vh-200px)`), wrong style URL (`streets-v12` is valid).

---

## Browser test (Playwright)

Command:

```bash
cd admin-new
npm run dev   # http://localhost:8080
npm run test:e2e:map   # mapbox-smoke + fleet-tracking (fleet skips without login)
```

**`e2e/mapbox-smoke.spec.ts`** (dev route `/__dev__/mapbox-smoke`, no auth):

- `.mapboxgl-canvas` visible, width/height > 100px
- **20+** `api.mapbox.com` **403** responses on `*.vector.pbf`
- UI **alert** banner: tile access denied / web token guidance

**`e2e/fleet-tracking-map.spec.ts`:** requires `PLAYWRIGHT_ADMIN_EMAIL` + `PLAYWRIGHT_ADMIN_PASSWORD` for full `/fleet-tracking` check.

Artifacts: `e2e/artifacts/mapbox-smoke-tile-403.png` (when 403 present).

---

## curl token vs tile check (status only)

```text
styles API (streets-v12):     HTTP 200
vector tile (*.vector.pbf):   HTTP 403
```

---

## Fix for operators (required)

1. In [Mapbox account](https://account.mapbox.com/access-tokens/), create or use a **web** public token (`pk.*`) with **URL restrictions** that include:
   - `http://localhost:8080`
   - Lovable preview host(s)
   - Production admin host
2. Set **`VITE_MAPBOX_WEB_TOKEN`** in `admin-new/.env.local` to that web token (**not** the same value as `VITE_MAPBOX_PUBLIC_TOKEN`).
3. **Restart** `npm run dev` (Vite inlines env at startup).
4. **Production / Lovable:** set `VITE_MAPBOX_WEB_TOKEN` in the host env **or** `MAPBOX_WEB_TOKEN` on Supabase (must be the web token; if the edge function falls back to `MAPBOX_PUBLIC_TOKEN`, browser tiles will 403).

Re-run: `npm run test:e2e:map` — expect **no** tile 403s and no error banner.

---

## Code changes (this pass)

| File | Change |
|------|--------|
| `src/lib/mapboxMap.ts` | **New** — `createMapboxMap()`: await `resolveMapboxToken()`, set `accessToken`, resize, tile 403 probe, auth-only `error` UI |
| `src/lib/mapbox.ts` | Warn when WEB token equals PUBLIC token |
| `src/pages/FleetTracking.tsx` | Use `createMapboxMap`, taller container, tile error banner |
| `src/pages/Dashboard.tsx` | Same |
| `src/main.tsx` | Global `mapbox-gl.css` import |
| `src/pages/dev/MapboxSmoke.tsx` | Dev-only smoke page |
| `src/App.tsx` | Route `/__dev__/mapbox-smoke` (DEV only) |
| `e2e/mapbox-smoke.spec.ts` | Browser smoke test |
| `playwright.config.ts` | Playwright config |

---

## URL the user should use

| Environment | URL |
|-------------|-----|
| **Local dev (correct)** | **http://localhost:8080** — `/fleet-tracking`, `/dashboard` |
| **Map smoke (dev, no login)** | http://localhost:8080/__dev__/mapbox-smoke |
| **Wrong** | `:5173` (admin Vite is pinned to **8080**) |
| **Lovable / production** | Hosted admin URL — must set `VITE_MAPBOX_WEB_TOKEN` in Lovable **or** `MAPBOX_WEB_TOKEN` on Supabase (web `pk.*`) |

---

## What the user should see when working

| Page | Expected UI |
|------|-------------|
| **Fleet Tracking** (`/fleet-tracking`) | Streets basemap, markers, no persistent red alert |
| **Dashboard** | Live map panel with tiles |
| **Network** | `api.mapbox.com` vector/sprites **200**, not **403** |

When token is still wrong: red **Map unavailable** banner mentioning **403** / web token; canvas may exist but stay gray.
