import type { EvidenceItem } from '@/types/forensics';

export interface OriginLocation {
  evidenceId: string;
  fileName: string;
  latitude: number;
  longitude: number;
  altitude?: number;
  timestamp?: string;
  speed?: number;
  speedUnit?: string;
  track?: number;
  direction?: number;
  directionReference?: string;
  accuracyMeters?: number;
  source: 'embedded metadata' | 'ExifTool metadata' | 'ExifReader fallback metadata';
}

export interface OriginRelation {
  firstId: string;
  secondId: string;
  matches: string[];
  differences: string[];
}

export type MetadataIntegrityStatus =
  | 'consistent_with_available_metadata'
  | 'inconsistencies_detected'
  | 'possible_metadata_modification'
  | 'insufficient_evidence';

export interface MetadataIntegrityAssessment {
  status: MetadataIntegrityStatus;
  warnings: string[];
  limitations: string[];
}

export function isOriginAnalysisTableMissing(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST205' ||
    /could not find the table ['"]?public\.origin_landmark_analyses['"]? in the schema cache|relation ['"]?public\.origin_landmark_analyses['"]? does not exist/i.test(
      error.message || ''
    );
}

export function isAnalysisForEvidence(
  evidence: Pick<EvidenceItem, 'id' | 'sha256Hash'>,
  analysis: { evidenceId?: string; sha256?: string } | null | undefined
): boolean {
  return Boolean(
    analysis &&
    analysis.evidenceId === evidence.id &&
    typeof analysis.sha256 === 'string' &&
    analysis.sha256.toLowerCase() === evidence.sha256Hash.toLowerCase()
  );
}

export function getEmbeddedLocation(item: EvidenceItem): OriginLocation | null {
  const gps = item.metadata?.gps;
  const latitude = gps?.latitude;
  const longitude = gps?.longitude;
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) return null;

  return {
    evidenceId: item.id,
    fileName: item.fileName,
    latitude,
    longitude,
    altitude: typeof gps?.altitude === 'number' && Number.isFinite(gps.altitude) ? gps.altitude : undefined,
    timestamp: gps?.timestamp,
    speed: gps?.speed,
    speedUnit: gps?.speedUnit,
    track: gps?.track,
    direction: gps?.direction,
    directionReference: gps?.directionReference,
    source: 'embedded metadata',
  };
}

export function getExifToolLocation(metadata: Record<string, unknown> | null | undefined): Omit<OriginLocation, 'evidenceId' | 'fileName'> | null {
  if (!metadata) return null;
  const findTag = (suffix: string): unknown =>
    Object.entries(metadata).find(([key]) =>
      key.toLowerCase().replace(/[^a-z]/g, '').endsWith(suffix.toLowerCase())
    )?.[1];
  const numberTag = (suffix: string): number | undefined => {
    const value = findTag(suffix);
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
    return Number.isFinite(number) ? number : undefined;
  };
  let latitude = numberTag('GPSLatitude');
  let longitude = numberTag('GPSLongitude');
  if (latitude === undefined || longitude === undefined) return null;
  const latitudeRef = String(findTag('GPSLatitudeRef') || '').toUpperCase();
  const longitudeRef = String(findTag('GPSLongitudeRef') || '').toUpperCase();
  if (latitudeRef === 'S') latitude = -Math.abs(latitude);
  if (latitudeRef === 'N') latitude = Math.abs(latitude);
  if (longitudeRef === 'W') longitude = -Math.abs(longitude);
  if (longitudeRef === 'E') longitude = Math.abs(longitude);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  const altitude = numberTag('GPSAltitude');
  const altitudeRef = String(findTag('GPSAltitudeRef') || '');
  const speed = numberTag('GPSSpeed');
  const track = numberTag('GPSTrack');
  const direction = numberTag('GPSImgDirection');
  const gpsDate = findTag('GPSDateStamp');
  const gpsTime = findTag('GPSTimeStamp');
  const speedUnit = findTag('GPSSpeedRef');
  const directionReference = findTag('GPSImgDirectionRef');
  const accuracyMeters = numberTag('GPSHPositioningError');
  const extractionSource = Object.keys(metadata).some((key) => key.startsWith('[ExifReader]'))
    ? 'ExifReader fallback metadata'
    : 'ExifTool metadata';
  return {
    latitude,
    longitude,
    ...(altitude === undefined ? {} : { altitude: altitudeRef === '1' ? -altitude : altitude }),
    ...(accuracyMeters === undefined ? {} : { accuracyMeters }),
    ...(gpsDate || gpsTime ? { timestamp: `${String(gpsDate || '')} ${String(gpsTime || '')} UTC`.trim() } : {}),
    ...(speed === undefined ? {} : { speed }),
    ...(speedUnit === undefined ? {} : { speedUnit: String(speedUnit) }),
    ...(track === undefined ? {} : { track }),
    ...(direction === undefined ? {} : { direction }),
    ...(directionReference === undefined ? {} : { directionReference: String(directionReference) }),
    source: extractionSource,
  };
}

