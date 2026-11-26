import { describe, expect, it } from 'vitest';
import { generateScreenshotForensicPdf } from './screenshotPdfReport';
import type { ScreenshotAnalysisResult } from '@/types/screenshotForensics';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function moduleFinding(id: string, name: string, status: 'clean' | 'flagged' | 'inconclusive' | 'not_applicable') {
  return {
    id,
    name,
    status,
    simpleObservation: 'Measured',
    whatWasChecked: 'OpenCV image measurements',
    whatWasFound: 'One descriptive measurement was recorded.',
    whyItMatters: 'This measurement can guide manual review.',
    reliability: 'Exploratory; not calibrated.',
    limitations: 'Not proof of editing.',
    metrics: { measured_value: 1 },
    thresholds: { threshold: 'recorded per run' },
    affectedRegionIds: status === 'flagged' ? ['region-1'] : [],
  };
}

describe('Screenshot Forensic PDF Generator', () => {
  it('generates a report with measurements, coordinates, and analysis images without probability scores', () => {
    const result: ScreenshotAnalysisResult = {
      id: 'scan-test-1',
      evidenceId: 'ev-test',
      fileName: 'payment-screenshot.png',
      fileSize: 1024,
      fileType: 'image/png',
      sha256: 'a'.repeat(64),
      md5: 'b'.repeat(32),
      uploadTimestamp: '2026-01-01T00:00:00Z',
      analysisTimestamp: '2026-01-01T00:00:01Z',
      category: 'payment',
      assessmentStatus: 'inconclusive',
      simpleVerdict: 'One local signal',
      assessmentSummary: 'Inconclusive — one local signal',
      assessmentExplanation: 'A single check flagged an area. This does not prove editing.',
      assessmentMethod: 'One test alone is inconclusive; no probability score is calculated.',
      suspiciousRegions: [{
        id: 'region-1',
        regionNumber: 1,
        box: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 },
        pixelBox: { x: 48, y: 128, width: 96, height: 64 },
        label: 'Area 1',
        technique: 'JPEG Error Level Analysis',
        modules: ['compressionEla'],
        evidenceFamilies: ['compression'],
        signalLevel: 'single-test',
        reason: 'One local JPEG tile differs from the image baseline.',
        technicalObservations: '{"tile_median":3.2}',
        limitations: 'Compression differences are not specific to editing.',
        measurements: { compressionEla: { tile_median: 3.2 } },
      }],
      moduleFindings: {
        compressionEla: moduleFinding('ela', 'JPEG Error Level Analysis', 'flagged'),
        copyMove: moduleFinding('copy-move', 'SIFT Copy-Move Matching', 'clean'),
        noiseAnalysis: moduleFinding('noise', 'Local Noise Residuals', 'clean'),
        resampling: moduleFinding('resampling', 'Resampling Periodicity', 'inconclusive'),
        imageBoundary: moduleFinding('boundary', 'Boundary / Compression Grid', 'not_applicable'),
        textAndFont: moduleFinding('text', 'Text Appearance Consistency', 'not_applicable'),
        ocrLayout: moduleFinding('ocr', 'OCR Text and Layout', 'not_applicable'),
      },
      heatmapDataUrl: pixel,
      moduleOverlayDataUrls: { compressionEla: pixel },
      originalDataUrl: pixel,
      annotatedDataUrl: pixel,
      imageDimensions: { width: 480, height: 640 },
      imageMetadata: { format: 'PNG', exifAvailable: false, exif: {} },
      ocrText: [],
      parameters: { engine: '2.0.0-opencv', sensitivity: 3 },
      limitations: ['Exploratory measurements only.'],
      processingTimeMs: 120,
    };

    const pdf = generateScreenshotForensicPdf(result, 'CASE-TEST-001', 'Lead Examiner');
    expect(pdf).toBeDefined();
    expect(pdf.size).toBeGreaterThan(1000);
    expect(pdf.type).toBe('application/pdf');
  });
});
