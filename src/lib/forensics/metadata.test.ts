import { describe, expect, it } from 'vitest';
import { extractGpsMetadata } from './metadata';

describe('image GPS metadata extraction', () => {
  it('uses ExifReader-calculated signed coordinates and available GPS fields', () => {
    expect(extractGpsMetadata({
      gps: { Latitude: -33.86, Longitude: 151.2, Altitude: -4 },
      exif: {
        GPSDateStamp: { description: '2026:10:26' },
        GPSTimeStamp: { description: '10:20:30' },
        GPSSpeed: { description: '2.5' },
        GPSSpeedRef: { description: 'K' },
      },
    })).toMatchObject({
      latitude: -33.86,
      longitude: 151.2,
      altitude: -4,
      timestamp: '2026:10:26 10:20:30 UTC',
      speed: 2.5,
      speedUnit: 'K',
    });
  });

  it('calculates coordinates from EXIF rational degrees and direction references', () => {
    expect(extractGpsMetadata({
      exif: {
        GPSLatitude: { value: [[33, 1], [51, 1], [36, 1]] },
        GPSLatitudeRef: { value: ['S'], description: 'South' },
        GPSLongitude: { value: [[151, 1], [12, 1], [0, 1]] },
        GPSLongitudeRef: { value: ['E'], description: 'E' },
      },
    })).toMatchObject({
      latitude: -33.86,
      longitude: 151.2,
      source: 'EXIF GPS',
    });
  });

  it('does not report coordinates without a complete GPS pair', () => {
    expect(extractGpsMetadata({ gps: { Latitude: 10 } })).toBeUndefined();
    expect(extractGpsMetadata({
      gps: { Latitude: 91, Longitude: 10 },
    })).toBeUndefined();
  });
});
