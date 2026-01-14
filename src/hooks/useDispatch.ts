import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface Driver {
  id: string;
  name: string;
  driver_code: string | null;
  distance_km: number;
  priority_score: number;
}

interface TripOffer {
  id: string;
  trip_id: string;
  driver_id: string;
  status: 'offered' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
  distance_km: number;
  priority_score: number;
  offered_at: string;
  expires_at: string;
  responded_at: string | null;
}

interface DispatchResult {
  success: boolean;
  dispatched: boolean;
  broadcast?: boolean;
  offers_sent?: number;
  expires_at?: string;
  drivers?: Driver[];
  message?: string;
  subtext?: string;
  error?: string;
}

export function useDispatch() {
  const [isSearching, setIsSearching] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [maxSearchTimeMinutes, setMaxSearchTimeMinutes] = useState(3);
  const [currentOffers, setCurrentOffers] = useState<TripOffer[]>([]);
  const [acceptedDriver, setAcceptedDriver] = useState<Driver | null>(null);
  
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const realtimeChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

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
      if (realtimeChannelRef.current) {
        supabase.removeChannel(realtimeChannelRef.current);
      }
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

  // Subscribe to realtime offer updates for a trip
  const subscribeToOffers = useCallback((tripId: string) => {
    // Cleanup existing subscription
    if (realtimeChannelRef.current) {
      supabase.removeChannel(realtimeChannelRef.current);
    }

    const channel = supabase
      .channel(`trip-offers-${tripId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'trip_offers',
          filter: `trip_id=eq.${tripId}`
        },
        (payload) => {
          console.log('[useDispatch] Offer update:', payload);
          
          if (payload.eventType === 'INSERT') {
            const newOffer = payload.new as TripOffer;
            setCurrentOffers(prev => [...prev, newOffer]);
          } else if (payload.eventType === 'UPDATE') {
            const updatedOffer = payload.new as TripOffer;
            setCurrentOffers(prev => 
              prev.map(o => o.id === updatedOffer.id ? updatedOffer : o)
            );
            
            // Check if a driver accepted
            if (updatedOffer.status === 'accepted') {
              setAcceptedDriver({
                id: updatedOffer.driver_id,
                name: '', // Will be filled by trip update
                driver_code: null,
                distance_km: updatedOffer.distance_km,
                priority_score: updatedOffer.priority_score
              });
            }
          }
        }
      )
      .subscribe();

    realtimeChannelRef.current = channel;
  }, []);

  // Subscribe to trip status updates
  const subscribeToTrip = useCallback((tripId: string, onAccepted: (driverId: string) => void) => {
    const channel = supabase
      .channel(`trip-status-${tripId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'trips',
          filter: `id=eq.${tripId}`
        },
        (payload) => {
          console.log('[useDispatch] Trip update:', payload);
          const trip = payload.new as { status: string; driver_id: string | null; confirmed_driver_id: string | null };
          
          if (trip.status === 'accepted' && trip.confirmed_driver_id) {
            onAccepted(trip.confirmed_driver_id);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const dispatchTrip = async (
    tripId: string,
    pickupLat: number,
    pickupLng: number,
    vehicleTypeId?: string,
    maxDistanceKm = 10,
    customTimeoutSeconds?: number
  ): Promise<DispatchResult> => {
    const timeoutSeconds = customTimeoutSeconds ?? maxSearchTimeMinutes * 60;
    
    setIsSearching(true);
    setCurrentOffers([]);
    setAcceptedDriver(null);
    startCountdown(timeoutSeconds);

    // Subscribe to offer updates
    subscribeToOffers(tripId);

    // Set timeout to stop searching and mark trip as expired
    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearching(false);
      stopCountdown();
      
      // Mark trip as no_drivers if still pending
      try {
        await supabase
          .from('trips')
          .update({ status: 'no_drivers' })
          .eq('id', tripId)
          .eq('status', 'offered'); // Only update if still in offered status
          
        // Expire all pending offers
        await supabase
          .from('trip_offers')
          .update({ status: 'expired' })
          .eq('trip_id', tripId)
          .eq('status', 'offered');
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
          max_drivers: 5, // Broadcast to up to 5 drivers
          offer_timeout_seconds: timeoutSeconds
        }
      });

      if (error) throw error;

      if (!data.success || !data.dispatched) {
        // Clear timeout since dispatch failed
        if (searchTimeoutRef.current) {
          clearTimeout(searchTimeoutRef.current);
          searchTimeoutRef.current = null;
        }
        stopCountdown();
        setIsSearching(false);
        
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

      // Set up subscription for when a driver accepts
      const unsubscribe = subscribeToTrip(tripId, async (driverId) => {
        // Clear timeout - driver accepted!
        if (searchTimeoutRef.current) {
          clearTimeout(searchTimeoutRef.current);
          searchTimeoutRef.current = null;
        }
        stopCountdown();
        setIsSearching(false);
        
        // Get driver info
        const { data: driver } = await supabase
          .from('drivers')
          .select('id, first_name, last_name, driver_code, rating')
          .eq('id', driverId)
          .single();
        
        if (driver) {
          const acceptedDriverInfo = data.drivers?.find((d: Driver) => d.id === driverId);
          setAcceptedDriver({
            id: driver.id,
            name: `${driver.first_name} ${driver.last_name}`,
            driver_code: driver.driver_code,
            distance_km: acceptedDriverInfo?.distance_km || 0,
            priority_score: acceptedDriverInfo?.priority_score || 0
          });
          
          toast.success('Driver found!', {
            description: `${driver.first_name} ${driver.last_name} is on the way!`
          });
        }
        
        unsubscribe();
      });

      toast.info(`Finding driver...`, {
        description: `Sent to ${data.offers_sent} nearby drivers`
      });

      return {
        success: true,
        dispatched: true,
        broadcast: true,
        offers_sent: data.offers_sent,
        expires_at: data.expires_at,
        drivers: data.drivers
      };
    } catch (err) {
      console.error('Error dispatching trip:', err);
      
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
      stopCountdown();
      setIsSearching(false);
      
      toast.error('No drivers available right now.', {
        description: 'Please try again in a few minutes or adjust your pickup location.'
      });
      
      return {
        success: false,
        dispatched: false,
        error: err instanceof Error ? err.message : 'Unknown error'
      };
    }
  };

  const cancelSearch = useCallback(async (tripId?: string) => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    stopCountdown();
    setIsSearching(false);
    setCurrentOffers([]);
    setAcceptedDriver(null);
    
    // Cleanup realtime subscription
    if (realtimeChannelRef.current) {
      supabase.removeChannel(realtimeChannelRef.current);
      realtimeChannelRef.current = null;
    }
    
    // If tripId provided, cancel the trip and withdraw all offers
    if (tripId) {
      try {
        await supabase
          .from('trips')
          .update({ status: 'cancelled' })
          .eq('id', tripId);
          
        await supabase
          .from('trip_offers')
          .update({ status: 'withdrawn' })
          .eq('trip_id', tripId)
          .eq('status', 'offered');
      } catch (err) {
        console.error('Error cancelling trip:', err);
      }
    }
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
    currentOffers,
    acceptedDriver,
    dispatchTrip,
    cancelSearch
  };
}
