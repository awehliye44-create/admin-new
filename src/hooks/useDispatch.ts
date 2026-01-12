import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface Driver {
  id: string;
  first_name: string;
  last_name: string;
  driver_code: string | null;
  distance_km: number;
  rating: number | null;
}

interface FindDriversResult {
  success: boolean;
  drivers: Driver[];
  message?: string;
  subtext?: string;
  error?: string;
}

interface DispatchResult {
  success: boolean;
  dispatched: boolean;
  driver?: {
    id: string;
    name: string;
    distance_km: number;
    rating: number | null;
  };
  message?: string;
  subtext?: string;
  error?: string;
}

export function useDispatch() {
  const [isSearching, setIsSearching] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [maxSearchTimeMinutes, setMaxSearchTimeMinutes] = useState(3);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Load dispatch settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const { data } = await supabase
          .from('dispatch_settings')
          .select('max_driver_find_time_minutes')
          .is('service_area_id', null)
          .single();

        if (data) {
          setMaxSearchTimeMinutes(data.max_driver_find_time_minutes);
        }
      } catch (err) {
        console.error('Error loading dispatch settings:', err);
      }
    };

    loadSettings();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, []);

  const startCountdown = useCallback((totalSeconds: number) => {
    setRemainingSeconds(totalSeconds);
    
    countdownIntervalRef.current = setInterval(() => {
      setRemainingSeconds(prev => {
        if (prev === null || prev <= 1) {
          if (countdownIntervalRef.current) {
            clearInterval(countdownIntervalRef.current);
          }
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const stopCountdown = useCallback(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setRemainingSeconds(null);
  }, []);

  const findDrivers = async (
    pickupLat: number,
    pickupLng: number,
    vehicleTypeId?: string,
    maxDistanceKm = 10
  ): Promise<FindDriversResult> => {
    setIsSearching(true);

    try {
      const { data, error } = await supabase.functions.invoke('find-drivers', {
        body: {
          pickup_lat: pickupLat,
          pickup_lng: pickupLng,
          vehicle_type_id: vehicleTypeId,
          max_distance_km: maxDistanceKm
        }
      });

      if (error) throw error;

      if (!data.success || data.drivers.length === 0) {
        toast.error(data.message || 'No drivers available right now.', {
          description: data.subtext || 'Please try again in a few minutes or adjust your pickup location.'
        });
        return {
          success: false,
          drivers: [],
          message: data.message,
          subtext: data.subtext
        };
      }

      return {
        success: true,
        drivers: data.drivers
      };
    } catch (err) {
      console.error('Error finding drivers:', err);
      toast.error('No drivers available right now.', {
        description: 'Please try again in a few minutes or adjust your pickup location.'
      });
      return {
        success: false,
        drivers: [],
        error: err instanceof Error ? err.message : 'Unknown error'
      };
    } finally {
      setIsSearching(false);
    }
  };

  const dispatchTrip = async (
    tripId: string,
    pickupLat: number,
    pickupLng: number,
    vehicleTypeId?: string,
    maxDistanceKm = 10,
    customTimeoutMinutes?: number
  ): Promise<DispatchResult> => {
    const timeoutMinutes = customTimeoutMinutes ?? maxSearchTimeMinutes;
    const timeoutSeconds = timeoutMinutes * 60;
    
    setIsSearching(true);
    startCountdown(timeoutSeconds);

    // Set timeout to stop searching and expire trip
    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearching(false);
      stopCountdown();
      
      // Mark trip as expired/no_drivers
      try {
        await supabase
          .from('trips')
          .update({ status: 'no_drivers' })
          .eq('id', tripId);
      } catch (err) {
        console.error('Error updating trip status:', err);
      }
      
      toast.error('No drivers available right now.', {
        description: 'Please try again in a few minutes or adjust your pickup location.'
      });
    }, timeoutSeconds * 1000);

    try {
      const { data, error } = await supabase.functions.invoke('dispatch-trip', {
        body: {
          trip_id: tripId,
          pickup_lat: pickupLat,
          pickup_lng: pickupLng,
          vehicle_type_id: vehicleTypeId,
          max_distance_km: maxDistanceKm,
          timeout_seconds: timeoutSeconds
        }
      });

      // Clear timeout since we got a response
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
      stopCountdown();

      if (error) throw error;

      if (!data.success || !data.dispatched) {
        toast.error(data.message || 'No drivers available right now.', {
          description: data.subtext || 'Please try again in a few minutes or adjust your pickup location.'
        });
        return {
          success: false,
          dispatched: false,
          message: data.message,
          subtext: data.subtext
        };
      }

      toast.success('Driver found!', {
        description: `${data.driver.name} is on the way (${data.driver.distance_km.toFixed(1)} km away)`
      });

      return {
        success: true,
        dispatched: true,
        driver: data.driver
      };
    } catch (err) {
      console.error('Error dispatching trip:', err);
      
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
      stopCountdown();
      
      toast.error('No drivers available right now.', {
        description: 'Please try again in a few minutes or adjust your pickup location.'
      });
      
      return {
        success: false,
        dispatched: false,
        error: err instanceof Error ? err.message : 'Unknown error'
      };
    } finally {
      setIsSearching(false);
    }
  };

  const cancelSearch = useCallback(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    stopCountdown();
    setIsSearching(false);
  }, [stopCountdown]);

  // Format remaining time as MM:SS
  const formattedRemainingTime = remainingSeconds !== null
    ? `${Math.floor(remainingSeconds / 60)}:${(remainingSeconds % 60).toString().padStart(2, '0')}`
    : null;

  return {
    isSearching,
    remainingSeconds,
    formattedRemainingTime,
    maxSearchTimeMinutes,
    findDrivers,
    dispatchTrip,
    cancelSearch
  };
}
