import { useState, useEffect, useRef, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { MapPin, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PlaceResult {
  address: string;
  lat: number;
  lng: number;
  placeId: string;
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
  radiusBiasMeters?: number;
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
  radiusBiasMeters = 30000, // 30km default
}: PlacesAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<google.maps.places.AutocompletePrediction[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const autocompleteService = useRef<google.maps.places.AutocompleteService | null>(null);
  const placesService = useRef<google.maps.places.PlacesService | null>(null);
  const sessionToken = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  // Initialize Google Places services (handles async script loading)
  useEffect(() => {
    const init = () => {
      if (typeof google !== 'undefined' && google.maps?.places) {
        autocompleteService.current = new google.maps.places.AutocompleteService();
        const tempDiv = document.createElement('div');
        placesService.current = new google.maps.places.PlacesService(tempDiv);
        sessionToken.current = new google.maps.places.AutocompleteSessionToken();
        return true;
      }
      return false;
    };

    if (init()) return;

    // Poll for Google Maps API availability (loaded async)
    const interval = setInterval(() => {
      if (init()) clearInterval(interval);
    }, 300);

    return () => clearInterval(interval);
  }, []);

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

  // Build autocomplete request with location bias
  const buildAutocompleteRequest = useCallback((input: string): google.maps.places.AutocompletionRequest => {
    const request: google.maps.places.AutocompletionRequest = {
      input,
      sessionToken: sessionToken.current!,
    };

    // Determine the bias location: prefer user GPS, fallback to service area center
    const biasLocation = userLocation || serviceAreaCenter;
    
    if (biasLocation) {
      // Apply location bias with radius
      request.location = new google.maps.LatLng(biasLocation.lat, biasLocation.lng);
      request.radius = radiusBiasMeters;
    }

    // Apply country restriction if service area has a country code
    // This is a "soft" restriction - results will be biased but not strictly limited
    if (serviceAreaCountryCode) {
      request.componentRestrictions = {
        country: serviceAreaCountryCode.toLowerCase(),
      };
    }

    return request;
  }, [userLocation, serviceAreaCenter, serviceAreaCountryCode, radiusBiasMeters]);

  // Fetch suggestions from Google Places
  const fetchSuggestions = useCallback(async (input: string) => {
    if (!input.trim() || !autocompleteService.current) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    setIsLoading(true);

    try {
      const request = buildAutocompleteRequest(input);
      
      autocompleteService.current.getPlacePredictions(
        request,
        (predictions, status) => {
          setIsLoading(false);
          
          if (status === google.maps.places.PlacesServiceStatus.OK && predictions) {
            setSuggestions(predictions);
            setIsOpen(true);
            setHighlightedIndex(-1);
          } else if (status === google.maps.places.PlacesServiceStatus.ZERO_RESULTS) {
            setSuggestions([]);
            setIsOpen(false);
          } else {
            console.warn('Places API error:', status);
            setSuggestions([]);
          }
        }
      );
    } catch (error) {
      console.error('Error fetching place suggestions:', error);
      setIsLoading(false);
      setSuggestions([]);
    }
  }, [buildAutocompleteRequest]);

  // Debounced input handler
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);

    // Clear previous timer
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    // Debounce API calls
    debounceTimer.current = setTimeout(() => {
      fetchSuggestions(newValue);
    }, 300);
  };

  // Handle suggestion selection
  const handleSelectSuggestion = (prediction: google.maps.places.AutocompletePrediction) => {
    onChange(prediction.description);
    setSuggestions([]);
    setIsOpen(false);

    // Fetch place details for coordinates
    if (placesService.current && onPlaceSelect) {
      placesService.current.getDetails(
        {
          placeId: prediction.place_id,
          fields: ['geometry', 'formatted_address'],
          sessionToken: sessionToken.current!,
        },
        (place, status) => {
          // Generate new session token after selection
          sessionToken.current = new google.maps.places.AutocompleteSessionToken();

          if (status === google.maps.places.PlacesServiceStatus.OK && place?.geometry?.location) {
            onPlaceSelect({
              address: place.formatted_address || prediction.description,
              lat: place.geometry.location.lat(),
              lng: place.geometry.location.lng(),
              placeId: prediction.place_id,
            });
          }
        }
      );
    }
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || suggestions.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((prev) => 
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) => 
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
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

  // Clear input
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
          className={cn(
            icon !== 'none' && 'pl-10',
            value && 'pr-8',
            inputClassName
          )}
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

      {/* Suggestions Dropdown */}
      {isOpen && suggestions.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-background border border-border rounded-md shadow-lg max-h-60 overflow-y-auto">
          {suggestions.map((prediction, index) => (
            <button
              key={prediction.place_id}
              type="button"
              onClick={() => handleSelectSuggestion(prediction)}
              className={cn(
                'w-full px-3 py-2 text-left text-sm flex items-start gap-2 hover:bg-accent transition-colors',
                index === highlightedIndex && 'bg-accent'
              )}
            >
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">
                  {prediction.structured_formatting?.main_text || prediction.description}
                </div>
                {prediction.structured_formatting?.secondary_text && (
                  <div className="text-xs text-muted-foreground truncate">
                    {prediction.structured_formatting.secondary_text}
                  </div>
                )}
              </div>
            </button>
          ))}
          <div className="px-3 py-1.5 text-xs text-muted-foreground border-t bg-muted/50 flex items-center gap-1">
            <img 
              src="https://maps.gstatic.com/mapfiles/api-3/images/powered-by-google-on-white3.png" 
              alt="Powered by Google" 
              className="h-3"
            />
          </div>
        </div>
      )}
    </div>
  );
}
