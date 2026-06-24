# P0 Admin Panel Map Audit Report

**Date:** 2026-06-24  
**Repo:** `admin-new` (OneCab admin panel)  
**Pages audited:** Driver Demand Zones (`/driver-demand-zones`), Live Fleet Tracking (`/fleet-tracking`)

---

## Executive summary

| Area | Before | After (this pass) |
|------|--------|-------------------|
| Driver Demand Zones basemap | Blue canvas, no roads/labels, no controls | Streets basemap + zoom/pan/fullscreen/fit/recenter controls |
| Driver Demand Zones fit logic | Center points only; invalid coords could fly map off-UK | Full circle + boundary bounds with UK coordinate guard |
| Live Fleet Tracking viewport | Fixed Milton Keynes; no auto-fit | Auto-fits all visible drivers (UK-wide); manual Fit drivers + Recenter |
| Live Fleet map controls | Zoom +/- only | Zoom, fullscreen, fit all drivers, recenter, refresh |
| Driver marker legend | Stale/on-trip styling not implemented | Live / on-trip / stale / offline marker states |

**Deploy status:** Code changes are local in `admin-new`. Push to `main` to publish via GitHub Pages (`adminonecab.net`).

---

## P0 — Driver Demand Zones map

### Current implementation

| Item | Detail |
|------|--------|
| Component | `src/components/maps/DriverDemandZonesMap.tsx` |
| Map factory | `createMapboxMap()` in `src/lib/mapboxMap.ts` |
| Style | `mapbox://styles/mapbox/streets-v12` (`MAPBOX_STYLE`) |
| Token | `VITE_MAPBOX_WEB_TOKEN` → fallback `get-mapbox-token` (`MAPBOX_WEB_TOKEN`) |
| Overlay | GeoJSON circle polygons via `buildAdminDemandZonesGeoJson()` |
| Colours | `src/lib/demandZoneMapStyle.ts` — matches driver app `demandZoneStyle.ts` (HIGH red-orange, MEDIUM amber, LOW light blue) |

### Map center logic

| Scenario | Behaviour |
|----------|-----------|
| Initial load | `DEFAULT_MAP_CENTER` = `[-0.7594, 52.0406]` (Milton Keynes), zoom `11` |
| Zones present | `fitBounds` to full circle extents + optional service-area boundary |
| Service area filter only | Fits to `serviceAreaBoundary` polygon when no zones match filters |
| No zones / no boundary | Stays on MK default (roads + labels visible) |

### Fit bounds logic

- **Before:** Extended bounds to zone **center points only** — circles clipped at viewport edge.
- **After:** `buildDemandZonesBounds()` in `src/lib/mapBounds.ts` extends bounds using full circle rings (`radius_meters`) and service-area polygon vertices.
- **Guard:** `isValidUkCoord()` rejects swapped/invalid coordinates (e.g. lat/lng reversed, null island) before `fitBounds` — prevents flying to ocean/Middle East.

### Why the map showed a blank blue/ocean background

From your screenshots and code review:

1. **Basemap token was OK on Fleet Tracking** (same token path) — so this was not a global 403.
2. **Driver Demand Zones had no map controls** — zoom/pan/fullscreen missing; hard to recover from a bad viewport.
3. **Possible invalid `fitBounds`** — when a service-area boundary or zone center had bad coordinates, Mapbox could frame open ocean (uniform blue water, foreign labels). UK guard added.
4. **Container layout** — map used `absolute inset-0` without `min-h`/`w-full`; in grid layout this could produce a zero-height canvas on some breakpoints. Fixed with explicit `min-h-[400px] w-full`.
5. **Earlier deploy bug (fixed 23 Jun)** — synchronous `.on('load')` on async `createMapboxMap` caused crash; if an older build was cached, map could fail silently.

"No zones match the current filters" is **expected overlay text** when filters return 0 zones — it does not mean the basemap failed.

### Required controls (implemented)

| Control | Implementation |
|---------|----------------|
| Zoom +/- | `NavigationControl` via `attachAdminMapControls()` |
| Pan / mouse wheel | `dragPan` + `scrollZoom` enabled |
| Fullscreen | `FullscreenControl` |
| Fit to zones | Custom toolbar button `⊞` |
| Recenter | Custom toolbar button `◎` → MK default |

---

## P0 — Live Fleet Tracking map

### Current implementation

| Item | Detail |
|------|--------|
| Page | `src/pages/FleetTracking.tsx` |
| Map factory | `createMapboxMap()` |
| Style | `streets-v12` |
| Markers | `createCarMarkerElement()` + `mapboxgl.Marker` with heading rotation |
| Data refresh | Initial fetch + 30s polling + Supabase realtime on `drivers` UPDATE |

