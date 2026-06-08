# P0: Admin Mapbox maps not rendering

**Date:** 2026-06-02 (updated)  
**Repo:** `admin-new` (OneCab admin panel)  
**Symptoms:** Live Fleet Tracking / Dashboard live map and Trip History “Route Map” show a gray canvas with Mapbox attribution but no basemap tiles, markers, or route line.

## Root cause

Two separate issues stack:

### 1. Wrong token for browser (403 on tiles)

The admin app previously loaded Mapbox via `VITE_MAPBOX_PUBLIC_TOKEN` (`MAPBOX_PUBLIC_TOKEN`), which is the **native** token restricted to iOS/Android bundle IDs—not browser origins.

From a web origin (localhost, Lovable preview, `adminonecab.net`), Mapbox **style/tile** requests return **HTTP 403**. Mapbox GL still creates the map container and shows the logo (gray canvas + attribution).

**Fix (already in tree):** `src/lib/mapbox.ts` + `useMapboxToken` resolve the **web** token via `VITE_MAPBOX_WEB_TOKEN` first, then `get-mapbox-token` (`MAPBOX_WEB_TOKEN`). Do not use `VITE_MAPBOX_PUBLIC_TOKEN` for maps.

| Token | Browser tiles (typical) |
|-------|-------------------------|
| Native (`VITE_MAPBOX_PUBLIC_TOKEN` / `MAPBOX_PUBLIC_TOKEN`) | 403 |
| Web (`VITE_MAPBOX_WEB_TOKEN` / `MAPBOX_WEB_TOKEN`) | 200 |

### 2. Env / hosting gaps (maps still blank after code fix)

| Mistake | What happens |
|---------|----------------|
| Only `VITE_MAPBOX_PUBLIC_TOKEN` in `.env` (no `VITE_MAPBOX_WEB_TOKEN`) | App ignores PUBLIC; falls back to edge. If `MAPBOX_WEB_TOKEN` secret missing, edge returns native token → **403**. |
| `.env.local` added but dev server not restarted | Vite inlines env at startup; `import.meta.env.VITE_MAPBOX_WEB_TOKEN` stays empty until restart. |
| **Lovable / production** without hosted env | `.env.local` is not deployed. Must set `VITE_MAPBOX_WEB_TOKEN` in Lovable project env **or** `MAPBOX_WEB_TOKEN` on Supabase. |
| Mapbox dashboard URL restrictions | Token must allow `http://localhost:8080` (admin dev port), Lovable preview host, and production admin host—not only `:5173`. |
| Dashboard “Loading map…” inside map `ref` | Child nodes in the Mapbox container broke layout (canvas height 0). Fixed: empty map layer + absolute overlay. |

Verified locally (2026-06-02):

- `loadEnv` / Vite dev on port **8080** loads `VITE_MAPBOX_WEB_TOKEN` from `.env.local`.
- `GET styles/v1/mapbox/streets-v12` with web token + `Origin: http://localhost:8080` → **200**.
- `POST …/functions/v1/get-mapbox-token` `{"platform":"web"}` → **200**, `pk.*` token.

## Code fix (this pass)

1. **`tryBootstrapMapboxTokenFromEnv()`** — apply `VITE_MAPBOX_WEB_TOKEN` synchronously before any `mapboxgl.Map` construct.
2. **`main.tsx`** — preload `resolveMapboxToken()` at startup.
3. **`useMapboxToken`** — initial state from env/cache (no wait for `useEffect`).
4. **`vite.config.ts`** — explicit `envDir: '.'` (documents that `.env.local` must live in `admin-new/`).
5. **`Dashboard.tsx`** — map container: dedicated `absolute inset-0` div; loading overlay as sibling; `map.resize()` on load; token error banner.
6. **`FleetTracking.tsx`** — `map.resize()` on load, `min-h-[400px]`, token error banner.
7. **`TripHistory.tsx` (Route Map dialog)** — was still using raw `new mapboxgl.Map()` inside Radix `Dialog` with `lg:h-full` (zero-height canvas on some breakpoints). Now uses `createMapboxMap`, fixed `min-h-[300px] h-[400px]` shell + `absolute inset-0` map layer, `scheduleDialogMapResize` (`requestAnimationFrame` + 100ms/350ms `resize`) after dialog open, token/tile error banner, pickup/dropoff markers + route line unchanged. E2E: `e2e/trip-history-route-map.spec.ts`.

