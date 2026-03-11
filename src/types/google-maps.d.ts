/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minimal ambient declarations for Google Maps JS API.
 * The full @types/google.maps package cannot be auto-discovered by TypeScript
 * because the package name contains a dot. This file provides the subset
 * of types used by this project.
 */

declare namespace google.maps {
  class Map {
    constructor(mapDiv: Element, opts?: MapOptions);
    setCenter(latLng: LatLngLiteral | LatLng): void;
    setZoom(zoom: number): void;
    fitBounds(bounds: LatLngBounds, padding?: number | Padding): void;
    getZoom(): number | undefined;
  }

  class Marker {
    constructor(opts?: MarkerOptions);
    setMap(map: Map | null): void;
    setPosition(latLng: LatLngLiteral | LatLng): void;
    setIcon(icon: string | Icon | Symbol): void;
    getPosition(): LatLng | null;
    addListener(eventName: string, handler: (...args: any[]) => void): MapsEventListener;
  }

  class Polyline {
    constructor(opts?: PolylineOptions);
    setMap(map: Map | null): void;
    setPath(path: LatLngLiteral[] | LatLng[]): void;
  }

  class LatLng {
    constructor(lat: number, lng: number);
    lat(): number;
    lng(): number;
  }

  class LatLngBounds {
    constructor(sw?: LatLngLiteral | LatLng, ne?: LatLngLiteral | LatLng);
    extend(point: LatLngLiteral | LatLng): LatLngBounds;
    getCenter(): LatLng;
  }

  class InfoWindow {
    constructor(opts?: InfoWindowOptions);
    open(map?: Map, anchor?: Marker): void;
    close(): void;
    setContent(content: string | Element): void;
  }

  interface MapsEventListener {
    remove(): void;
  }

  interface LatLngLiteral {
    lat: number;
    lng: number;
  }

  interface MapOptions {
    center?: LatLngLiteral | LatLng;
    zoom?: number;
    styles?: any[];
    mapTypeId?: string;
    disableDefaultUI?: boolean;
    zoomControl?: boolean;
    streetViewControl?: boolean;
    mapTypeControl?: boolean;
    fullscreenControl?: boolean;
  }

  interface MarkerOptions {
    position?: LatLngLiteral | LatLng;
    map?: Map;
    title?: string;
    icon?: string | Icon | Symbol;
    label?: string | MarkerLabel;
    draggable?: boolean;
    visible?: boolean;
    zIndex?: number;
  }

  interface MarkerLabel {
    text: string;
    color?: string;
    fontSize?: string;
    fontWeight?: string;
  }

  interface Icon {
    url: string;
    size?: Size;
    scaledSize?: Size;
    origin?: Point;
    anchor?: Point;
  }

  interface Symbol {
    path: SymbolPath | string;
    fillColor?: string;
    fillOpacity?: number;
    scale?: number;
    strokeColor?: string;
    strokeWeight?: number;
    strokeOpacity?: number;
    rotation?: number;
  }

  enum SymbolPath {
    CIRCLE = 0,
    FORWARD_CLOSED_ARROW = 1,
    FORWARD_OPEN_ARROW = 2,
    BACKWARD_CLOSED_ARROW = 3,
    BACKWARD_OPEN_ARROW = 4,
  }

  interface PolylineOptions {
    path?: LatLngLiteral[] | LatLng[];
    geodesic?: boolean;
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWeight?: number;
    map?: Map;
  }

  interface InfoWindowOptions {
    content?: string | Element;
    position?: LatLngLiteral | LatLng;
  }

  class Size {
    constructor(width: number, height: number);
    width: number;
    height: number;
  }

  class Point {
    constructor(x: number, y: number);
    x: number;
    y: number;
  }

  interface Padding {
    top: number;
    right: number;
    bottom: number;
    left: number;
  }

  namespace places {
    class AutocompleteService {
      getPlacePredictions(
        request: AutocompletionRequest,
        callback?: (results: AutocompletePrediction[] | null, status: PlacesServiceStatus) => void
      ): Promise<AutocompleteResponse>;
    }

    class PlacesService {
      constructor(attrContainer: Element | Map);
      getDetails(
        request: PlaceDetailsRequest,
        callback: (result: PlaceResult | null, status: PlacesServiceStatus) => void
      ): void;
    }

    class AutocompleteSessionToken {}

    interface AutocompletionRequest {
      input: string;
      sessionToken?: AutocompleteSessionToken;
      componentRestrictions?: ComponentRestrictions;
      types?: string[];
      bounds?: LatLngBounds;
      location?: LatLng;
      radius?: number;
    }

    interface ComponentRestrictions {
      country: string | string[];
    }

    interface AutocompleteResponse {
      predictions: AutocompletePrediction[];
    }

    interface AutocompletePrediction {
      place_id: string;
      description: string;
      structured_formatting: {
        main_text: string;
        secondary_text: string;
      };
      types: string[];
    }

    interface PlaceDetailsRequest {
      placeId: string;
      fields?: string[];
      sessionToken?: AutocompleteSessionToken;
    }

    interface PlaceResult {
      place_id?: string;
      name?: string;
      formatted_address?: string;
      geometry?: PlaceGeometry;
      address_components?: GeocoderAddressComponent[];
      types?: string[];
    }

    interface PlaceGeometry {
      location?: LatLng;
      viewport?: LatLngBounds;
    }

    interface GeocoderAddressComponent {
      long_name: string;
      short_name: string;
      types: string[];
    }

    enum PlacesServiceStatus {
      OK = 'OK',
      ZERO_RESULTS = 'ZERO_RESULTS',
      INVALID_REQUEST = 'INVALID_REQUEST',
      OVER_QUERY_LIMIT = 'OVER_QUERY_LIMIT',
      REQUEST_DENIED = 'REQUEST_DENIED',
      UNKNOWN_ERROR = 'UNKNOWN_ERROR',
      NOT_FOUND = 'NOT_FOUND',
    }
  }

  namespace event {
    function addListener(instance: any, eventName: string, handler: (...args: any[]) => void): MapsEventListener;
    function removeListener(listener: MapsEventListener): void;
    function clearInstanceListeners(instance: any): void;
  }
}

// Declare google as a global variable (loaded via script tag at runtime)
declare var google: typeof google;
