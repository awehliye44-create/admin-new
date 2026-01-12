import { useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface LocationOptions {
  enableHighAccuracy?: boolean;
  maximumAge?: number;
  timeout?: number;
  updateInterval?: number;
}

const DEFAULT_OPTIONS: LocationOptions = {
  enableHighAccuracy: true,
  maximumAge: 5000,
  timeout: 10000,
  updateInterval: 5000, // Update every 5 seconds
};

export function useDriverLocationTracking(
  driverId: string | null,
  isOnline: boolean,
  options: LocationOptions = {}
) {
  const watchIdRef = useRef<number | null>(null);
  const lastUpdateRef = useRef<number>(0);
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  const updateLocation = useCallback(async (position: GeolocationPosition) => {
    if (!driverId) return;

    const now = Date.now();
    if (now - lastUpdateRef.current < mergedOptions.updateInterval!) return;
    lastUpdateRef.current = now;

    const { latitude, longitude, heading, speed } = position.coords;

    try {
      const { error } = await supabase.rpc('update_driver_location', {
        p_driver_id: driverId,
        p_lat: latitude,
        p_lng: longitude,
        p_heading: heading,
        p_speed: speed,
      });

      if (error) {
        console.error('Error updating driver location:', error);
      } else {
        console.log('Driver location updated:', { latitude, longitude });
      }
    } catch (err) {
      console.error('Failed to update driver location:', err);
    }
  }, [driverId, mergedOptions.updateInterval]);

  const handleError = useCallback((error: GeolocationPositionError) => {
    console.error('Geolocation error:', error.message);
  }, []);

  useEffect(() => {
    if (!driverId || !isOnline || !navigator.geolocation) {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }

    // Start watching position
    watchIdRef.current = navigator.geolocation.watchPosition(
      updateLocation,
      handleError,
      {
        enableHighAccuracy: mergedOptions.enableHighAccuracy,
        maximumAge: mergedOptions.maximumAge,
        timeout: mergedOptions.timeout,
      }
    );

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [driverId, isOnline, updateLocation, handleError, mergedOptions]);

  return null;
}
