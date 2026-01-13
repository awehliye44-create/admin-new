import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { RegionSettings, DEFAULT_REGION_SETTINGS } from '@/lib/regionSettings';

interface UseServiceAreaSettingsResult {
  settings: RegionSettings;
  isLoading: boolean;
  error: string | null;
  resolveFromLocation: (lat: number, lng: number) => Promise<RegionSettings | null>;
  resolveFromServiceAreaId: (serviceAreaId: string) => Promise<RegionSettings | null>;
  clearSettings: () => void;
}

// Cache with short TTL (5 minutes)
const CACHE_TTL = 5 * 60 * 1000;

interface CacheEntry {
  settings: RegionSettings;
  timestamp: number;
  cacheKey: string;
}

const settingsCache = new Map<string, CacheEntry>();

/**
 * Hook for resolving and managing service area settings
 * 
 * Resolves currency and distance unit from region based on pickup location.
 * Implements caching with automatic invalidation when region settings change.
 */
export function useServiceAreaSettings(): UseServiceAreaSettingsResult {
  const [settings, setSettings] = useState<RegionSettings>(DEFAULT_REGION_SETTINGS);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastLocationRef = useRef<{ lat: number; lng: number } | null>(null);

  // Clear expired cache entries
  const cleanupCache = useCallback(() => {
    const now = Date.now();
    for (const [key, entry] of settingsCache.entries()) {
      if (now - entry.timestamp > CACHE_TTL) {
        settingsCache.delete(key);
      }
    }
  }, []);

  // Resolve settings from pickup coordinates
  const resolveFromLocation = useCallback(async (lat: number, lng: number): Promise<RegionSettings | null> => {
    setIsLoading(true);
    setError(null);

    const cacheKey = `${lat.toFixed(4)}_${lng.toFixed(4)}`;
    lastLocationRef.current = { lat, lng };

    // Check cache
    const cached = settingsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setSettings(cached.settings);
      setIsLoading(false);
      return cached.settings;
    }

    try {
      const { data, error: invokeError } = await supabase.functions.invoke('resolve-service-area', {
        body: { pickup_lat: lat, pickup_lng: lng }
      });

      if (invokeError) {
        throw invokeError;
      }

      if (!data?.success) {
        setError(data?.error || 'Failed to resolve service area');
        setIsLoading(false);
        return null;
      }

      const resolvedSettings: RegionSettings = {
        region_id: data.settings.region_id,
        region_name: data.settings.region_name,
        currency_code: data.settings.currency_code,
        distance_unit: data.settings.distance_unit as 'mile' | 'km',
        timezone: data.settings.timezone,
        service_area_id: data.settings.service_area_id,
        service_area_name: data.settings.service_area_name,
      };

      // Cache the result
      settingsCache.set(cacheKey, {
        settings: resolvedSettings,
        timestamp: Date.now(),
        cacheKey: data.cache_key || cacheKey,
      });

      setSettings(resolvedSettings);
      setIsLoading(false);
      return resolvedSettings;

    } catch (err) {
      console.error('Error resolving service area:', err);
      setError(err instanceof Error ? err.message : 'Failed to resolve service area');
      setIsLoading(false);
      return null;
    }
  }, []);

  // Resolve settings from service area ID
  const resolveFromServiceAreaId = useCallback(async (serviceAreaId: string): Promise<RegionSettings | null> => {
    setIsLoading(true);
    setError(null);

    const cacheKey = `sa_${serviceAreaId}`;

    // Check cache
    const cached = settingsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setSettings(cached.settings);
      setIsLoading(false);
      return cached.settings;
    }

    try {
      // Fetch service area with region data
      const { data: serviceArea, error: saError } = await supabase
        .from('service_areas')
        .select('id, name, region_id')
        .eq('id', serviceAreaId)
        .single();

      if (saError) throw saError;

      // Fetch region data
      const { data: region, error: regError } = await supabase
        .from('regions')
        .select('id, name, currency_code, distance_unit, timezone, updated_at')
        .eq('id', serviceArea.region_id)
        .single();

      if (regError) throw regError;

      const resolvedSettings: RegionSettings = {
        region_id: region.id,
        region_name: region.name,
        currency_code: region.currency_code,
        distance_unit: region.distance_unit as 'mile' | 'km',
        timezone: region.timezone,
        service_area_id: serviceArea.id,
        service_area_name: serviceArea.name,
      };

      // Cache the result
      settingsCache.set(cacheKey, {
        settings: resolvedSettings,
        timestamp: Date.now(),
        cacheKey: `${region.id}_${region.updated_at}`,
      });

      setSettings(resolvedSettings);
      setIsLoading(false);
      return resolvedSettings;

    } catch (err) {
      console.error('Error resolving settings from service area:', err);
      setError(err instanceof Error ? err.message : 'Failed to resolve settings');
      setIsLoading(false);
      return null;
    }
  }, []);

  // Clear current settings
  const clearSettings = useCallback(() => {
    setSettings(DEFAULT_REGION_SETTINGS);
    setError(null);
    lastLocationRef.current = null;
  }, []);

  // Cleanup cache periodically
  useEffect(() => {
    const interval = setInterval(cleanupCache, CACHE_TTL);
    return () => clearInterval(interval);
  }, [cleanupCache]);

  return {
    settings,
    isLoading,
    error,
    resolveFromLocation,
    resolveFromServiceAreaId,
    clearSettings,
  };
}

/**
 * Clear all cached service area settings
 * Call this when admin updates region/service area settings
 */
export function clearServiceAreaSettingsCache(): void {
  settingsCache.clear();
}
