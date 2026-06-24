import onecabCarMarker from '@/assets/onecab-car-marker.png';

// Preload the marker image
const markerImage = new Image();
markerImage.src = onecabCarMarker;

const MARKER_SIZES = {
  default: 48,
  selected: 64,
} as const;

export type DriverMarkerStatus = 'live' | 'on_trip' | 'stale' | 'offline';

const STATUS_DOT_COLORS: Record<DriverMarkerStatus, string> = {
  live: '#22c55e',
  on_trip: '#f59e0b',
  stale: '#6b7280',
  offline: '#9ca3af',
};

/**
 * Build an HTMLElement representing a driver car marker for Mapbox.
 * The element rotates with the driver heading and shows a status dot.
 *
 * Use with `new mapboxgl.Marker({ element, rotation: heading, rotationAlignment: 'map' })`.
 */
export function createCarMarkerElement(
  size: 32 | 64 = 32,
  status: DriverMarkerStatus = 'live',
): HTMLElement {
  const actualSize = size === 64 ? MARKER_SIZES.selected : MARKER_SIZES.default;

  const wrapper = document.createElement('div');
  wrapper.style.width = `${actualSize}px`;
  wrapper.style.height = `${actualSize}px`;
  wrapper.style.position = 'relative';
  wrapper.style.cursor = 'pointer';

  if (status === 'offline') {
    wrapper.style.opacity = '0.55';
  }

  const img = document.createElement('img');
  img.src = onecabCarMarker;
  img.width = actualSize;
  img.height = actualSize;
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.filter = status === 'stale'
    ? 'grayscale(1) drop-shadow(0 3px 6px rgba(0, 0, 0, 0.35))'
    : 'drop-shadow(0 3px 6px rgba(0, 0, 0, 0.35))';
  img.style.display = 'block';
  wrapper.appendChild(img);

  const dot = document.createElement('div');
  dot.style.position = 'absolute';
  dot.style.top = '0';
  dot.style.right = '0';
  dot.style.width = '12px';
  dot.style.height = '12px';
  dot.style.borderRadius = '50%';
  dot.style.background = STATUS_DOT_COLORS[status];
  dot.style.border = '2px solid #ffffff';
  wrapper.appendChild(dot);

  return wrapper;
}

/**
 * Preload the marker image for immediate use.
 */
export function preloadMarkerImage(): Promise<void> {
  return new Promise((resolve) => {
    if (markerImage.complete) {
      resolve();
    } else {
      markerImage.onload = () => resolve();
    }
  });
}
