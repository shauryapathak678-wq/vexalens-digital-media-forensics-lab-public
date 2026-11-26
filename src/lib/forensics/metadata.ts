import ExifReader from 'exifreader';
import { EvidenceMetadata } from '@/types/forensics';

function tagText(tag: unknown): string | undefined {
  if (!tag || typeof tag !== 'object') return undefined;
  const entry = tag as { description?: unknown; value?: unknown };
  const value = entry.description ?? entry.value;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return undefined;
}

function rationalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length === 2) {
    const numerator = Number(value[0]);
    const denominator = Number(value[1]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return numerator / denominator;
    }
  }
  return undefined;
}

function coordinateFromExifTag(tag: unknown, reference: string | undefined): number | undefined {
  if (!tag || typeof tag !== 'object') return undefined;
  const value = (tag as { value?: unknown }).value;
  if (!Array.isArray(value) || value.length < 3 || !reference) return undefined;
  const degrees = rationalNumber(value[0]);
  const minutes = rationalNumber(value[1]);
  const seconds = rationalNumber(value[2]);
  if (degrees === undefined || minutes === undefined || seconds === undefined) return undefined;
  const magnitude = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  const normalizedReference = reference.toUpperCase();
  if (!/^(N|NORTH|S|SOUTH|E|EAST|W|WEST)$/.test(normalizedReference)) return undefined;
  return normalizedReference.startsWith('S') || normalizedReference.startsWith('W')
    ? -magnitude
    : magnitude;
}

export function extractGpsMetadata(tags: unknown): EvidenceMetadata['gps'] | undefined {
  if (!tags || typeof tags !== 'object') return undefined;
  const expanded = tags as {
    gps?: Record<string, unknown>;
    exif?: Record<string, unknown>;
  };
  const gps = expanded.gps;
  const exif = expanded.exif || {};
  const latitudeRef = tagText(exif.GPSLatitudeRef)?.trim().toUpperCase();
  const longitudeRef = tagText(exif.GPSLongitudeRef)?.trim().toUpperCase();
  const latitude = typeof gps?.Latitude === 'number' && Number.isFinite(gps.Latitude)
    ? gps.Latitude
    : coordinateFromExifTag(exif.GPSLatitude, latitudeRef);
  const longitude = typeof gps?.Longitude === 'number' && Number.isFinite(gps.Longitude)
    ? gps.Longitude
    : coordinateFromExifTag(exif.GPSLongitude, longitudeRef);
  if (
    latitude === undefined ||
    longitude === undefined ||
    latitude < -90 || latitude > 90 ||
    longitude < -180 || longitude > 180
  ) return undefined;

  const altitudeTag = exif.GPSAltitude as { value?: unknown } | undefined;
  const altitudeValue = altitudeTag?.value;
  const altitude = typeof gps?.Altitude === 'number' && Number.isFinite(gps.Altitude)
    ? gps.Altitude
    : rationalNumber(altitudeValue);
  const altitudeRefTag = exif.GPSAltitudeRef as { value?: unknown } | undefined;
  const altitudeRef = Number(altitudeRefTag?.value) === 1 ||
    tagText(altitudeRefTag)?.toLowerCase().includes('below sea level');
  const date = tagText(exif.GPSDateStamp);
  const time = tagText(exif.GPSTimeStamp);
  const speed = tagText(exif.GPSSpeed);
  const track = tagText(exif.GPSTrack);
  const direction = tagText(exif.GPSImgDirection);

  return {
    latitude,
    longitude,
    ...(altitude === undefined ? {} : {
      altitude: altitudeRef ? -Math.abs(altitude) : altitude,
    }),
    ...(date || time ? { timestamp: `${date || ''} ${time || ''} UTC`.trim() } : {}),
    ...(speed && Number.isFinite(Number(speed)) ? { speed: Number(speed) } : {}),
    ...(tagText(exif.GPSSpeedRef) ? { speedUnit: tagText(exif.GPSSpeedRef) } : {}),
    ...(track && Number.isFinite(Number(track)) ? { track: Number(track) } : {}),
    ...(direction && Number.isFinite(Number(direction)) ? { direction: Number(direction) } : {}),
    ...(tagText(exif.GPSImgDirectionRef) ? { directionReference: tagText(exif.GPSImgDirectionRef) } : {}),
    source: 'EXIF GPS',
    locationName: `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`,
  };
}

/**
 * Extracts and audits metadata from media files.
 * Performs deep inspection for EXIF, IPTC, XMP, GPS, and detects editor/AI generator signatures.
 */