### Map center logic

| Scenario | Behaviour |
|----------|-----------|
| Initial load | MK center until drivers load |
| After drivers load | **Auto `fitBounds`** to all filtered driver positions (once, until admin pans/zooms) |
| Filter change | Resets auto-fit; reframes to new driver set |
| Driver selected | `flyTo` driver on click; `easeTo` follows GPS updates |
| Recenter button | Selected driver GPS if available, else MK default |
| Fit all drivers | Manual `fitBounds` across all visible drivers (London + MK + anywhere in UK) |

### Fit bounds logic

- `collectDriverMapPositions()` — uses `current_lat`/`current_lng` when valid UK coords; else region boundary fallback.
- `boundsFromPositions()` — builds `LngLatBounds` spanning all positions.
- `fitMapToLngLatBounds()` — padding 64px, maxZoom 13.
- **Proof (unit test):** MK driver + London driver → bounds span lat 51.5–52+ and lng -0.8–-0.1 (`src/lib/__tests__/mapBounds.test.ts`).

### Driver visibility logic

| Condition | Marker status | Visual |
|-----------|---------------|--------|
| Offline | `offline` | Dimmed car + grey dot |
| On trip | `on_trip` | Amber status dot |
| GPS > 5 min old | `stale` | Grayscale car + grey dot |
| Online, fresh GPS | `live` | Full colour + green dot |

Markers without GPS fall back to first point of region `geo_boundary`.

### Was the map static / locked to Milton Keynes?

**Yes, before this pass:**

- Fixed `center: [-0.7594, 52.0406]`, zoom 13 — never changed unless admin clicked a marker.
- No `fitBounds` on load or driver movement.
- Drivers outside MK viewport were off-screen.

**After:** Map dynamically includes all visible drivers UK-wide when auto-fit runs or admin taps **Fit drivers** / `⊞` on map toolbar.

---

## P1 — Live Fleet map controls

| Control | Status |
|---------|--------|
| Zoom +/- | Map toolbar (top-right) |
| Fullscreen | Map toolbar |
| Fit all drivers | Map toolbar `⊞` + header **Fit drivers** button |
| Recenter | Map toolbar `◎` + header **Recenter** button |
| Refresh locations | Header refresh button (re-fetch + realtime continues) |

---

## P1 — Driver Demand Zones UX vs driver heatmap

| Element | Admin | Driver app |
|---------|-------|------------|
| HIGH | `#FF5722` / `#E64A19` | Same |
| MEDIUM | `#FFC107` / `#FFA000` | Same |
| LOW | `#64B5F6` / `#42A5F5` | Same |
| Legend | Bottom-left on map | In-app guidance overlay |
| Basemap | Mapbox streets | Native Mapbox map |

---

## Files changed

| File | Change |
|------|--------|
| `src/lib/mapBounds.ts` | **New** — UK bounds helpers, demand zone + driver fit logic |
| `src/lib/mapControls.ts` | **New** — shared Navigation + Fullscreen + fit/recenter toolbar |
| `src/lib/__tests__/mapBounds.test.ts` | **New** — UK-wide bounds proof |
| `src/components/maps/DriverDemandZonesMap.tsx` | Controls, resize, bounds fix, layout |
| `src/pages/FleetTracking.tsx` | Auto-fit, follow selected driver, controls, marker status, container fix |
| `src/lib/mapMarkers.ts` | `DriverMarkerStatus` — live/on_trip/stale/offline |

---

## Verification checklist

### Local

```bash
cd admin-new
npm run dev   # http://localhost:8080
```

1. **Driver Demand Zones** — roads, city labels, zoom/pan, fullscreen, fit/recenter work with 0 zones and with zones.
2. **Live Fleet Tracking** — basemap loads; **Fit drivers** frames all markers; pan away then Fit restores bounds.
3. **UK-wide proof** — with drivers in MK and London (or mock GPS), Fit shows both cities.
4. DevTools → Network → `mapbox.com` → style/tile requests **200**.

### Production

1. Push `admin-new` to `main` → wait for GitHub Pages workflow.
2. Hard-refresh `adminonecab.net` (clear cache).
3. Re-test both pages; capture screenshots for sign-off.

### Screenshots after fixes

Screenshots must be taken **after deploy** on `adminonecab.net` or local `localhost:8080` with `VITE_MAPBOX_WEB_TOKEN` set. This report documents the code fixes; attach before/after screenshots to your test run.

---

## Mapbox token reminder

Browser maps require **web** token (`pk.*` with URL restrictions for `adminonecab.net`, `localhost:8080`). Native `MAPBOX_PUBLIC_TOKEN` returns **403** in browser — see `docs/p0-admin-mapbox-maps-not-rendering-report.md`.
