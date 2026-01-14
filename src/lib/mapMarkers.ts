import onecabCarMarker from '@/assets/onecab-car-marker.png';

// Preload the marker image
const markerImage = new Image();
markerImage.src = onecabCarMarker;

// Professional car marker sizes (like Uber/Bolt)
const MARKER_SIZES = {
  default: 48,
  selected: 64,
} as const;

/**
 * Create a professional car marker like Uber/Bolt
 * Clean design with subtle drop shadow, no circular glow
 */
function createProfessionalCarIcon(heading: number, size: number, isOnTrip: boolean = false): string {
  const canvas = document.createElement('canvas');
  const shadowOffset = 3;
  const totalSize = size + shadowOffset * 2 + 4;
  canvas.width = totalSize;
  canvas.height = totalSize;
  const ctx = canvas.getContext('2d');
  
  if (ctx && markerImage.complete) {
    const centerX = totalSize / 2;
    const centerY = totalSize / 2;
    
    // Save context for rotation
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate((heading * Math.PI) / 180);
    
    // Draw subtle drop shadow (professional look)
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 3;
    
    // Draw the car icon
    ctx.drawImage(markerImage, -size / 2, -size / 2, size, size);
    
    ctx.restore();
    
    // Add status indicator dot for drivers on trip
    if (isOnTrip) {
      ctx.beginPath();
      ctx.arc(totalSize - 10, 10, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#22c55e';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    
    return canvas.toDataURL();
  }
  
  return onecabCarMarker;
}

/**
 * Get the ONECAB car icon for Google Maps markers
 * Professional style like Uber/Bolt
 * @param size - 'default' (48px) or 'selected' (64px)
 * @param heading - Rotation angle in degrees
 * @param isOnTrip - Whether driver is on an active trip
 */
export function getEnhancedCarIcon(
  size: 32 | 64 = 32,
  heading: number = 0,
  isOnTrip: boolean = false
): google.maps.Icon {
  // Map old sizes to new professional sizes
  const actualSize = size === 64 ? MARKER_SIZES.selected : MARKER_SIZES.default;
  const shadowOffset = 3;
  const totalSize = actualSize + shadowOffset * 2 + 4;
  
  return {
    url: createProfessionalCarIcon(heading, actualSize, isOnTrip),
    scaledSize: new google.maps.Size(totalSize, totalSize),
    anchor: new google.maps.Point(totalSize / 2, totalSize / 2),
  };
}

/**
 * @deprecated Use getEnhancedCarIcon instead
 */
export function getOneCabCarIcon(
  size: 32 | 64 = 32,
  heading: number = 0
): google.maps.Icon {
  return getEnhancedCarIcon(size, heading, false);
}

/**
 * Preload the marker image for immediate use
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
