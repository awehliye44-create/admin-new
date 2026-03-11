import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Trash2, Undo, MapPin, AlertTriangle, Check, Ruler } from 'lucide-react';

interface LatLng {
  lat: number;
  lng: number;
}

interface GeoJSON {
  type: string;
  coordinates: number[][][];
}

interface RegionBoundary {
  id: string;
  name: string;
  geo_boundary: GeoJSON | LatLng[] | null;
}

interface ServiceAreaBoundaryMapProps {
  boundary: GeoJSON | LatLng[] | null;
  region: RegionBoundary | null;
  onBoundaryChange: (boundary: GeoJSON | null) => void;
  isEditable?: boolean;
  height?: string;
}

declare global {
  interface Window {
    google: any;
    initServiceAreaMap: () => void;
  }
}

// Convert various boundary formats to LatLng array
function normalizeToLatLng(boundary: GeoJSON | LatLng[] | null): LatLng[] {
  if (!boundary) return [];
  
  // Already LatLng array
  if (Array.isArray(boundary) && boundary.length > 0 && 'lat' in boundary[0]) {
    return boundary as LatLng[];
  }
  
  // GeoJSON format
  if (typeof boundary === 'object' && 'coordinates' in boundary) {
    const coords = (boundary as GeoJSON).coordinates?.[0];
    if (coords) {
      return coords.slice(0, -1).map((c: number[]) => ({ lat: c[1], lng: c[0] }));
    }
  }
  
  return [];
}

// Convert LatLng array to GeoJSON
function latLngToGeoJSON(points: LatLng[]): GeoJSON | null {
  if (points.length < 3) return null;
  const coordinates = points.map(p => [p.lng, p.lat]);
  coordinates.push(coordinates[0]); // Close the polygon
  return { type: 'Polygon', coordinates: [coordinates] };
}

