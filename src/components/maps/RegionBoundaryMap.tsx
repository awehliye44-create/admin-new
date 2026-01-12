import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Trash2, Undo, MapPin } from 'lucide-react';

interface LatLng {
  lat: number;
  lng: number;
}

interface RegionBoundaryMapProps {
  boundary: LatLng[] | null;
  onBoundaryChange: (boundary: LatLng[]) => void;
  isEditable?: boolean;
  height?: string;
}

declare global {
  interface Window {
    google: any;
    initRegionMap: () => void;
  }
}

export function RegionBoundaryMap({
  boundary,
  onBoundaryChange,
  isEditable = true,
  height = '400px',
}: RegionBoundaryMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const googleMapRef = useRef<any>(null);
  const polygonRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [points, setPoints] = useState<LatLng[]>(boundary || []);
  const [isDrawing, setIsDrawing] = useState(!boundary || boundary.length === 0);

  // Load Google Maps script
  useEffect(() => {
    if (window.google?.maps) {
      setIsMapLoaded(true);
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=AIzaSyCminSfJrGFp0mDvMI2hnk0xHVg_Du6Srg&libraries=drawing,geometry`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      setIsMapLoaded(true);
    };
    document.head.appendChild(script);

    return () => {
      // Cleanup if needed
    };
  }, []);

  // Initialize map
  useEffect(() => {
    if (!isMapLoaded || !mapRef.current) return;

    const defaultCenter = { lat: 52.0406, lng: -0.7594 }; // Milton Keynes as default
    const center = boundary && boundary.length > 0
      ? { lat: boundary[0].lat, lng: boundary[0].lng }
      : defaultCenter;

    googleMapRef.current = new window.google.maps.Map(mapRef.current, {
      center,
      zoom: 11,
      mapTypeId: 'roadmap',
      styles: [
        {
          featureType: 'poi',
          elementType: 'labels',
          stylers: [{ visibility: 'off' }],
        },
      ],
    });

    // Add click listener for drawing
    if (isEditable) {
      googleMapRef.current.addListener('click', (e: any) => {
        if (!isDrawing) return;
        const newPoint = { lat: e.latLng.lat(), lng: e.latLng.lng() };
        setPoints(prev => [...prev, newPoint]);
      });
    }

    // Draw existing boundary
    if (boundary && boundary.length > 0) {
      setPoints(boundary);
      setIsDrawing(false);
    }
  }, [isMapLoaded, isEditable]);

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
        strokeColor: '#3b82f6',
        strokeOpacity: 0.8,
        strokeWeight: 2,
        fillColor: '#3b82f6',
        fillOpacity: 0.2,
        editable: isEditable && !isDrawing,
        draggable: false,
        map: googleMapRef.current,
      });

      // Listen for polygon edits
      if (isEditable) {
        const path = polygonRef.current.getPath();
        window.google.maps.event.addListener(path, 'set_at', () => {
          const newPoints = getPolygonPoints();
          setPoints(newPoints);
          onBoundaryChange(newPoints);
        });
        window.google.maps.event.addListener(path, 'insert_at', () => {
          const newPoints = getPolygonPoints();
          setPoints(newPoints);
          onBoundaryChange(newPoints);
        });
      }

      // Notify parent
      onBoundaryChange(points);
    }

    // Add markers for points while drawing
    if (isDrawing && points.length > 0) {
      points.forEach((point, index) => {
        const marker = new window.google.maps.Marker({
          position: point,
          map: googleMapRef.current,
          label: {
            text: String(index + 1),
            color: 'white',
            fontSize: '12px',
          },
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            scale: 12,
            fillColor: '#3b82f6',
            fillOpacity: 1,
            strokeColor: '#1d4ed8',
            strokeWeight: 2,
          },
        });
        markersRef.current.push(marker);
      });
    }
  }, [points, isMapLoaded, isDrawing, isEditable]);

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
    if (points.length > 0) {
      setPoints(prev => prev.slice(0, -1));
    }
  };

  const handleClear = () => {
    setPoints([]);
    setIsDrawing(true);
    if (polygonRef.current) {
      polygonRef.current.setMap(null);
      polygonRef.current = null;
    }
    onBoundaryChange([]);
  };

  const handleFinishDrawing = () => {
    if (points.length >= 3) {
      setIsDrawing(false);
      onBoundaryChange(points);
    }
  };

  const handleEditMode = () => {
    setIsDrawing(true);
  };

  return (
    <div className="space-y-2">
      <div
        ref={mapRef}
        style={{ height, width: '100%' }}
        className="rounded-lg border border-border overflow-hidden"
      />
      
      {isEditable && (
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            {isDrawing ? (
              points.length < 3 ? (
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4" />
                  Click on the map to add points ({points.length}/3 minimum)
                </span>
              ) : (
                <span className="text-green-600">
                  ✓ {points.length} points added - Ready to finish
                </span>
              )
            ) : (
              <span className="text-blue-600">
                ✓ Boundary set ({points.length} points) - Drag vertices to edit
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
                  onClick={handleEditMode}
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