## Environment variables

| Variable | Where | Purpose |
|----------|--------|---------|
| `MAPBOX_WEB_TOKEN` | Supabase Edge Function secrets | **Required for production / Lovable** — web `pk.*` from `get-mapbox-token` |
| `VITE_MAPBOX_WEB_TOKEN` | `admin-new/.env.local` or Lovable env | Local / hosted override; same web `pk.*` as `MAPBOX_WEB_TOKEN` |
| `MAPBOX_PUBLIC_TOKEN` | Supabase / `.env` | Native apps + server only — **not** admin browser maps |
| ~~`VITE_MAPBOX_PUBLIC_TOKEN`~~ | `.env` legacy | **Not read by map code**; remove or keep for other tooling only |

`get-mapbox-token` is deployed on project `thazislrdkjpvvghtvzo`. If `MAPBOX_WEB_TOKEN` is unset, the function **falls back** to `MAPBOX_PUBLIC_TOKEN` for `platform: web` → browser 403. Set the web secret.

## Mapbox dashboard — URL restrictions (web token)

Edit the **web** public token (`pk.*` used for `MAPBOX_WEB_TOKEN` / `VITE_MAPBOX_WEB_TOKEN`):

1. [Mapbox Account → Access tokens](https://account.mapbox.com/access-tokens/)
2. Open the web token → **URL restrictions** → allow:
   - `http://localhost:8080` (and/or `http://localhost:*` — admin `npm run dev` uses **8080**, not 5173)
   - `https://*.lovable.app` (your Lovable preview URL)
   - `https://adminonecab.net` and any custom admin host
3. Save — changes apply within a few minutes.

## Local dev checklist

| Check | Expected |
|-------|----------|
| File | `admin-new/.env.local` (not only parent repo `.env`) |
| `VITE_MAPBOX_WEB_TOKEN=pk.…` | Web token, starts with `pk.` |
| Restart after env change | `npm run dev` (port **8080**) |
| `VITE_MAPBOX_PUBLIC_TOKEN` | Not used for maps |
| Supabase `MAPBOX_WEB_TOKEN` | Set if omitting local web token |
| Network tab | `api.mapbox.com` tile/style requests **200**, not 403 |

## Verify locally

1. `cd admin-new && npm install && npm run dev` → http://localhost:8080
2. Confirm `.env.local` has `VITE_MAPBOX_WEB_TOKEN` **or** Supabase secret `MAPBOX_WEB_TOKEN`.
3. **Live Fleet Tracking** (`/fleet-tracking`) — basemap + driver markers.
4. **Dashboard** — Live Fleet Map tiles (markers depend on driver GPS data).
5. **Trip History** (`/trip-history`) → eye icon on a completed trip (e.g. MK-260602-020) → **Route Map** shows basemap tiles, green pickup / red dropoff markers, indigo route line (not gray box).
6. DevTools → Network → filter `mapbox.com` — **200** on style/tile URLs.
7. Console — no `[useMapboxToken]` / `[TripHistory] route map` / `[Dashboard] Mapbox error` / 403 spam.

**Trip History dialog-specific checks:** map shell has explicit height (`h-[400px]`); if tiles still blank, confirm dialog was open when map initialized (resize runs at 0ms/100ms/350ms after open). Error banner appears when token missing or tiles 403.

**E2E (optional):** `PLAYWRIGHT_ADMIN_EMAIL` + `PLAYWRIGHT_ADMIN_PASSWORD` → `npx playwright test e2e/trip-history-route-map.spec.ts`

## Lovable / production

- Add `VITE_MAPBOX_WEB_TOKEN` in Lovable project environment variables (same web `pk.*` as Supabase `MAPBOX_WEB_TOKEN`), **or** rely on `get-mapbox-token` with Supabase secret set.
- `.env.local` is **not** uploaded to Lovable.
- Republish after env changes.

## Rollback

Revert mapbox token commits and restore direct `VITE_MAPBOX_PUBLIC_TOKEN` usage only if you replace it with an unrestricted web token (not recommended; use `MAPBOX_WEB_TOKEN` instead).
