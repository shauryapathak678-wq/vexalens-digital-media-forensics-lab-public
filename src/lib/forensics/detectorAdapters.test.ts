import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  ELAResidualAdapter,
  SpectralPRNUAdapter,
  FaceBoundarySeamAdapter,
  C2PAProvenanceAdapter,
  evaluateMultiModelConsensus,
  getDefaultDetectorAdapters,
} from './detectorAdapters';
import { NormalizedDetectorOutput } from '@/types/forensics';
import * as elaModule from './ela';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Multi-Model Detector Adapter Architecture (Module 4)', () => {
  it('instantiates all default registered forensic adapters with valid metadata', () => {
    const adapters = getDefaultDetectorAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(4);

    adapters.forEach((adapter) => {
      expect(adapter.id).toBeTruthy();
      expect(adapter.name).toBeTruthy();
      expect(adapter.version).toBeTruthy();
      expect(adapter.supportedMedia.length).toBeGreaterThan(0);
      expect(adapter.scoreSemantics).toBeTruthy();
      expect(adapter.limitations.length).toBeGreaterThan(0);
      expect(typeof adapter.isConfigured()).toBe('boolean');
    });
  });

  it('safely handles missing dataUrl without crashing', async () => {
    const spectralAdapter = new SpectralPRNUAdapter();
    const result = await spectralAdapter.analyze({
      mediaId: 'test_item',
      fileName: 'test.jpg',
      mediaType: 'image',
    });

    expect(result.status).toBe('failed');
    expect(result.verdict).toBe('unavailable');
    expect(result.errorMessage).toContain('Missing dataUrl');
  });

  it('exposes reliability-gated ELA hotspot coordinates for the localization overlay', async () => {
    class TestImage {
      onload: ((event: Event) => void) | null = null;

      set src(_value: string) {
        this.onload?.(new Event('load'));
      }
    }

    vi.stubGlobal('Image', TestImage);
    vi.spyOn(elaModule, 'performELA').mockResolvedValue({
      reliability: 'high',
      reliability_reasons: [],
      ela_verdict: 'possible_local_edit',
      hotspots: [{
        id: 'ela_hotspot_1',
        x: 20,
        y: 30,
        w: 40,
        h: 50,
        xPct: 20,
        yPct: 30,
        widthPct: 40,
        heightPct: 50,
        area_pct: 20,
        mean_z: 7.2,
        peak_z: 9.1,
        locationName: 'Central Region',
        description: 'Localized recompression residual.',
      }],
      exif_summary: { hasExif: false, isMessagingAppSuspect: false, format: 'JPEG' },
      ai_origin: { status: 'not_assessed', signals: [], details: 'Not assessed.' },
      dataUrl: 'data:image/png;base64,',
      width: 100,
      height: 100,
      plainEnglishExplanation: '',
      hindiExplanation: '',
      disclaimer: '',
    });

    const result = await new ELAResidualAdapter().analyze({
      mediaId: 'image-1',
      fileName: 'evidence.jpg',
      mediaType: 'image',
      dataUrl: 'data:image/jpeg;base64,',
    });

    expect(result.spatialAnalysis).toEqual({
      method: 'ela',
      reliability: 'high',
      verdict: 'possible_local_edit',
      reliabilityReasons: [],
      regions: [{
        id: 'ela_hotspot_1',
        xPct: 20,
        yPct: 30,
        widthPct: 40,
        heightPct: 50,
        label: 'Central Region',
        areaPct: 20,
        meanZ: 7.2,
        peakZ: 9.1,
        description: 'Localized recompression residual.',
      }],
    });
  });

  it('evaluates consensus without blindly averaging incompatible scores', () => {
    const mockOutputs: NormalizedDetectorOutput[] = [
      {
        adapterId: 'spectral-prnu-v2',
        adapterName: 'Spectral-PRNU',
        version: '2.4',
        status: 'completed',
        verdict: 'ai_generated',
        rawScore: 84.5,
        scoreSemantics: 'Checkerboard harmonic index 0-100',
        observations: ['Elevated grid harmonics'],
        alternativeExplanations: [],
        limitations: [],
        latencyMs: 120,
      },
      {
        adapterId: 'face-seam-v1',
        adapterName: 'Face Boundary Seam',
        version: '1.3',
        status: 'completed',
        verdict: 'authentic',
        rawScore: 12.0,
        scoreSemantics: 'Boundary seam gradient disparity 0-100%',
        observations: ['Continuous skin-tone gradients'],
        alternativeExplanations: [],
        limitations: [],
        latencyMs: 65,
      },
    ];

    const consensus = evaluateMultiModelConsensus('media_01', mockOutputs);

    expect(consensus.consensusState).toBe('divergence');
    expect(consensus.consensusExplanation).toContain('Divergence observed');
    expect(consensus.consensusExplanation).toContain('Models must not be averaged');
    expect(consensus.recommendedFurtherWork.length).toBeGreaterThan(0);
  });

  it('surfaces agreement when multiple independent models observe synthetic artifacts', () => {
    const mockOutputs: NormalizedDetectorOutput[] = [
      {
        adapterId: 'spectral-prnu-v2',
        adapterName: 'Spectral-PRNU',
        version: '2.4',
        status: 'completed',
        verdict: 'ai_generated',
        rawScore: 88.0,
        scoreSemantics: 'Checkerboard harmonic index',
        observations: ['Upsampling harmonics'],
        alternativeExplanations: [],
        limitations: [],
        latencyMs: 110,
      },
      {
        adapterId: 'c2pa-provenance-v1',
        adapterName: 'C2PA Provenance',
        version: '1.0',
        status: 'completed',
        verdict: 'ai_generated',
        scoreSemantics: 'Claim assertion',
        observations: ['Declared as trainedAlgorithmicMedia'],
        alternativeExplanations: [],
        limitations: [],
        latencyMs: 15,
      },
    ];

    const consensus = evaluateMultiModelConsensus('media_02', mockOutputs);

    expect(consensus.consensusState).toBe('agreement');
    expect(consensus.consensusExplanation).toContain('agree');
  });

  it('identifies insufficient detector output when fewer than 2 models complete successfully', () => {
    const singleOutput: NormalizedDetectorOutput[] = [
      {
        adapterId: 'spectral-prnu-v2',
        adapterName: 'Spectral-PRNU',
        version: '2.4',
        status: 'completed',
        verdict: 'authentic',
        scoreSemantics: 'Spectral score',
        observations: [],
        alternativeExplanations: [],
        limitations: [],
        latencyMs: 50,
      },
    ];

    const consensus = evaluateMultiModelConsensus('media_03', singleOutput);
    expect(consensus.consensusState).toBe('insufficient_detectors');
  });
});
