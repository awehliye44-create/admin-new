/**
 * Centralized Mapbox configuration.
 * Imports the Mapbox GL CSS once and exports the access token + a default style.
 */
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_PUBLIC_TOKEN as string;

if (MAPBOX_TOKEN && !mapboxgl.accessToken) {
  mapboxgl.accessToken = MAPBOX_TOKEN;
}

export const MAPBOX_STYLE = 'mapbox://styles/mapbox/streets-v12';

export { mapboxgl };
