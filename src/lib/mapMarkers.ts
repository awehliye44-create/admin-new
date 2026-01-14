import onecabCarMarker from '@/assets/onecab-car-marker.png';

// Preload the marker image
const markerImage = new Image();
markerImage.src = onecabCarMarker;

/**
 * Get the ONECAB car icon for Google Maps markers
 * @param size - Icon size: 32 (default) or 64 (selected driver)
 * @param heading - Optional rotation angle in degrees
 * @returns Google Maps icon configuration
 */
export function getOneCabCarIcon(
  size: 32 | 64 = 32,
  heading: number = 0
): google.maps.Icon {
  return {
    url: createRotatedIcon(heading, size),
    scaledSize: new google.maps.Size(size, size),
    anchor: new google.maps.Point(size / 2, size / 2),
  };
}

/**
 * Create a rotated version of the car icon using canvas with enhanced visibility
 */
function createRotatedIcon(heading: number, size: number): string {
  const canvas = document.createElement('canvas');
  const padding = 6;
  const totalSize = size + padding * 2;
  canvas.width = totalSize;
  canvas.height = totalSize;
  const ctx = canvas.getContext('2d');
  
  if (ctx && markerImage.complete) {
    // Draw white circular background for contrast
    ctx.beginPath();
    ctx.arc(totalSize / 2, totalSize / 2, size / 2 + 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Draw the car icon rotated
    ctx.translate(totalSize / 2, totalSize / 2);
    ctx.rotate((heading * Math.PI) / 180);
    ctx.drawImage(markerImage, -size / 2, -size / 2, size, size);
    return canvas.toDataURL();
  }
  
  // Fallback if image not loaded yet - return the base image
  return onecabCarMarker;
}

/**
 * Get the ONECAB car icon with enhanced visibility
 * @param size - Icon size: 32 (default) or 64 (selected driver)
 * @param heading - Optional rotation angle in degrees
 * @returns Google Maps icon configuration
 */
export function getEnhancedCarIcon(
  size: 32 | 64 = 32,
  heading: number = 0
): google.maps.Icon {
  const padding = 6;
  const totalSize = size + padding * 2;
  return {
    url: createRotatedIcon(heading, size),
    scaledSize: new google.maps.Size(totalSize, totalSize),
    anchor: new google.maps.Point(totalSize / 2, totalSize / 2),
  };
}

/**
 * Preload the marker image for immediate use
 * Call this early in app initialization
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