export async function extractMediaMetadata(file: File | Blob): Promise<EvidenceMetadata> {
  const extractionLimitations: string[] = [];
  const metadata: EvidenceMetadata = {
    fileSizeBytes: file.size,
    fileFormat: file.type || 'application/octet-stream',
    inconsistenciesDetected: [],
  };

  const supportsImageMetadata =
    file.type.startsWith('image/') ||
    file.type.includes('jpeg') ||
    file.type.includes('png') ||
    file.type.includes('tiff') ||
    file.type.includes('webp');

  if (supportsImageMetadata) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const tags = ExifReader.load(arrayBuffer, { expanded: true });
      metadata.rawExif = tags as Record<string, any>;

      // Extract basic EXIF fields
      const exif = tags.exif;
      const fileTags = tags.file;
      const imageTags = (tags as any).image;
      const xmpTags = tags.xmp;

      // Extract Camera Make/Model (usually in 'image' group/IFD0)
      if (imageTags?.Make) metadata.cameraMake = tagText(imageTags.Make);
      else if (exif?.Make) metadata.cameraMake = tagText(exif.Make);

      if (imageTags?.Model) metadata.cameraModel = tagText(imageTags.Model);
      else if (exif?.Model) metadata.cameraModel = tagText(exif.Model);

      if (imageTags?.LensModel) metadata.lensModel = tagText(imageTags.LensModel);
      else if (exif?.LensModel) metadata.lensModel = tagText(exif.LensModel);

      // Capture settings (usually in 'exif' group/SubIFD)
      if (exif) {
        if (exif.ISOSpeedRatings) metadata.iso = tagText(exif.ISOSpeedRatings);
        if (exif.FocalLength) metadata.focalLength = tagText(exif.FocalLength);
        if (exif.FNumber) metadata.aperture = `f/${tagText(exif.FNumber)}`;
        if (exif.ExposureTime) metadata.exposureTime = tagText(exif.ExposureTime);
        if (exif.DateTimeOriginal) metadata.dateTimeOriginal = tagText(exif.DateTimeOriginal);
        if (exif.DateTimeDigitized) metadata.dateTimeDigitized = tagText(exif.DateTimeDigitized);
        if (exif.ColorSpace) metadata.colorSpace = tagText(exif.ColorSpace);
      }

      // If capture dates missing in 'exif', check 'image'
      if (!metadata.dateTimeOriginal && imageTags?.DateTime) {
        metadata.dateTimeOriginal = tagText(imageTags.DateTime);
      }

      // Check software in multiple groups
      if (imageTags?.Software) metadata.software = tagText(imageTags.Software);
      else if (exif?.Software) metadata.software = tagText(exif.Software);
      else if (xmpTags?.CreatorTool) metadata.software = tagText(xmpTags.CreatorTool);

      metadata.gps = extractGpsMetadata(tags);

      // Dimensions
      let width = 0;
      let height = 0;
      if (fileTags?.['Image Width']) width = parseInt(tagText(fileTags['Image Width']) || '', 10);
      else if (imageTags?.ImageWidth) width = parseInt(tagText(imageTags.ImageWidth) || '', 10);

      if (fileTags?.['Image Height']) height = parseInt(tagText(fileTags['Image Height']) || '', 10);
      else if (imageTags?.ImageLength) height = parseInt(tagText(imageTags.ImageLength) || '', 10);

      if (width && height) {
        metadata.dimensions = { width, height };
        metadata.aspectRatio = calculateAspectRatio(width, height);
      }
    } catch (err) {
      console.warn('Metadata extraction non-fatal notice:', err);
      extractionLimitations.push(
        `Image metadata extraction was unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (file.type.startsWith('video/')) {
    try {
      metadata.videoSpecs = await extractBrowserVideoMetadata(file);
      metadata.unverifiableFields = [
        'Browser media APIs expose duration and dimensions only; codec, frame rate, GPS tracks, and stream/container timestamps require FFprobe.',
      ];
    } catch (err) {
      extractionLimitations.push(
        `Browser video metadata extraction was unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Audit for inconsistencies, missing information, and editor/generator fingerprints
  const audit = auditMetadataCategories(metadata);
  metadata.missingMetadataNotices = audit.missingInformation;
  metadata.inconsistenciesDetected = audit.inconsistencies;
  metadata.verifiedEditingArtifacts = audit.observedEditing;
  metadata.unverifiableFields = [...extractionLimitations, ...(metadata.unverifiableFields || []), ...audit.unverifiable];

  return metadata;
}

function extractBrowserVideoMetadata(file: Blob): Promise<NonNullable<EvidenceMetadata['videoSpecs']>> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return Promise.reject(new Error('Browser media metadata APIs are not available.'));
  }

  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);
    const timeout = window.setTimeout(() => finish(new Error('Timed out while reading video metadata.')), 15000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };
    const finish = (error?: Error) => {
      const durationSec = Number.isFinite(video.duration) ? video.duration : undefined;
      const resolution = video.videoWidth && video.videoHeight
        ? `${video.videoWidth} × ${video.videoHeight}`
        : undefined;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      if (durationSec === undefined && !resolution) {
        reject(new Error('The browser did not expose duration or dimensions for this video.'));
        return;
      }
      resolve({
        ...(durationSec === undefined ? {} : { durationSec }),
        ...(resolution ? { resolution } : {}),
      });
    };
    const onLoaded = () => finish();
    const onError = () => finish(new Error('The browser could not parse metadata for this video format or codec.'));

    video.preload = 'metadata';
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.src = objectUrl;
  });
}

