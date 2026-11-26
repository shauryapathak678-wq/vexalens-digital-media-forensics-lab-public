import { useEffect, useRef } from 'react';
import L from 'leaflet';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import 'leaflet/dist/leaflet.css';

const evidenceMarkerIcon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

interface EvidenceGpsMapProps {
  latitude: number;
  longitude: number;
}

export function EvidenceGpsMap({ latitude, longitude }: EvidenceGpsMapProps) {
  const mapElement = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mapElement.current) return;

    const map = L.map(mapElement.current, { scrollWheelZoom: false })
      .setView([latitude, longitude], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    L.marker([latitude, longitude], { icon: evidenceMarkerIcon }).addTo(map);

    return () => {
      map.remove();
    };
  }, [latitude, longitude]);

  return (
    <div
      ref={mapElement}
      role="img"
      aria-label={`OpenStreetMap showing photo coordinates ${latitude}, ${longitude}`}
      style={{
        height: 230,
        width: '100%',
        border: '1px solid var(--vl-border)',
        borderRadius: 9,
        overflow: 'hidden',
      }}
    />
  );
}
