import { useState } from 'react';
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
  const [searchTimeout, setSearchTimeout] = useState<NodeJS.Timeout | null>(null);

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
    timeoutSeconds = 30
  ): Promise<DispatchResult> => {
    setIsSearching(true);

    // Set timeout to stop searching
    const timeout = setTimeout(() => {
      setIsSearching(false);
      toast.error('No drivers available right now.', {
        description: 'Please try again in a few minutes or adjust your pickup location.'
      });
    }, timeoutSeconds * 1000);
    
    setSearchTimeout(timeout);

    try {
      const { data, error } = await supabase.functions.invoke('dispatch-trip', {
        body: {
          trip_id: tripId,
          pickup_lat: pickupLat,
          pickup_lng: pickupLng,
          vehicle_type_id: vehicleTypeId,
          max_distance_km: maxDistanceKm
        }
      });

      clearTimeout(timeout);
      setSearchTimeout(null);

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
      clearTimeout(timeout);
      setSearchTimeout(null);
      
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

  const cancelSearch = () => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
      setSearchTimeout(null);
    }
    setIsSearching(false);
  };

  return {
    isSearching,
    findDrivers,
    dispatchTrip,
    cancelSearch
  };
}