function calculateAspectRatio(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(w, h);
  const ratioW = w / divisor;
  const ratioH = h / divisor;
  if (ratioW > 30 || ratioH > 30) {
    return `${(w / h).toFixed(2)}:1`;
  }
  return `${ratioW}:${ratioH}`;
}

export interface MetadataAuditSummary {
  missingInformation: string[];
  inconsistencies: string[];
  observedEditing: string[];
  unverifiable: string[];
}

export function auditMetadataCategories(meta: EvidenceMetadata): MetadataAuditSummary {
  const missingInformation: string[] = [];
  const inconsistencies: string[] = [];
  const observedEditing: string[] = [];
  const unverifiable: string[] = [];

  const software = (meta.software || '').toLowerCase();
  const make = (meta.cameraMake || '').toLowerCase();
  const model = (meta.cameraModel || '').toLowerCase();

  // 1. Synthetic generative tool signatures
  const aiKeywords = [
    'midjourney',
    'stable diffusion',
    'stablediffusion',
    'dall-e',
    'dalle',
    'comfyui',
    'invokeai',
    'novelai',
    'automatic1111',
    'firefly',
  ];
  for (const kw of aiKeywords) {
    if (software.includes(kw) || model.includes(kw) || make.includes(kw)) {
      observedEditing.push(`Generative synthesis software footprint identified: "${kw.toUpperCase()}"`);
    }
  }

  // 2. Photo manipulation software signatures
  const editorKeywords = ['photoshop', 'gimp', 'affinity', 'pixelmator', 'lightroom', 'canva', 'picsart'];
  for (const ed of editorKeywords) {
    if (software.includes(ed)) {
      observedEditing.push(`Image editor recorded in metadata CreatorTool: "${meta.software}"`);
      break;
    }
  }

  // 3. Chronological discrepancies
  if (meta.dateTimeOriginal && meta.dateTimeDigitized) {
    const parseExifTimestamp = (value: string) =>
      new Date(value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T')).getTime();
    const orig = parseExifTimestamp(meta.dateTimeOriginal);
    const digi = parseExifTimestamp(meta.dateTimeDigitized);
    if (!isNaN(orig) && !isNaN(digi) && digi < orig) {
      inconsistencies.push('Chronological discrepancy: DateTimeDigitized precedes DateTimeOriginal timestamp.');
    }
  }

  // 4. Missing metadata (explicitly noting that missing metadata does NOT prove manipulation)
  if (meta.fileFormat?.startsWith('image/') && !meta.cameraMake && !meta.cameraModel && !meta.software) {
    missingInformation.push(
      'Missing hardware tags: No camera make, model, or capture timestamps are present in EXIF tags. ' +
      'Messaging apps (WhatsApp, Telegram, Signal) and social media platforms (X, Instagram, Facebook) routinely strip EXIF for privacy. ' +
      'Missing metadata alone is NOT evidence of manipulation.'
    );
  }

  if (meta.fileFormat?.startsWith('image/') && !meta.gps) {
    missingInformation.push('No GPS geolocation coordinates embedded. Many mobile devices disable location tagging by default.');
  }

  if (meta.colorSpace && !meta.colorProfile) {
    unverifiable.push(`Color space is declared as "${meta.colorSpace}", but no embedded ICC color profile is attached for hardware gamut calibration.`);
  }

  return {
    missingInformation,
    inconsistencies,
    observedEditing,
    unverifiable,
  };
}

export function detectMetadataInconsistencies(meta: EvidenceMetadata): string[] {
  const audit = auditMetadataCategories(meta);
  // Return genuine anomalies (excluding normal missing metadata)
  return [...audit.inconsistencies, ...audit.observedEditing];
}
