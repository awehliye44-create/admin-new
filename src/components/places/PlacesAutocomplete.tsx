import { useState, useEffect, useRef, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { MapPin, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MAPBOX_TOKEN } from '@/lib/mapbox';
import {
  isAdminLocationSearchSsotEnabled,
  searchOnecabLocationsForAdmin,
} from '@/lib/searchOnecabLocationsClient';
import { LOCATION_SEARCH_MIN_QUERY_LENGTH } from '../../../shared/onecabLocationSearchSSOT';

interface PlaceResult {
  address: string;
  lat: number;
  lng: number;
  placeId: string;
}

interface MapboxSuggestion {
  id: string;
  place_name: string;
  text: string;
  center: [number, number]; // [lng, lat]
  place_type?: string[];
}

interface PlacesAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onPlaceSelect?: (place: PlaceResult) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  icon?: 'pickup' | 'dropoff' | 'none';
  disabled?: boolean;
  // Location bias settings
  userLocation?: { lat: number; lng: number } | null;
  serviceAreaCenter?: { lat: number; lng: number } | null;
  serviceAreaCountryCode?: string | null;
  /** Bias radius in metres (used as Mapbox proximity hint). */
  radiusBiasMeters?: number;
  /** When set and SSOT rollout is enabled for this SA, uses search-onecab-locations. */
  serviceAreaId?: string | null;
}

export function PlacesAutocomplete({
  value,
  onChange,
  onPlaceSelect,
  placeholder = 'Enter address',
  className,
  inputClassName,
  icon = 'none',
  disabled = false,
  userLocation,
  serviceAreaCenter,
  serviceAreaCountryCode,
  radiusBiasMeters: _radiusBiasMeters = 30000,
  serviceAreaId = null,
}: PlacesAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<MapboxSuggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Click outside to close suggestions
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchSuggestions = useCallback(async (input: string) => {
    if (!input.trim()) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setIsLoading(true);

    try {
      if (serviceAreaId && input.trim().length >= LOCATION_SEARCH_MIN_QUERY_LENGTH) {
        const ssotOn = await isAdminLocationSearchSsotEnabled(serviceAreaId);
        if (ssotOn) {
          const proximity = userLocation || serviceAreaCenter;
          const rows = await searchOnecabLocationsForAdmin({
            query: input,
            service_area_id: serviceAreaId,
            user_latitude: proximity?.lat ?? null,
            user_longitude: proximity?.lng ?? null,
          });
          if (ac.signal.aborted) return;
          const features: MapboxSuggestion[] = rows.map((r) => ({
            id: r.provider_place_id ?? r.id,
            place_name: r.address_text || r.display_name,
            text: r.short_name || r.display_name,
            center: [r.longitude, r.latitude] as [number, number],
            place_type: r.category ? [r.category] : ['poi'],
          }));
          setSuggestions(features);
          setIsOpen(features.length > 0);
          setHighlightedIndex(-1);
          return;
        }
      }

      if (!MAPBOX_TOKEN) {
        setSuggestions([]);
        setIsOpen(false);
        return;
      }

      const proximity = userLocation || serviceAreaCenter;
      const params = new URLSearchParams({
        access_token: MAPBOX_TOKEN,
        autocomplete: 'true',
        limit: '6',
      });
      if (proximity) params.set('proximity', `${proximity.lng},${proximity.lat}`);
      if (serviceAreaCountryCode) params.set('country', serviceAreaCountryCode.toLowerCase());

      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
        input
      )}.json?${params.toString()}`;

      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) throw new Error(`Mapbox geocoding HTTP ${res.status}`);
      const data = await res.json();
      const features = (data?.features || []) as MapboxSuggestion[];
      setSuggestions(features);
      setIsOpen(features.length > 0);
      setHighlightedIndex(-1);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Places autocomplete error:', err);
        setSuggestions([]);
      }
    } finally {
      setIsLoading(false);
    }
  }, [userLocation, serviceAreaCenter, serviceAreaCountryCode, serviceAreaId]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => fetchSuggestions(newValue), 300);
  };

  const handleSelectSuggestion = (feature: MapboxSuggestion) => {
    onChange(feature.place_name);
    setSuggestions([]);
    setIsOpen(false);
    if (onPlaceSelect) {
      onPlaceSelect({
        address: feature.place_name,
        lat: feature.center[1],
        lng: feature.center[0],
        placeId: feature.id,
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || suggestions.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((p) => (p < suggestions.length - 1 ? p + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((p) => (p > 0 ? p - 1 : suggestions.length - 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
          handleSelectSuggestion(suggestions[highlightedIndex]);
        }
        break;
      case 'Escape':
        setIsOpen(false);
        break;
    }
  };

  const handleClear = () => {
    onChange('');
    setSuggestions([]);
    setIsOpen(false);
    inputRef.current?.focus();
  };

  const iconColor = icon === 'pickup' ? 'text-green-500' : icon === 'dropoff' ? 'text-red-500' : 'text-muted-foreground';

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      <div className="relative">
        {icon !== 'none' && (
          <MapPin className={cn('absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4', iconColor)} />
        )}
        <Input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (suggestions.length > 0) setIsOpen(true);
          }}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(icon !== 'none' && 'pl-10', value && 'pr-8', inputClassName)}
        />
        {isLoading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
        {!isLoading && value && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {isOpen && suggestions.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-background border border-border rounded-md shadow-lg max-h-60 overflow-y-auto">
          {suggestions.map((feature, index) => {
            const [main, ...rest] = feature.place_name.split(', ');
            return (
              <button
                key={feature.id}
                type="button"
                onClick={() => handleSelectSuggestion(feature)}
                className={cn(
                  'w-full px-3 py-2 text-left text-sm flex items-start gap-2 hover:bg-accent transition-colors',
                  index === highlightedIndex && 'bg-accent'
                )}
              >
                <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{feature.text || main}</div>
                  {rest.length > 0 && (
                    <div className="text-xs text-muted-foreground truncate">{rest.join(', ')}</div>
                  )}
                </div>
              </button>
            );
          })}
          <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t bg-muted/50">
            Powered by Mapbox
          </div>
        </div>
      )}
    </div>
  );
}