export function ServiceAreaBoundaryMap({
  boundary,
  region,
  onBoundaryChange,
  isEditable = true,
  height = '400px',
}: ServiceAreaBoundaryMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const googleMapRef = useRef<any>(null);
  const polygonRef = useRef<any>(null);
  const regionPolygonRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const clickListenerRef = useRef<any>(null);
  
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [points, setPoints] = useState<LatLng[]>([]);
  const [isDrawing, setIsDrawing] = useState(true);
  const [validationWarning, setValidationWarning] = useState<string | null>(null);
  const boundaryInitializedRef = useRef(false);
  const internalUpdateRef = useRef(false);

  // Use ref to track isDrawing for click handler
  const isDrawingRef = useRef(isDrawing);
  useEffect(() => {
    isDrawingRef.current = isDrawing;
  }, [isDrawing]);

  // Load Google Maps script
  useEffect(() => {
    if (window.google?.maps) {
      setIsMapLoaded(true);
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${import.meta.env.VITE_GOOGLE_MAPS_API_KEY}&libraries=drawing,geometry`;
    script.async = true;
    script.defer = true;
    script.onload = () => setIsMapLoaded(true);
    document.head.appendChild(script);
  }, []);

  // Initialize from existing boundary (only on mount or external prop change)
  useEffect(() => {
    // Skip if this update was triggered by our own onBoundaryChange call
    if (internalUpdateRef.current) {
      internalUpdateRef.current = false;
      return;
    }
    const normalizedBoundary = normalizeToLatLng(boundary);
    if (normalizedBoundary.length >= 3) {
      setPoints(normalizedBoundary);
      setIsDrawing(false);
      boundaryInitializedRef.current = true;
    } else if (!boundaryInitializedRef.current) {
      setPoints([]);
      setIsDrawing(true);
    }
  }, [boundary]);

  // Handle map click to add points
  const handleMapClick = useCallback((e: any) => {
    if (!isDrawingRef.current) return;
    const newPoint = { lat: e.latLng.lat(), lng: e.latLng.lng() };
    setPoints(prev => [...prev, newPoint]);
  }, []);

  // Get center from region or default
  const getMapCenter = useCallback(() => {
    const regionBoundary = normalizeToLatLng(region?.geo_boundary || null);
    if (regionBoundary.length > 0) {
      const avgLat = regionBoundary.reduce((sum, p) => sum + p.lat, 0) / regionBoundary.length;
      const avgLng = regionBoundary.reduce((sum, p) => sum + p.lng, 0) / regionBoundary.length;
      return { lat: avgLat, lng: avgLng };
    }
    return { lat: 51.5074, lng: -0.1278 }; // London default
  }, [region]);

  // Initialize map
  useEffect(() => {
    if (!isMapLoaded || !mapRef.current) return;

    const center = getMapCenter();

    googleMapRef.current = new window.google.maps.Map(mapRef.current, {
      center,
      zoom: 11,
      mapTypeId: 'roadmap',
      mapTypeControl: true,
      mapTypeControlOptions: {
        style: window.google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
        position: window.google.maps.ControlPosition.TOP_LEFT,
      },
      fullscreenControl: true,
      styles: [
        { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
      ],
    });

    // Draw region boundary (parent boundary)
    const regionBoundary = normalizeToLatLng(region?.geo_boundary || null);
    if (regionBoundary.length >= 3) {
      regionPolygonRef.current = new window.google.maps.Polygon({
        paths: regionBoundary,
        strokeColor: '#6B7280',
        strokeOpacity: 0.8,
        strokeWeight: 2,
        fillColor: '#6B7280',
        fillOpacity: 0.05,
        map: googleMapRef.current,
        clickable: false,
      });

      // Fit to region bounds
      const bounds = new window.google.maps.LatLngBounds();
      regionBoundary.forEach(p => bounds.extend(p));
      googleMapRef.current.fitBounds(bounds, 50);
    }

    // Add click listener for drawing
    if (isEditable) {
      clickListenerRef.current = googleMapRef.current.addListener('click', handleMapClick);
    }

    return () => {
      if (clickListenerRef.current) {
        window.google.maps.event.removeListener(clickListenerRef.current);
      }
    };
  }, [isMapLoaded, isEditable, handleMapClick, getMapCenter, region]);

  // Check if point is inside region
  const isPointInRegion = useCallback((point: LatLng): boolean => {
    const regionBoundary = normalizeToLatLng(region?.geo_boundary || null);
    if (regionBoundary.length < 3 || !window.google?.maps?.geometry) return true;
    
    const regionPath = regionBoundary.map(p => 
      new window.google.maps.LatLng(p.lat, p.lng)
    );
    const regionPolygon = new window.google.maps.Polygon({ paths: regionPath });
    
    return window.google.maps.geometry.poly.containsLocation(
      new window.google.maps.LatLng(point.lat, point.lng),
      regionPolygon
    );
  }, [region]);

  // Validate boundary
  useEffect(() => {
    if (points.length >= 3) {
      const outsidePoints = points.filter(p => !isPointInRegion(p));
      if (outsidePoints.length > 0) {
        setValidationWarning(`${outsidePoints.length} point(s) are outside the region boundary`);
      } else {
        setValidationWarning(null);
      }
    } else {
      setValidationWarning(null);
    }
  }, [points, isPointInRegion]);

  // Update polygon when points change
  useEffect(() => {
    if (!googleMapRef.current || !isMapLoaded) return;

    // Clear existing polygon
    if (polygonRef.current) {
      polygonRef.current.setMap(null);
    }

    // Clear existing markers
    markersRef.current.forEach(marker => marker.setMap(null));
    markersRef.current = [];

    if (points.length >= 3) {
      // Create polygon
      polygonRef.current = new window.google.maps.Polygon({
        paths: points,
        strokeColor: '#10b981',
        strokeOpacity: 0.9,
        strokeWeight: 2,
        fillColor: '#10b981',
        fillOpacity: 0.2,
        editable: isEditable && !isDrawing,
        draggable: false,
        map: googleMapRef.current,
      });

      // Listen for polygon edits
      if (isEditable && !isDrawing) {
        const path = polygonRef.current.getPath();
        window.google.maps.event.addListener(path, 'set_at', () => {
          const newPoints = getPolygonPoints();
          setPoints(newPoints);
        });
        window.google.maps.event.addListener(path, 'insert_at', () => {
          const newPoints = getPolygonPoints();
          setPoints(newPoints);
        });
      }
    }

    // Add markers for points while drawing
    if (isDrawing && points.length > 0) {
      points.forEach((point, index) => {
        const isOutside = !isPointInRegion(point);
        const marker = new window.google.maps.Marker({
          position: point,
          map: googleMapRef.current,
          label: {
            text: String(index + 1),
            color: 'white',
            fontSize: '11px',
            fontWeight: 'bold',
          },
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            scale: 14,
            fillColor: isOutside ? '#ef4444' : '#10b981',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
        });
        markersRef.current.push(marker);
      });

      // Draw lines between points while drawing
      if (points.length >= 2) {
        const polyline = new window.google.maps.Polyline({
          path: [...points, points[0]],
          strokeColor: '#10b981',
          strokeOpacity: 0.7,
          strokeWeight: 2,
          map: googleMapRef.current,
        });
        markersRef.current.push(polyline);
      }
    }
  }, [points, isMapLoaded, isDrawing, isEditable, isPointInRegion]);

  // Notify parent of changes
  useEffect(() => {
    if (points.length >= 3 && !isDrawing) {
      onBoundaryChange(latLngToGeoJSON(points));
    }
  }, [points, isDrawing, onBoundaryChange]);

  const getPolygonPoints = useCallback((): LatLng[] => {
    if (!polygonRef.current) return [];
    const path = polygonRef.current.getPath();
    const newPoints: LatLng[] = [];
    for (let i = 0; i < path.getLength(); i++) {
      const latLng = path.getAt(i);
      newPoints.push({ lat: latLng.lat(), lng: latLng.lng() });
    }
    return newPoints;
  }, []);

  const calculateArea = (): string => {
    if (!window.google?.maps?.geometry || points.length < 3) return '0';
    const path = points.map(p => new window.google.maps.LatLng(p.lat, p.lng));
    const area = window.google.maps.geometry.spherical.computeArea(path);
    if (area > 1000000) {
      return `${(area / 1000000).toFixed(2)} km²`;
    }
    return `${Math.round(area).toLocaleString()} m²`;
  };

  const handleUndo = () => {
    if (points.length > 0) {
      setPoints(prev => prev.slice(0, -1));
    }
  };

  const handleClear = () => {
    setPoints([]);
    setIsDrawing(true);
    setValidationWarning(null);
    if (polygonRef.current) {
      polygonRef.current.setMap(null);
      polygonRef.current = null;
    }
    onBoundaryChange(null);
  };

  const handleFinishDrawing = () => {
    if (points.length >= 3) {
      setIsDrawing(false);
      onBoundaryChange(latLngToGeoJSON(points));
    }
  };

  const handleStartRedraw = () => {
    setIsDrawing(true);
    setPoints([]);
    if (polygonRef.current) {
      polygonRef.current.setMap(null);
      polygonRef.current = null;
    }
  };

  const hasValidBoundary = points.length >= 3 && !isDrawing;

  return (
    <div className="space-y-3">
      {/* Region info */}
      {region && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline" className="gap-1">
            <MapPin className="h-3 w-3" />
            Region: {region.name}
          </Badge>
          {normalizeToLatLng(region.geo_boundary).length === 0 && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              No region boundary defined
            </Badge>
          )}
        </div>
      )}

      {/* Map */}
      <div
        ref={mapRef}
        style={{ height, width: '100%' }}
        className="rounded-lg border border-border overflow-hidden"
      />
      
      {/* Validation Warning */}
      {validationWarning && (
        <div className="flex items-center gap-2 text-amber-600 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 rounded-md text-sm">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {validationWarning}
        </div>
      )}

      {/* Status and Controls */}
      {isEditable && (
        <div className="flex items-center justify-between gap-2 p-3 bg-muted/50 rounded-lg">
          <div className="text-sm text-muted-foreground">
            {isDrawing ? (
              points.length < 3 ? (
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4 text-primary" />
                  Click on the map to add points ({points.length}/3 minimum)
                </span>
              ) : (
                <span className="flex items-center gap-1 text-green-600">
                  <Check className="h-4 w-4" />
                  {points.length} points added - Ready to finish
                </span>
              )
            ) : (
              <span className="flex items-center gap-2 text-green-600">
                <Check className="h-4 w-4" />
                Boundary set ({points.length} points)
                <Badge variant="secondary" className="gap-1 ml-2">
                  <Ruler className="h-3 w-3" />
                  {calculateArea()}
                </Badge>
              </span>
            )}
          </div>
          
          <div className="flex gap-2">
            {isDrawing ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleUndo}
                  disabled={points.length === 0}
                >
                  <Undo className="h-4 w-4 mr-1" />
                  Undo
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleFinishDrawing}
                  disabled={points.length < 3}
                  className="bg-green-600 hover:bg-green-700"
                >
                  Finish Drawing
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleStartRedraw}
                >
                  Redraw
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleClear}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Clear
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