export function calculateDistanceKm(
  first: Pick<OriginLocation, 'latitude' | 'longitude'>,
  second: Pick<OriginLocation, 'latitude' | 'longitude'>
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(first.latitude)) *
      Math.cos(radians(second.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function normalized(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().toLowerCase()
    : '';
}

export function compareEvidenceOrigins(items: EvidenceItem[]): OriginRelation[] {
  const relations: OriginRelation[] = [];
  const fields: Array<[string, (item: EvidenceItem) => unknown]> = [
    ['camera make', (item) => item.metadata?.cameraMake],
    ['camera model', (item) => item.metadata?.cameraModel],
    ['lens model', (item) => item.metadata?.lensModel],
    ['software identifier', (item) => item.metadata?.software],
    ['capture timestamp', (item) => item.metadata?.dateTimeOriginal],
  ];

  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const matches: string[] = [];
      const differences: string[] = [];
      for (const [label, getValue] of fields) {
        const firstValue = normalized(getValue(items[left]));
        const secondValue = normalized(getValue(items[right]));
        if (firstValue && secondValue) {
          if (firstValue === secondValue) matches.push(label);
          else differences.push(label);
        }
      }

      const firstLocation = getEmbeddedLocation(items[left]);
      const secondLocation = getEmbeddedLocation(items[right]);
      if (firstLocation && secondLocation) {
        if (
          firstLocation.latitude === secondLocation.latitude &&
          firstLocation.longitude === secondLocation.longitude
        ) {
          matches.push('exact embedded GPS coordinates');
        } else {
          differences.push('embedded GPS coordinates');
        }
      }

      if (matches.length || differences.length) {
        relations.push({
          firstId: items[left].id,
          secondId: items[right].id,
          matches,
          differences,
        });
      }
    }
  }
  return relations;
}

export function assessMetadataIntegrity(item: EvidenceItem): MetadataIntegrityAssessment {
  const metadata = item.metadata;
  const warnings = [...(metadata?.inconsistenciesDetected || [])];
  const limitations = [...(metadata?.missingMetadataNotices || [])];
  if (metadata?.verifiedEditingArtifacts?.length) {
    limitations.push(
      `Editing software is recorded in metadata: ${metadata.verifiedEditingArtifacts.join('; ')}. This alone does not establish when, why, or whether the media was materially altered.`
    );
  }

  if (warnings.length) {
    return { status: 'inconsistencies_detected', warnings, limitations };
  }
  if (
    metadata?.cameraMake ||
    metadata?.cameraModel ||
    metadata?.dateTimeOriginal ||
    metadata?.software ||
    metadata?.gps
  ) {
    return {
      status: 'consistent_with_available_metadata',
      warnings,
      limitations,
    };
  }
  return {
    status: 'insufficient_evidence',
    warnings,
    limitations: limitations.length
      ? limitations
      : ['No interpretable origin metadata is available for comparison. Missing metadata is not proof of modification.'],
  };
}

export function flattenMetadata(metadata: Record<string, unknown>): Array<{
  group: string;
  field: string;
  value: string;
}> {
  const rows: Array<{ group: string; field: string; value: string }> = [];
  const visit = (group: string, field: string, value: unknown, depth: number) => {
    if (value === null || value === undefined || value === '') return;
    if (/serial(?:number)?/i.test(field)) {
      rows.push({ group, field, value: 'Sensitive device identifier withheld' });
      return;
    }
    if (typeof value === 'object' && !Array.isArray(value) && depth < 5) {
      const objectValue = value as Record<string, unknown>;
      if ('description' in objectValue || 'value' in objectValue) {
        const displayValue = objectValue.description ?? objectValue.value;
        if (displayValue !== null && displayValue !== undefined && displayValue !== '') {
          rows.push({
            group,
            field,
            value: typeof displayValue === 'object' ? JSON.stringify(displayValue) : String(displayValue),
          });
        }
        return;
      }
      for (const [key, nestedValue] of Object.entries(objectValue)) {
        visit(group, field ? `${field}.${key}` : key, nestedValue, depth + 1);
      }
      return;
    }
    const displayValue = Array.isArray(value) ? value.join(', ') : String(value);
    rows.push({ group, field, value: displayValue });
  };

  for (const [group, value] of Object.entries(metadata)) {
    if (group === 'rawExif') {
      if (value && typeof value === 'object') {
        for (const [exifGroup, groupValue] of Object.entries(value as Record<string, unknown>)) {
          visit(`${exifGroup} (raw)`, '', groupValue, 0);
        }
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      visit(group, '', value, 0);
    } else {
      visit('Summary', group, value, 0);
    }
  }
  return rows;
}
