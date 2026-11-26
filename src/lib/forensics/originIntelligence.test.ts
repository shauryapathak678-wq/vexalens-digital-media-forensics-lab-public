import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '@/types/forensics';
import {
  assessMetadataIntegrity,
  calculateDistanceKm,
  compareEvidenceOrigins,
  flattenMetadata,
  getEmbeddedLocation,
  getExifToolLocation,
  isAnalysisForEvidence,
  isOriginAnalysisTableMissing,
} from './originIntelligence';

function item(id: string, metadata: EvidenceItem['metadata'] = {}): EvidenceItem {
  return {
    id,
    investigationId: 'case-1',
    userId: 'user-1',
    fileName: `${id}.jpg`,
    fileSize: 100,
    mimeType: 'image/jpeg',
    mediaType: 'image',
    sha256Hash: 'a'.repeat(64),
    storageUrl: '',
    previewUrl: '',
    isOriginal: true,
    verified: false,
    metadata,
    createdAt: '2026-10-24T00:00:00.000Z',
  };
}

describe('origin intelligence', () => {
  it('accepts only valid embedded coordinates and calculates geographic distance', () => {
    const first = getEmbeddedLocation(item('one', { gps: { latitude: 0, longitude: 0 } }));
    expect(first?.source).toBe('embedded metadata');
    expect(getEmbeddedLocation(item('invalid', { gps: { latitude: 91, longitude: 0 } }))).toBeNull();
    expect(calculateDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(111.2, 0);
  });

  it('binds displayed analysis to both the selected evidence ID and its original hash', () => {
    const evidence = item('selected', {});
    const analysis = { evidenceId: 'selected', sha256: evidence.sha256Hash };
    expect(isAnalysisForEvidence(evidence, analysis)).toBe(true);
    expect(isAnalysisForEvidence(evidence, { ...analysis, evidenceId: 'another-file' })).toBe(false);
    expect(isAnalysisForEvidence(evidence, { ...analysis, sha256: 'b'.repeat(64) })).toBe(false);
    expect(isAnalysisForEvidence(evidence, null)).toBe(false);
  });

  it('recognizes a missing origin-analysis table so the view can show migration guidance', () => {
    expect(isOriginAnalysisTableMissing({
      code: 'PGRST205',
      message: "Could not find the table 'public.origin_landmark_analyses' in the schema cache",
    })).toBe(true);
    expect(isOriginAnalysisTableMissing({ code: '42501', message: 'permission denied' })).toBe(false);
  });

  it('extracts ExifTool GPS coordinates, reference directions, altitude, and accuracy without inventing absent values', () => {
    expect(getExifToolLocation({
      '[GPS]GPSLatitude': 33.8,
      '[GPS]GPSLatitudeRef': 'S',
      '[GPS]GPSLongitude': 151.2,
      '[GPS]GPSLongitudeRef': 'E',
      '[GPS]GPSAltitude': 12,
      '[GPS]GPSAltitudeRef': '1',
      '[GPS]GPSHPositioningError': 8.5,
    })).toMatchObject({
      latitude: -33.8,
      longitude: 151.2,
      altitude: -12,
      accuracyMeters: 8.5,
      source: 'ExifTool metadata',
    });
    expect(getExifToolLocation({ '[GPS]GPSLatitude': 33.8 })).toBeNull();
    expect(getExifToolLocation({
      '[GPS]GPSLatitude': 91,
      '[GPS]GPSLongitude': 0,
    })).toBeNull();
  });

  it('reports observed metadata matches and differences without inventing a common device', () => {
    const relations = compareEvidenceOrigins([
      item('one', { cameraMake: 'Canon', cameraModel: 'R5', gps: { latitude: 1, longitude: 2 } }),
      item('two', { cameraMake: 'Canon', cameraModel: 'R6', gps: { latitude: 1, longitude: 2 } }),
    ]);
    expect(relations).toHaveLength(1);
    expect(relations[0].matches).toEqual(['camera make', 'exact embedded GPS coordinates']);
    expect(relations[0].differences).toEqual(['camera model']);
  });

  it('does not treat absent metadata or editor tags as proof of tampering', () => {
    expect(assessMetadataIntegrity(item('empty')).status).toBe('insufficient_evidence');
    expect(
      assessMetadataIntegrity(
        item('edited', {
          software: 'Example Editor',
          verifiedEditingArtifacts: ['Editor recorded in metadata'],
        })
      ).status
    ).toBe('consistent_with_available_metadata');
  });

  it('handles evidence rows with null metadata without crashing origin analysis', () => {
    const missingMetadata = Object.assign(item('missing'), { metadata: null });
    expect(getEmbeddedLocation(missingMetadata)).toBeNull();
    expect(assessMetadataIntegrity(missingMetadata).status).toBe('insufficient_evidence');
    expect(compareEvidenceOrigins([missingMetadata, item('other')])).toEqual([]);
  });

  it('flattens grouped fields for searchable metadata presentation', () => {
    expect(flattenMetadata({
      gps: { latitude: 10, longitude: 20 },
      software: 'Camera App',
    })).toEqual([
      { group: 'gps', field: 'latitude', value: '10' },
      { group: 'gps', field: 'longitude', value: '20' },
      { group: 'Summary', field: 'software', value: 'Camera App' },
    ]);
  });

  it('withholds camera serial identifiers in the metadata explorer', () => {
    expect(flattenMetadata({
      rawExif: { exif: { BodySerialNumber: { description: 'private-serial' } } },
    })).toEqual([
      {
        group: 'exif (raw)',
        field: 'BodySerialNumber',
        value: 'Sensitive device identifier withheld',
      },
    ]);
  });
});
