import { useEffect, useRef, useState, type DragEvent } from 'react';
import exifr from 'exifr';
import L from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import { AlertCircle, Check, Copy, MapPin, RotateCcw, UploadCloud } from 'lucide-react';
import markerIconUrl from 'leaflet/dist/images/marker-icon.png';
import markerIconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png';
import 'leaflet/dist/leaflet.css';

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ACCEPTED_IMAGE_NAME = /\.(?:jpe?g|png|tiff?|heic)$/i;

const gpsMarkerIcon = L.icon({
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIconRetinaUrl,
  shadowUrl: markerShadowUrl,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

interface ParsedExif {
  latitude?: unknown;
  longitude?: unknown;
  GPSAltitude?: unknown;
  GPSAltitudeRef?: unknown;
  DateTimeOriginal?: unknown;
  Make?: unknown;
  Model?: unknown;
}

interface GpsResult {
  latitude: number;
  longitude: number;
  altitude?: number;
  dateTaken?: string;
  make?: string;
  model?: string;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function formatDateTaken(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toLocaleString();
  }
  return textValue(value);
}

function isBelowSeaLevel(value: unknown): boolean {
  return value === 1 ||
    value === '1' ||
    (typeof value === 'string' && value.toLowerCase().includes('below sea level'));
}

function extractResult(tags: ParsedExif | undefined): GpsResult | null {
  const latitude = finiteNumber(tags?.latitude);
  const longitude = finiteNumber(tags?.longitude);
  if (
    latitude === undefined ||
    longitude === undefined ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  const rawAltitude = finiteNumber(tags?.GPSAltitude);
  const altitude = rawAltitude === undefined
    ? undefined
    : isBelowSeaLevel(tags?.GPSAltitudeRef)
      ? -Math.abs(rawAltitude)
      : rawAltitude;
  const dateTaken = formatDateTaken(tags?.DateTimeOriginal);
  const make = textValue(tags?.Make);
  const model = textValue(tags?.Model);

  return {
    latitude,
    longitude,
    ...(altitude === undefined ? {} : { altitude }),
    ...(dateTaken ? { dateTaken } : {}),
    ...(make ? { make } : {}),
    ...(model ? { model } : {}),
  };
}

export function GpsImageTracker() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const parseRequestRef = useRef(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<GpsResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');

  useEffect(() => () => {
    parseRequestRef.current += 1;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const reset = () => {
    parseRequestRef.current += 1;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
    setSelectedFile(null);
    setPreviewUrl(null);
    setResult(null);
    setIsLoading(false);
    setIsDragging(false);
    setError('');
    setCopyMessage('');
  };

  const analyzeFile = async (file: File | undefined) => {
    if (!file) return;

    setError('');
    setCopyMessage('');
    setResult(null);
    if (!ACCEPTED_IMAGE_NAME.test(file.name)) {
      setSelectedFile(null);
      setPreviewUrl(null);
      setError('Choose a JPEG, PNG, TIFF, or HEIC image.');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setSelectedFile(null);
      setPreviewUrl(null);
      setError('This image is larger than the 20 MB limit.');
      return;
    }

    const requestId = ++parseRequestRef.current;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const nextPreviewUrl = URL.createObjectURL(file);
    previewUrlRef.current = nextPreviewUrl;
    setSelectedFile(file);
    setPreviewUrl(nextPreviewUrl);
    setIsLoading(true);

    try {
      const tags = await exifr.parse(file) as ParsedExif | undefined;
      if (requestId !== parseRequestRef.current) return;
      setResult(extractResult(tags));
    } catch (parseError) {
      if (requestId !== parseRequestRef.current) return;
      setError(
        parseError instanceof Error
          ? `Could not read image metadata: ${parseError.message}`
          : 'Could not read image metadata. Choose a valid image and try again.',
      );
    } finally {
      if (requestId === parseRequestRef.current) setIsLoading(false);
    }
  };

  const copyCoordinates = async () => {
    if (!result) return;
    const coordinates = `${result.latitude.toFixed(6)}, ${result.longitude.toFixed(6)}`;
    try {
      await navigator.clipboard.writeText(coordinates);
      setCopyMessage('Coordinates copied.');
    } catch {
      setCopyMessage('Clipboard access was denied. You can copy the coordinates shown above.');
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void analyzeFile(event.dataTransfer.files[0]);
  };

  const cardStyle = {
    background: 'var(--vl-surface)',
    border: '1px solid var(--vl-border)',
    boxShadow: 'var(--vl-card-shadow)',
  };
  const textStyle = { color: 'var(--vl-text-primary)' };
  const secondaryTextStyle = { color: 'var(--vl-text-secondary)' };

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 pb-16 sm:p-7" style={textStyle}>
      <header>
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: 'var(--vl-ice-cyan)' }}>
          <MapPin size={14} /> Local image metadata
        </div>
        <h1 className="text-2xl font-bold sm:text-3xl">GPS Image Tracker</h1>
        <p className="mt-1 text-sm" style={secondaryTextStyle}>
          Find where a photo was taken using its EXIF GPS data.
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border p-4 text-sm" role="alert" style={{ ...cardStyle, color: 'var(--vl-critical)' }}>
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!selectedFile ? (
        <section
          className="rounded-2xl border-2 border-dashed p-6 text-center transition-colors sm:p-10"
          style={{
            ...cardStyle,
            borderColor: isDragging ? 'var(--vl-ice-cyan)' : 'var(--vl-border)',
            background: isDragging ? 'var(--vl-accent-glow)' : 'var(--vl-surface)',
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setIsDragging(false);
            }
          }}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/tiff,image/heic,.jpg,.jpeg,.png,.tif,.tiff,.heic"
            className="sr-only"
            onChange={(event) => void analyzeFile(event.target.files?.[0])}
          />
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border" style={{ background: 'var(--vl-surface-elevated)', borderColor: 'var(--vl-border)' }}>
            <UploadCloud size={25} style={{ color: 'var(--vl-ice-cyan)' }} />
          </div>
          <h2 className="text-sm font-semibold">Drop an image here</h2>
          <p className="mt-1 text-xs" style={secondaryTextStyle}>
            JPEG, PNG, TIFF, or HEIC · Maximum 20 MB
          </p>
          <button
            type="button"
            className="mt-5 inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs font-semibold transition-colors"
            style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)', color: 'var(--vl-text-primary)' }}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadCloud size={15} /> Choose image
          </button>
        </section>
      ) : (
        <section className="space-y-5 rounded-2xl border p-4 sm:p-6" style={cardStyle} aria-busy={isLoading}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Selected image</h2>
              <p className="truncate text-xs" style={secondaryTextStyle}>{selectedFile.name}</p>
            </div>
            <button
              type="button"
              onClick={reset}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold"
              style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)', color: 'var(--vl-text-primary)' }}
            >
              <RotateCcw size={14} /> Try another photo
            </button>
          </div>

          {isLoading ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border" style={{ borderColor: 'var(--vl-border-subtle)', background: 'var(--vl-surface-elevated)' }} role="status" aria-live="polite">
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--vl-ice-cyan)', borderTopColor: 'transparent' }} />
              <p className="text-sm" style={secondaryTextStyle}>Reading EXIF GPS data on this device…</p>
            </div>
          ) : result ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-4">
                <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}>
                  {previewUrl && (
                    <img
                      src={previewUrl}
                      alt={`Preview of ${selectedFile.name}`}
                      className="max-h-[440px] min-h-48 w-full object-contain"
                      onError={() => setError('Your browser could not preview this image, but its EXIF data was read locally.')}
                    />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void copyCoordinates()}
                    className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold"
                    style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)', color: 'var(--vl-text-primary)' }}
                  >
                    {copyMessage === 'Coordinates copied.' ? <Check size={14} /> : <Copy size={14} />}
                    Copy coordinates
                  </button>
                  <a
                    href={`https://www.google.com/maps?q=${result.latitude.toFixed(6)},${result.longitude.toFixed(6)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-semibold"
                    style={{ color: 'var(--vl-ice-cyan)' }}
                  >
                    Open in Google Maps ↗
                  </a>
                </div>
                {copyMessage && <p className="text-xs" role="status" style={secondaryTextStyle}>{copyMessage}</p>}
              </div>

              <div className="space-y-4">
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border p-3" style={{ borderColor: 'var(--vl-border-subtle)', background: 'var(--vl-surface-elevated)' }}>
                    <dt className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--vl-text-dim)' }}>Latitude</dt>
                    <dd className="mt-1 break-all font-mono text-sm">{result.latitude.toFixed(6)}</dd>
                  </div>
                  <div className="rounded-xl border p-3" style={{ borderColor: 'var(--vl-border-subtle)', background: 'var(--vl-surface-elevated)' }}>
                    <dt className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--vl-text-dim)' }}>Longitude</dt>
                    <dd className="mt-1 break-all font-mono text-sm">{result.longitude.toFixed(6)}</dd>
                  </div>
                  {result.altitude !== undefined && (
                    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--vl-border-subtle)', background: 'var(--vl-surface-elevated)' }}>
                      <dt className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--vl-text-dim)' }}>Altitude</dt>
                      <dd className="mt-1 text-sm">{result.altitude} m</dd>
                    </div>
                  )}
                  <div className="rounded-xl border p-3" style={{ borderColor: 'var(--vl-border-subtle)', background: 'var(--vl-surface-elevated)' }}>
                    <dt className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--vl-text-dim)' }}>Date taken</dt>
                    <dd className="mt-1 break-words text-sm">{result.dateTaken || 'Not recorded'}</dd>
                  </div>
                  <div className="rounded-xl border p-3 sm:col-span-2" style={{ borderColor: 'var(--vl-border-subtle)', background: 'var(--vl-surface-elevated)' }}>
                    <dt className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--vl-text-dim)' }}>Camera model</dt>
                    <dd className="mt-1 break-words text-sm">
                      {[result.make, result.model].filter(Boolean).join(' ') || 'Not recorded'}
                    </dd>
                  </div>
                </dl>
                <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--vl-border)' }}>
                  <MapContainer
                    key={`${result.latitude},${result.longitude}`}
                    center={[result.latitude, result.longitude]}
                    zoom={15}
                    scrollWheelZoom={false}
                    style={{ height: 330, width: '100%' }}
                  >
                    <TileLayer
                      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                      maxZoom={19}
                    />
                    <Marker position={[result.latitude, result.longitude]} icon={gpsMarkerIcon}>
                      <Popup>Photo location</Popup>
                    </Marker>
                  </MapContainer>
                </div>
              </div>
            </div>
          ) : error ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="rounded-xl border p-4 text-sm" role="alert" style={{ borderColor: 'var(--vl-border-subtle)', background: 'var(--vl-surface-elevated)', color: 'var(--vl-text-secondary)' }}>
                {error}
              </div>
              {previewUrl && (
                <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}>
                  <img
                    src={previewUrl}
                    alt={`Preview of ${selectedFile.name}`}
                    className="max-h-[440px] min-h-48 w-full object-contain"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="rounded-xl border p-4 text-sm leading-6" role="status" style={{ borderColor: 'var(--vl-border-subtle)', background: 'var(--vl-surface-elevated)', color: 'var(--vl-text-secondary)' }}>
                This photo has no location tag. WhatsApp, Instagram and screenshots remove location data, and the camera&apos;s location setting must be on when the photo is taken.
              </div>
              {previewUrl && (
                <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}>
                  <img
                    src={previewUrl}
                    alt={`Preview of ${selectedFile.name}`}
                    className="max-h-[440px] min-h-48 w-full object-contain"
                  />
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <p className="text-[11px] leading-5" style={{ color: 'var(--vl-text-dim)' }}>
        GPS is read from the selected file on this device. OpenStreetMap tiles and Google Maps are used only to display or open coordinates; neither is used to detect the location.
      </p>
    </main>
  );
}
