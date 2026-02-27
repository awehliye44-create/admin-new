import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Trash2, Undo, MapPin, Circle, Hexagon, Target, Check, AlertTriangle, Ruler } from 'lucide-react';

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
  geo_boundary: GeoJSON | null;
}

interface ZoneBoundaryMapProps {
  shapeType: 'polygon' | 'circle';
  existingPolygon: GeoJSON | null;
  existingCircle: { center_lat: number | null; center_lng: number | null; radius_meters: number | null };
  region: RegionBoundary | null;
  color: string;
  onPolygonChange: (boundary: GeoJSON | null) => void;
  onCircleChange: (center_lat: number | null, center_lng: number | null, radius_meters: number | null) => void;
  onShapeTypeChange: (type: 'polygon' | 'circle') => void;
  height?: string;
}

declare global {
  interface Window {
    google: any;
    initZoneMap: () => void;
  }
}

export function ZoneBoundaryMap({
  shapeType,
  existingPolygon,
  existingCircle,
  region,
  color,
  onPolygonChange,
  onCircleChange,
  onShapeTypeChange,
  height = '400px',
}: ZoneBoundaryMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const googleMapRef = useRef<any>(null);
  const polygonRef = useRef<any>(null);
  const circleRef = useRef<any>(null);
  const regionPolygonRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const clickListenerRef = useRef<any>(null);
  const initializedRef = useRef(false);
  const prevExistingDataRef = useRef<string>('');
  
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [points, setPoints] = useState<LatLng[]>([]);
  const [isDrawing, setIsDrawing] = useState(true);
  const [circleCenter, setCircleCenter] = useState<LatLng | null>(null);
  const [circleRadius, setCircleRadius] = useState<number>(500);
  const [validationWarning, setValidationWarning] = useState<string | null>(null);

  // Use refs for click handler
  const isDrawingRef = useRef(isDrawing);
  const shapeTypeRef = useRef(shapeType);
  
  useEffect(() => {
    isDrawingRef.current = isDrawing;
    shapeTypeRef.current = shapeType;
  }, [isDrawing, shapeType]);

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

  // Initialize from existing data - only on actual data changes
  useEffect(() => {
    // Build a stable key from the actual values to detect real changes
    const dataKey = JSON.stringify({
      shapeType,
      polygon: existingPolygon?.coordinates?.[0] ? 'has' : 'none',
      circleLat: existingCircle.center_lat,
      circleLng: existingCircle.center_lng,
      circleR: existingCircle.radius_meters,
    });

    if (dataKey === prevExistingDataRef.current) return;
    prevExistingDataRef.current = dataKey;

    if (shapeType === 'polygon' && existingPolygon?.coordinates?.[0]) {
      const coords = existingPolygon.coordinates[0];
      const loadedPoints = coords.slice(0, -1).map((c: number[]) => ({ lat: c[1], lng: c[0] }));
      setPoints(loadedPoints);
      setIsDrawing(false);
    } else if (shapeType === 'circle' && existingCircle.center_lat && existingCircle.center_lng) {
      setCircleCenter({ lat: existingCircle.center_lat, lng: existingCircle.center_lng });
      setCircleRadius(existingCircle.radius_meters || 500);
      setIsDrawing(false);
    } else if (!initializedRef.current) {
      setPoints([]);
      setCircleCenter(null);
      setIsDrawing(true);
    }
    initializedRef.current = true;
  }, [shapeType, existingPolygon, existingCircle]);

  // Handle map click
  const handleMapClick = useCallback((e: any) => {
    if (!isDrawingRef.current) return;
    
    const newPoint = { lat: e.latLng.lat(), lng: e.latLng.lng() };
    
    if (shapeTypeRef.current === 'polygon') {
      setPoints(prev => [...prev, newPoint]);
    } else {
      // For circle, first click sets center
      setCircleCenter(newPoint);
      setIsDrawing(false);
    }
  }, []);

  // Get center from region or default
  const getMapCenter = useCallback(() => {
    if (region?.geo_boundary?.coordinates?.[0]) {
      const coords = region.geo_boundary.coordinates[0];
      const avgLat = coords.reduce((sum: number, c: number[]) => sum + c[1], 0) / coords.length;
      const avgLng = coords.reduce((sum: number, c: number[]) => sum + c[0], 0) / coords.length;
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
      zoom: 12,
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

    // Draw region boundary
    if (region?.geo_boundary?.coordinates?.[0]) {
      const regionPath = region.geo_boundary.coordinates[0].map((coord: number[]) => ({
        lat: coord[1],
        lng: coord[0]
      }));
      
      regionPolygonRef.current = new window.google.maps.Polygon({
        paths: regionPath,
        strokeColor: '#6B7280',
        strokeOpacity: 0.8,
        strokeWeight: 2,
        strokeDasharray: [5, 5],
        fillColor: '#6B7280',
        fillOpacity: 0.05,
        map: googleMapRef.current,
        clickable: false,
      });

      // Fit to region bounds
      const bounds = new window.google.maps.LatLngBounds();
      regionPath.forEach((p: LatLng) => bounds.extend(p));
      googleMapRef.current.fitBounds(bounds, 50);
    }

    // Add click listener
    clickListenerRef.current = googleMapRef.current.addListener('click', handleMapClick);

    return () => {
      if (clickListenerRef.current) {
        window.google.maps.event.removeListener(clickListenerRef.current);
      }
    };
  }, [isMapLoaded, handleMapClick, getMapCenter, region]);

  // Check if point is inside region
  const isPointInRegion = useCallback((point: LatLng): boolean => {
    if (!region?.geo_boundary?.coordinates?.[0] || !window.google?.maps?.geometry) return true;
    
    const regionPath = region.geo_boundary.coordinates[0].map((coord: number[]) => 
      new window.google.maps.LatLng(coord[1], coord[0])
    );
    const regionPolygon = new window.google.maps.Polygon({ paths: regionPath });
    
    return window.google.maps.geometry.poly.containsLocation(
      new window.google.maps.LatLng(point.lat, point.lng),
      regionPolygon
    );
  }, [region]);

  // Validate zone boundary
  useEffect(() => {
    if (shapeType === 'polygon' && points.length >= 3) {
      const outsidePoints = points.filter(p => !isPointInRegion(p));
      if (outsidePoints.length > 0) {
        setValidationWarning(`${outsidePoints.length} point(s) are outside the region boundary`);
      } else {
        setValidationWarning(null);
      }
    } else if (shapeType === 'circle' && circleCenter) {
      if (!isPointInRegion(circleCenter)) {
        setValidationWarning('Circle center is outside the region boundary');
      } else {
        setValidationWarning(null);
      }
    } else {
      setValidationWarning(null);
    }
  }, [points, circleCenter, shapeType, isPointInRegion]);

  // Update polygon on map
  useEffect(() => {
    if (!googleMapRef.current || !isMapLoaded) return;

    // Clear existing polygon
    if (polygonRef.current) {
      polygonRef.current.setMap(null);
      polygonRef.current = null;
    }

    // Clear existing markers
    markersRef.current.forEach(marker => marker.setMap(null));
    markersRef.current = [];

    if (shapeType !== 'polygon') return;

    if (points.length >= 3) {
      // Create polygon
      polygonRef.current = new window.google.maps.Polygon({
        paths: points,
        strokeColor: color,
        strokeOpacity: 0.9,
        strokeWeight: 2,
        fillColor: color,
        fillOpacity: 0.25,
        editable: !isDrawing,
        draggable: false,
        map: googleMapRef.current,
      });

      // Listen for edits when not drawing
      if (!isDrawing) {
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

    // Add markers while drawing
    if (isDrawing && points.length > 0) {
      points.forEach((point, index) => {
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
            fillColor: color,
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
        });
        markersRef.current.push(marker);
      });

      // Draw connecting lines
      if (points.length >= 2) {
        const polyline = new window.google.maps.Polyline({
          path: [...points, points[0]],
          strokeColor: color,
          strokeOpacity: 0.7,
          strokeWeight: 2,
          strokeDasharray: [4, 4],
          map: googleMapRef.current,
        });
        markersRef.current.push(polyline);
      }
    }
  }, [points, isMapLoaded, isDrawing, shapeType, color]);

  // Update circle on map
  useEffect(() => {
    if (!googleMapRef.current || !isMapLoaded) return;

    // Clear existing circle
    if (circleRef.current) {
      circleRef.current.setMap(null);
      circleRef.current = null;
    }

    // Clear existing markers
    markersRef.current.forEach(marker => marker.setMap(null));
    markersRef.current = [];

    if (shapeType !== 'circle' || !circleCenter) return;

    // Create circle
    circleRef.current = new window.google.maps.Circle({
      center: circleCenter,
      radius: circleRadius,
      strokeColor: color,
      strokeOpacity: 0.9,
      strokeWeight: 2,
      fillColor: color,
      fillOpacity: 0.25,
      editable: true,
      draggable: true,
      map: googleMapRef.current,
    });

    // Add center marker
    const centerMarker = new window.google.maps.Marker({
      position: circleCenter,
      map: googleMapRef.current,
      icon: {
        path: window.google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: color,
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWeight: 2,
      },
    });
    markersRef.current.push(centerMarker);

    // Listen for circle edits
    window.google.maps.event.addListener(circleRef.current, 'radius_changed', () => {
      setCircleRadius(Math.round(circleRef.current.getRadius()));
    });
    window.google.maps.event.addListener(circleRef.current, 'center_changed', () => {
      const newCenter = circleRef.current.getCenter();
      setCircleCenter({ lat: newCenter.lat(), lng: newCenter.lng() });
    });

  }, [circleCenter, circleRadius, isMapLoaded, shapeType, color]);

  // Notify parent of changes
  useEffect(() => {
    if (shapeType === 'polygon' && points.length >= 3 && !isDrawing) {
      const coordinates = points.map(p => [p.lng, p.lat]);
      coordinates.push(coordinates[0]); // Close polygon
      onPolygonChange({ type: 'Polygon', coordinates: [coordinates] });
    } else if (shapeType === 'polygon') {
      onPolygonChange(null);
    }
  }, [points, isDrawing, shapeType, onPolygonChange]);

  useEffect(() => {
    if (shapeType === 'circle' && circleCenter && !isDrawing) {
      onCircleChange(circleCenter.lat, circleCenter.lng, circleRadius);
    } else if (shapeType === 'circle') {
      onCircleChange(null, null, null);
    }
  }, [circleCenter, circleRadius, isDrawing, shapeType, onCircleChange]);

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

  const handleUndo = () => {
    if (shapeType === 'polygon' && points.length > 0) {
      setPoints(prev => prev.slice(0, -1));
    }
  };

  const handleClear = () => {
    setPoints([]);
    setCircleCenter(null);
    setCircleRadius(500);
    setIsDrawing(true);
    setValidationWarning(null);
    
    if (polygonRef.current) {
      polygonRef.current.setMap(null);
      polygonRef.current = null;
    }
    if (circleRef.current) {
      circleRef.current.setMap(null);
      circleRef.current = null;
    }
    onPolygonChange(null);
    onCircleChange(null, null, null);
  };

  const handleFinishDrawing = () => {
    if (shapeType === 'polygon' && points.length >= 3) {
      setIsDrawing(false);
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

  const calculatePolygonArea = (): string => {
    if (!window.google?.maps?.geometry || points.length < 3) return '0';
    const path = points.map(p => new window.google.maps.LatLng(p.lat, p.lng));
    const area = window.google.maps.geometry.spherical.computeArea(path);
    if (area > 1000000) {
      return `${(area / 1000000).toFixed(2)} km²`;
    }
    return `${Math.round(area).toLocaleString()} m²`;
  };

  const calculateCircleArea = (): string => {
    const area = Math.PI * Math.pow(circleRadius, 2);
    if (area > 1000000) {
      return `${(area / 1000000).toFixed(2)} km²`;
    }
    return `${Math.round(area).toLocaleString()} m²`;
  };

  const hasValidShape = shapeType === 'polygon' 
    ? points.length >= 3 && !isDrawing 
    : circleCenter !== null && !isDrawing;

  return (
    <div className="space-y-4">
      {/* Shape Type Toggle */}
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">Shape Type:</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={shapeType === 'polygon' ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              handleClear();
              onShapeTypeChange('polygon');
            }}
            className="gap-2"
          >
            <Hexagon className="h-4 w-4" />
            Polygon
          </Button>
          <Button
            type="button"
            variant={shapeType === 'circle' ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              handleClear();
              onShapeTypeChange('circle');
            }}
            className="gap-2"
          >
            <Circle className="h-4 w-4" />
            Circle
          </Button>
        </div>
      </div>

      {/* Map Container */}
      <div
        ref={mapRef}
        style={{ height, width: '100%' }}
        className="rounded-lg border border-border overflow-hidden"
      />
      
      {/* Validation Warning */}
      {validationWarning && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm">{validationWarning}</span>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col gap-3 p-4 bg-muted/50 rounded-lg">
        {/* Status & Instructions */}
        <div className="text-sm text-muted-foreground">
          {shapeType === 'polygon' ? (
            isDrawing ? (
              points.length < 3 ? (
                <span className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-primary" />
                  Click on the map to add points ({points.length}/3 minimum required)
                </span>
              ) : (
                <span className="flex items-center gap-2 text-green-600">
                  <Check className="h-4 w-4" />
                  {points.length} points added - Click "Finish Drawing" to complete
                </span>
              )
            ) : (
              <span className="flex items-center gap-2 text-primary">
                <Check className="h-4 w-4" />
                Polygon set ({points.length} points) - Drag vertices to edit
              </span>
            )
          ) : (
            isDrawing ? (
              <span className="flex items-center gap-2">
                <Target className="h-4 w-4 text-primary" />
                Click on the map to place the circle center
              </span>
            ) : (
              <span className="flex items-center gap-2 text-primary">
                <Check className="h-4 w-4" />
                Circle placed - Drag to move, drag edges to resize
              </span>
            )
          )}
        </div>

        {/* Circle Radius Input */}
        {shapeType === 'circle' && circleCenter && (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Ruler className="h-4 w-4 text-muted-foreground" />
              <Label className="text-sm">Radius (meters):</Label>
              <Input
                type="number"
                value={circleRadius}
                onChange={(e) => {
                  const value = parseInt(e.target.value) || 100;
                  setCircleRadius(Math.max(50, Math.min(50000, value)));
                }}
                className="w-24 h-8"
                min={50}
                max={50000}
              />
            </div>
            <Badge variant="outline" className="gap-1">
              Area: {calculateCircleArea()}
            </Badge>
          </div>
        )}

        {/* Polygon Area Display */}
        {shapeType === 'polygon' && points.length >= 3 && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1">
              <Ruler className="h-3 w-3" />
              Area: {calculatePolygonArea()}
            </Badge>
            <Badge variant="outline">
              {points.length} vertices
            </Badge>
          </div>
        )}
        
        {/* Action Buttons */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            {shapeType === 'polygon' && isDrawing && (
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
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleClear}
              disabled={points.length === 0 && !circleCenter}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Clear
            </Button>
          </div>
          
          <div className="flex gap-2">
            {shapeType === 'polygon' && isDrawing && (
              <Button
                type="button"
                size="sm"
                onClick={handleFinishDrawing}
                disabled={points.length < 3}
                className="bg-primary hover:bg-primary/90"
              >
                <Check className="h-4 w-4 mr-1" />
                Finish Drawing
              </Button>
            )}
            {shapeType === 'polygon' && !isDrawing && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleStartRedraw}
              >
                Redraw Polygon
              </Button>
            )}
            {shapeType === 'circle' && !isDrawing && circleCenter && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setCircleCenter(null);
                  setIsDrawing(true);
                }}
              >
                Reposition Circle
              </Button>
            )}
          </div>
        </div>

        {/* Shape Status Indicator */}
        <div className="flex items-center justify-center gap-2 pt-2 border-t border-border/50">
          {hasValidShape ? (
            <Badge className="bg-green-500/10 text-green-600 border-green-500/30 gap-1">
              <Check className="h-3 w-3" />
              Ready to save
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1">
              <MapPin className="h-3 w-3" />
              {shapeType === 'polygon' ? 'Draw at least 3 points' : 'Click to place circle'}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}