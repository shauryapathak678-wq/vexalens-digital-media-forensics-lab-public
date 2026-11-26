import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EvidenceItem, EvidenceMetadata } from '@/types/forensics';
import { calculateEvidenceHashes, formatShortHash, verifyHashesMatch } from '@/lib/forensics/crypto';
import { extractMediaMetadata } from '@/lib/forensics/metadata';
import {
  analyzeImageCanvases,
  createHeatmapDataUrl,
  detectDifferenceRegions,
  type CopyMoveCandidate,
  type DifferenceRegion,
  type LocalImageComparison,
  type RasterMetrics,
} from '@/lib/forensics/mediaComparison';
import {
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  Download,
  Eye,
  FileJson,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  ScanSearch,
  ShieldAlert,
  Sliders,
  UploadCloud,
  X,
} from 'lucide-react';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ANALYSIS_EDGE = 1600;

interface LocalEvidenceSource {
  file: File;
  url: string;
  metadata: EvidenceMetadata;
  sha256: string;
}

interface ComparisonSource {
  name: string;
  url: string;
  mimeType: string;
  size: number;
  sha256: string;
  metadata: EvidenceMetadata;
  evidenceId?: string;
  file?: File;
}

interface MediaComparisonViewProps {
  evidenceList: EvidenceItem[];
  caseId?: string;
  investigationId?: string;
}

type ViewerMode = 'split' | 'side-by-side' | 'overlay' | 'heatmap' | 'edges';

interface ComparisonReport {
  version: 1;
  generatedAt: string;
  caseId: string;
  investigationId: string;
  baseline: Record<string, unknown>;
  suspect: Record<string, unknown>;
  analysis: Record<string, unknown> & { visualObservations: string[] };
  interpretation: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMetric(value: number, decimals = 3): string {
  return Number.isFinite(value) ? value.toFixed(decimals) : 'Unavailable';
}

function formatGps(metadata: EvidenceMetadata): string {
  const { latitude, longitude } = metadata.gps || {};
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) return 'Not present';
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

function getMetadataStatus(baselineValue: string, suspectValue: string): string {
  const baselineMissing = !baselineValue || baselineValue === 'Not present' || baselineValue === 'Unavailable';
  const suspectMissing = !suspectValue || suspectValue === 'Not present' || suspectValue === 'Unavailable';
  if (baselineMissing && suspectMissing) return 'Unavailable';
  if (baselineMissing || suspectMissing) return 'Missing in one file';
  return baselineValue === suspectValue ? 'Matching' : 'Different';
}

function sourceFromEvidence(item: EvidenceItem | undefined): ComparisonSource | undefined {
  if (!item) return undefined;
  const preview = item.previewUrl || '';
  const url = /^(blob:|data:)/i.test(preview)
    ? preview
    : item.thumbnailUrl || preview;
  return {
    name: item.fileName,
    url,
    mimeType: item.mimeType,
    size: item.fileSize,
    sha256: item.sha256Hash,
    metadata: item.metadata || {},
    evidenceId: item.id,
  };
}

function loadAnalysisCanvas(source: ComparisonSource): Promise<HTMLCanvasElement> {
  if (!source.url) return Promise.reject(new Error(`No readable image preview is available for ${source.name}.`));
  if (source.mimeType.toLowerCase() === 'image/svg+xml' || /\.svgz?$/i.test(source.name)) {
    return Promise.reject(new Error('Vector images are not accepted. Choose a decoded raster image (JPEG, PNG, TIFF, WebP, BMP, GIF, or AVIF).'));
  }
  if (/^https?:/i.test(source.url)) {
    try {
      if (new URL(source.url, window.location.href).origin !== window.location.origin) {
        return Promise.reject(new Error(`The preview for ${source.name} is hosted on another origin. Choose its original file locally instead.`));
      }
    } catch {
      return Promise.reject(new Error(`The preview URL for ${source.name} is invalid.`));
    }
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (/^https?:/i.test(source.url)) image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error(`${source.name} decoded with invalid image dimensions.`));
        return;
      }
      const scale = Math.min(1, MAX_ANALYSIS_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        reject(new Error('The browser could not create a local image canvas.'));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      try {
        context.getImageData(0, 0, 1, 1);
        resolve(canvas);
      } catch {
        reject(new Error(
          `The browser cannot read pixels from ${source.name}. Choose the original file from your device for local analysis.`,
        ));
      }
    };
    image.onerror = () => reject(new Error(`Could not decode ${source.name} as an image.`));
    image.src = source.url;
  });
}

function downloadFile(filename: string, contents: BlobPart, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function createCopyMoveOverlay(
  canvas: HTMLCanvasElement,
  candidates: CopyMoveCandidate[],
): string {
  const overlay = document.createElement('canvas');
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  const context = overlay.getContext('2d');
  if (!context) throw new Error('The browser could not render copy-move match markers.');
  context.drawImage(canvas, 0, 0);
  candidates.slice(0, 12).forEach((candidate, index) => {
    context.strokeStyle = `hsl(${(index * 37) % 360} 90% 60%)`;
    context.fillStyle = context.strokeStyle;
    context.lineWidth = Math.max(2, canvas.width / 700);
    context.beginPath();
    context.moveTo(candidate.first.x, candidate.first.y);
    context.lineTo(candidate.second.x, candidate.second.y);
    context.stroke();
    for (const point of [candidate.first, candidate.second]) {
      context.beginPath();
      context.arc(point.x, point.y, Math.max(4, canvas.width / 150), 0, Math.PI * 2);
      context.fill();
    }
  });
  return overlay.toDataURL('image/png');
}

function cropRegion(
  canvas: HTMLCanvasElement,
  region: DifferenceRegion,
): string {
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, region.width);
  crop.height = Math.max(1, region.height);
  const context = crop.getContext('2d');
  if (!context) throw new Error('The browser could not render the selected region.');
  context.drawImage(
    canvas,
    region.x, region.y, region.width, region.height,
    0, 0, crop.width, crop.height,
  );
  return crop.toDataURL('image/png');
}

export const MediaComparisonView: React.FC<MediaComparisonViewProps> = ({
  evidenceList,
  caseId,
  investigationId,
}) => {
  const images = useMemo(() => evidenceList.filter((item) => item.mediaType === 'image'), [evidenceList]);
  const [baselineId, setBaselineId] = useState('');
  const [suspectId, setSuspectId] = useState('');
  const [localBaseline, setLocalBaseline] = useState<LocalEvidenceSource | null>(null);
  const [localSuspect, setLocalSuspect] = useState<LocalEvidenceSource | null>(null);
  const [error, setError] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState('');
  const [analysis, setAnalysis] = useState<LocalImageComparison | null>(null);
  const [metrics, setMetrics] = useState<RasterMetrics | null>(null);
  const [regions, setRegions] = useState<DifferenceRegion[]>([]);
  const [analysisCanvases, setAnalysisCanvases] = useState<{
    baseline: HTMLCanvasElement;
    suspect: HTMLCanvasElement;
  } | null>(null);
  const [baselinePreview, setBaselinePreview] = useState('');
  const [suspectPreview, setSuspectPreview] = useState('');
  const [heatmapUrl, setHeatmapUrl] = useState('');
  const [copyMoveOverlay, setCopyMoveOverlay] = useState('');
  const [regionPreview, setRegionPreview] = useState<{ baseline: string; suspect: string } | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<number | null>(null);
  const [sensitivity, setSensitivity] = useState(24);
  const [heatmapIntensity, setHeatmapIntensity] = useState(1);
  const [splitPosition, setSplitPosition] = useState(50);
  const [overlayOpacity, setOverlayOpacity] = useState(50);
  const [showOriginalUnderHeatmap, setShowOriginalUnderHeatmap] = useState(true);
  const [viewerMode, setViewerMode] = useState<ViewerMode>('split');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    const baselineDefault = images.find((item) => item.isOriginal) || images[0];
    if (!images.some((item) => item.id === baselineId)) setBaselineId(baselineDefault?.id || '');
    const activeBaseline = images.find((item) => item.id === baselineId) || baselineDefault;
    const suspectDefault = images.find((item) => !item.isOriginal && item.id !== activeBaseline?.id)
      || images.find((item) => item.id !== activeBaseline?.id);
    if (!images.some((item) => item.id === suspectId) || suspectId === baselineId) {
      setSuspectId(suspectDefault?.id || '');
    }
  }, [images, baselineId, suspectId]);

  useEffect(() => {
    return () => {
      if (localBaseline?.url) URL.revokeObjectURL(localBaseline.url);
    };
  }, [localBaseline?.url]);

  useEffect(() => {
    return () => {
      if (localSuspect?.url) URL.revokeObjectURL(localSuspect.url);
    };
  }, [localSuspect?.url]);

  const baselineEvidence = images.find((item) => item.id === baselineId);
  const suspectEvidence = images.find((item) => item.id === suspectId);
  const baselineSource = localBaseline
    ? {
      name: localBaseline.file.name,
      url: localBaseline.url,
      mimeType: localBaseline.file.type || 'image/unknown',
      size: localBaseline.file.size,
      sha256: localBaseline.sha256,
      metadata: localBaseline.metadata,
      file: localBaseline.file,
    }
    : sourceFromEvidence(baselineEvidence);
  const suspectSource = localSuspect
    ? {
      name: localSuspect.file.name,
      url: localSuspect.url,
      mimeType: localSuspect.file.type || 'image/unknown',
      size: localSuspect.file.size,
      sha256: localSuspect.sha256,
      metadata: localSuspect.metadata,
      file: localSuspect.file,
    }
    : sourceFromEvidence(suspectEvidence);

  const selectedRegion = regions.find((region) => region.id === selectedRegionId) || regions[0];
  const hashMatch = Boolean(
    baselineSource?.sha256 &&
    suspectSource?.sha256 &&
    verifyHashesMatch(baselineSource.sha256, suspectSource.sha256),
  );

  useEffect(() => {
    setAnalysis(null);
    setMetrics(null);
    setRegions([]);
    setAnalysisCanvases(null);
    setBaselinePreview('');
    setSuspectPreview('');
    setAnalysisStatus(baselineSource && suspectSource
      ? 'Image selection changed. Run analysis again to update the results.'
      : '');
    setError('');
  }, [baselineSource?.url, baselineSource?.sha256, suspectSource?.url, suspectSource?.sha256]);

  useEffect(() => {
    if (!analysis || !metrics) {
      setHeatmapUrl('');
      return;
    }
    try {
      setHeatmapUrl(createHeatmapDataUrl(
        metrics.width,
        metrics.height,
        metrics.differenceMap,
        heatmapIntensity,
        sensitivity,
      ));
    } catch (heatmapError) {
      setError(heatmapError instanceof Error ? heatmapError.message : 'Heatmap rendering failed.');
    }
  }, [analysis, metrics, heatmapIntensity, sensitivity]);

  useEffect(() => {
    if (!analysisCanvases || !analysis) {
      setCopyMoveOverlay('');
      setRegionPreview(null);
      return;
    }
    try {
      setCopyMoveOverlay(createCopyMoveOverlay(
        analysisCanvases.suspect,
        analysis.copyMoveCandidates,
      ));
      if (selectedRegion) {
        setRegionPreview({
          baseline: cropRegion(analysisCanvases.baseline, selectedRegion),
          suspect: cropRegion(analysis.alignedSuspect, selectedRegion),
        });
      } else {
        setRegionPreview(null);
      }
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Comparison preview rendering failed.');
    }
  }, [analysisCanvases, analysis, selectedRegion]);

  useEffect(() => {
    if (!analysis || !analysisCanvases) return;
    let active = true;
    try {
      let changedPixels = 0;
      for (const difference of analysis.metrics.differenceMap) {
        if (difference > sensitivity) changedPixels++;
      }
      const totalPixels = analysis.metrics.differenceMap.length;
      const updatedMetrics: RasterMetrics = {
        ...analysis.metrics,
        changedPixels,
        changedPercent: totalPixels ? (changedPixels / totalPixels) * 100 : 0,
      };
      setMetrics(updatedMetrics);
      void detectDifferenceRegions(updatedMetrics, sensitivity)
        .then((updatedRegions) => {
          if (!active) return;
          setRegions(updatedRegions);
          setSelectedRegionId((current) => (
            updatedRegions.some((region) => region.id === current)
              ? current
              : updatedRegions[0]?.id ?? null
          ));
        })
        .catch((regionError: unknown) => {
          if (active) setError(regionError instanceof Error ? regionError.message : 'Changed-region extraction failed.');
        });
    } catch (metricError) {
      setError(metricError instanceof Error ? metricError.message : 'Pixel metrics could not be recalculated.');
    }
    return () => {
      active = false;
    };
  }, [analysis, analysisCanvases, sensitivity]);

  const acceptLocalFile = async (file: File, side: 'baseline' | 'suspect') => {
    setError('');
    if (file.size > MAX_FILE_BYTES) {
      setError(`The file exceeds the ${formatBytes(MAX_FILE_BYTES)} local-analysis limit.`);
      return;
    }
    setAnalysisStatus(`Validating ${file.name} locally…`);
    try {
      const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const ascii = (start: number, length: number) => String.fromCharCode(...header.slice(start, start + length));
      const isPng = header.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value);
      const isJpeg = header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
      const isTiff = header.length >= 4 && (
        (ascii(0, 4) === 'II*\u0000') || (ascii(0, 4) === 'MM\u0000*')
      );
      const isWebp = header.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
      const isBmp = header.length >= 2 && ascii(0, 2) === 'BM';
      const isGif = header.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a');
      const isAvif = header.length >= 12 && ascii(4, 4) === 'ftyp' && /^(avif|avis)$/.test(ascii(8, 4));
      if (!(isJpeg || isPng || isTiff || isWebp || isBmp || isGif || isAvif)) {
        setAnalysisStatus('');
        setError('The file content is not a supported raster image. Choose a valid JPEG, PNG, TIFF, WebP, BMP, GIF, or AVIF file.');
        return;
      }

      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(file);
        bitmap.close();
      } else {
        await new Promise<void>((resolve, reject) => {
          const testUrl = URL.createObjectURL(file);
          const image = new Image();
          image.onload = () => {
            URL.revokeObjectURL(testUrl);
            resolve();
          };
          image.onerror = () => {
            URL.revokeObjectURL(testUrl);
            reject(new Error('The selected file is not a decodable image.'));
          };
          image.src = testUrl;
        });
      }
      const [metadata, hashes] = await Promise.all([
        extractMediaMetadata(file),
        calculateEvidenceHashes(file),
      ]);
      const source: LocalEvidenceSource = {
        file,
        url: URL.createObjectURL(file),
        metadata,
        sha256: hashes.sha256,
      };
      if (side === 'baseline') {
        setLocalBaseline(source);
        setBaselineId('');
      } else {
        setLocalSuspect(source);
        setSuspectId('');
      }
      setAnalysis(null);
      setMetrics(null);
      setAnalysisStatus('Local image is ready. It has not been uploaded or saved.');
    } catch (fileError) {
      setAnalysisStatus('');
      setError(fileError instanceof Error ? fileError.message : 'Could not validate the selected image.');
    }
  };

  const runAnalysis = async () => {
    if (!baselineSource || !suspectSource) {
      setError('Select or choose both a baseline image and a suspect image.');
      return;
    }
    setError('');
    setIsAnalyzing(true);
    setAnalysisStatus('Loading the local OpenCV runtime and decoding working copies…');
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    try {
      const [baselineCanvas, suspectCanvas] = await Promise.all([
        loadAnalysisCanvas(baselineSource),
        loadAnalysisCanvas(suspectSource),
      ]);
      setAnalysisStatus('Detecting ORB features, estimating alignment, and calculating pixel metrics locally…');
      const result = await analyzeImageCanvases(baselineCanvas, suspectCanvas, sensitivity, offset);
      setAnalysis(result);
      setMetrics(result.metrics);
      setRegions(result.regions);
      setSelectedRegionId(result.regions[0]?.id ?? null);
      setAnalysisCanvases({ baseline: baselineCanvas, suspect: suspectCanvas });
      setBaselinePreview(baselineCanvas.toDataURL('image/png'));
      setSuspectPreview(result.alignedSuspect.toDataURL('image/png'));
      setAnalysisStatus('Analysis complete. Results are computational observations, not an authenticity verdict.');
      setViewerMode('split');
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } catch (analysisError) {
      setAnalysis(null);
      setMetrics(null);
      setAnalysisCanvases(null);
      setError(analysisError instanceof Error ? analysisError.message : 'Local image comparison failed.');
      setAnalysisStatus('');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const resetViewer = () => {
    setViewerMode('split');
    setSplitPosition(50);
    setOverlayOpacity(50);
    setHeatmapIntensity(1);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setOffset({ x: 0, y: 0 });
    setShowOriginalUnderHeatmap(true);
    setSelectedRegionId(regions[0]?.id ?? null);
  };

  const changeSensitivity = (value: number) => {
    setSensitivity(value);
  };

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement && viewerRef.current) {
        await viewerRef.current.requestFullscreen();
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
      setIsFullscreen(Boolean(document.fullscreenElement));
    } catch (fullscreenError) {
      setError(fullscreenError instanceof Error ? fullscreenError.message : 'Fullscreen mode is unavailable.');
    }
  };

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  const metadataRows = useMemo(() => {
    if (!baselineSource || !suspectSource) return [];
    const dimensionText = (source: ComparisonSource, canvas?: HTMLCanvasElement) => source.metadata.dimensions
      ? `${source.metadata.dimensions.width} × ${source.metadata.dimensions.height}`
      : canvas
        ? `${canvas.width} × ${canvas.height} (decoded working image)`
        : 'Unavailable';
    return [
      ['Image dimensions', dimensionText(baselineSource, analysisCanvases?.baseline), dimensionText(suspectSource, analysisCanvases?.suspect)],
      ['File format', baselineSource.metadata.fileFormat || baselineSource.mimeType, suspectSource.metadata.fileFormat || suspectSource.mimeType],
      ['File size', formatBytes(baselineSource.size), formatBytes(suspectSource.size)],
      ['Camera make', baselineSource.metadata.cameraMake || 'Not present', suspectSource.metadata.cameraMake || 'Not present'],
      ['Camera model', baselineSource.metadata.cameraModel || 'Not present', suspectSource.metadata.cameraModel || 'Not present'],
      ['Date/time original', baselineSource.metadata.dateTimeOriginal || 'Not present', suspectSource.metadata.dateTimeOriginal || 'Not present'],
      ['Editing software', baselineSource.metadata.software || 'Not present', suspectSource.metadata.software || 'Not present'],
      ['GPS coordinates', formatGps(baselineSource.metadata), formatGps(suspectSource.metadata)],
      ['Color space', baselineSource.metadata.colorSpace || 'Unavailable', suspectSource.metadata.colorSpace || 'Unavailable'],
    ];
  }, [baselineSource, suspectSource, analysisCanvases]);

  const report: ComparisonReport | null = analysis && metrics && baselineSource && suspectSource
    ? {
      version: 1,
      generatedAt: new Date().toISOString(),
      caseId: caseId || 'Not provided',
      investigationId: investigationId || baselineSource.evidenceId || suspectSource.evidenceId || 'Not provided',
      baseline: {
        fileName: baselineSource.name,
        fileType: baselineSource.mimeType,
        fileSizeBytes: baselineSource.size,
        width: analysisCanvases?.baseline.width,
        height: analysisCanvases?.baseline.height,
        sha256: baselineSource.sha256 || 'Unavailable',
        metadata: baselineSource.metadata,
      },
      suspect: {
        fileName: suspectSource.name,
        fileType: suspectSource.mimeType,
        fileSizeBytes: suspectSource.size,
        width: analysisCanvases?.suspect.width,
        height: analysisCanvases?.suspect.height,
        sha256: suspectSource.sha256 || 'Unavailable',
        metadata: suspectSource.metadata,
      },
      analysis: {
        alignment: analysis.alignment,
        pixelMetrics: {
          mae: metrics.mae,
          mse: metrics.mse,
          changedPixels: metrics.changedPixels,
          changedPercent: metrics.changedPercent,
          threshold: sensitivity,
        },
        ssim: metrics.ssim,
        perceptualHashes: {
          baselinePHash: metrics.baselinePHash,
          suspectPHash: metrics.suspectPHash,
          pHashDistance: metrics.pHashDistance,
          dHashDistance: metrics.dHashDistance,
          aHashDistance: metrics.aHashDistance,
        },
        histogramSimilarity: metrics.histogramSimilarity,
        edgeSimilarity: analysis.edgeSimilarity,
        laplacianMeanMagnitude: {
          baseline: analysis.baselineNoiseMean,
          suspect: analysis.suspectNoiseMean,
        },
        laplacianResidualHistogram: analysis.noiseDistribution,
        metadataComparison: metadataRows.map(([field, baseline, suspect]) => ({
          field,
          baseline,
          suspect,
          status: getMetadataStatus(baseline, suspect),
        })),
        visualObservations: [
          `${metrics.changedPixels.toLocaleString()} pixels (${formatMetric(metrics.changedPercent, 2)}%) exceeded the ${sensitivity}/255 threshold.`,
          `${regions.length} connected changed region(s) were identified at the selected threshold.`,
          `SSIM was ${formatMetric(metrics.ssim, 4)} and histogram similarity was ${formatMetric(metrics.histogramSimilarity, 4)}.`,
          `SHA-256 digests ${hashMatch ? 'match' : 'differ or are unavailable'}; this records byte identity only.`,
        ],
        heatmap: {
          filename: 'vexalens-difference-heatmap.png',
          width: metrics.width,
          height: metrics.height,
          legend: { low: 'blue', moderate: 'yellow', high: 'red' },
          pngDataUrl: heatmapUrl || undefined,
        },
        regions,
        copyMoveCandidates: analysis.copyMoveCandidates,
        processing: `All image analysis ran locally in this browser on working copies resized to at most ${MAX_ANALYSIS_EDGE}px on the longest side.`,
        limitations: [
          'Pixel, SSIM, histogram, edge, hash, and region values describe the supplied pair; they do not prove authenticity, manipulation, common authorship, or intent.',
          'Automatic ORB/RANSAC alignment can fail on low-texture images, unrelated scenes, or substantial viewpoint changes. The report records whether a homography was used.',
          'Copy-move candidates are experimental ORB self-matches and require independent examiner review.',
          'Metadata can be missing, edited, stripped, or unavailable after prior ingestion; absence alone is not evidence of manipulation.',
          'Local working copies are resized to a maximum 1600-pixel long edge for browser memory/performance. SHA-256 values refer to original bytes where available.',
        ],
      },
      interpretation: 'Computational comparison observations only. No automatic authenticity verdict is made.',
    }
    : null;

  const downloadJsonReport = () => {
    if (!report) return;
    downloadFile('vexalens-image-comparison-report.json', JSON.stringify(report, null, 2), 'application/json');
  };

  const downloadRegionCsv = () => {
    if (!report) return;
    const lines = [
      ['Region ID', 'X', 'Y', 'Width', 'Height', 'Area px', 'Mean difference'],
      ...regions.map((region) => [
        region.id, region.x, region.y, region.width, region.height, region.area, region.meanDifference.toFixed(2),
      ]),
    ].map((line) => line.map(csvCell).join(','));
    downloadFile('vexalens-difference-regions.csv', lines.join('\r\n'), 'text/csv;charset=utf-8');
  };

  const downloadPdfReport = async () => {
    if (!report || !heatmapUrl) return;
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const margin = 14;
      const pageWidth = pdf.internal.pageSize.getWidth();
      pdf.setFontSize(18);
      pdf.text('VexaLens Forensic Image Comparison', margin, 18);
      pdf.setFontSize(9);
      pdf.text(`Generated: ${new Date(report.generatedAt).toLocaleString()}`, margin, 25);
      pdf.text(`Case: ${report.caseId}   Investigation: ${report.investigationId}`, margin, 31);
      pdf.setFontSize(12);
      pdf.text('Evidence', margin, 42);
      pdf.setFontSize(9);
      pdf.text(pdf.splitTextToSize(`Baseline: ${baselineSource?.name || 'Unavailable'} | SHA-256: ${baselineSource?.sha256 || 'Unavailable'}`, pageWidth - margin * 2), margin, 49);
      pdf.text(pdf.splitTextToSize(`Suspect: ${suspectSource?.name || 'Unavailable'} | SHA-256: ${suspectSource?.sha256 || 'Unavailable'}`, pageWidth - margin * 2), margin, 61);
      pdf.text(`Dimensions processed: ${metrics?.width} × ${metrics?.height}px`, margin, 73);
      pdf.text(`Alignment: ${analysis?.alignment.status} | ORB keypoints: ${analysis?.alignment.baselineKeypoints}/${analysis?.alignment.suspectKeypoints} | RANSAC inliers: ${analysis?.alignment.inliers}`, margin, 80);
      pdf.setFontSize(12);
      pdf.text('Computed comparison metrics', margin, 92);
      pdf.setFontSize(9);
      pdf.text([
        `SHA-256 match: ${hashMatch ? 'Yes (byte-identical)' : 'No / unavailable'}`,
        `MAE: ${formatMetric(metrics?.mae ?? NaN)} | MSE: ${formatMetric(metrics?.mse ?? NaN)}`,
        `Changed pixels: ${metrics?.changedPixels.toLocaleString()} (${formatMetric(metrics?.changedPercent ?? NaN, 2)}%) at threshold ${sensitivity}`,
        `SSIM: ${formatMetric(metrics?.ssim ?? NaN, 4)} | Histogram similarity: ${formatMetric(metrics?.histogramSimilarity ?? NaN, 4)}`,
        `pHash distance: ${metrics?.pHashDistance} | dHash distance: ${metrics?.dHashDistance} | aHash distance: ${metrics?.aHashDistance}`,
        `Changed regions: ${regions.length} | Edge-map agreement: ${formatMetric(analysis?.edgeSimilarity ?? NaN, 4)}`,
        `Experimental copy-move candidate pairs: ${analysis?.copyMoveCandidates.length ?? 0}`,
      ], margin, 100);

      pdf.setFontSize(12);
      pdf.text('Metadata comparison', margin, 143);
      pdf.setFontSize(8);
      let metadataY = 150;
      metadataRows.forEach(([field, baseline, suspect]) => {
        const row = `${field}: ${baseline}  |  ${suspect}  |  ${getMetadataStatus(baseline, suspect)}`;
        const wrapped = pdf.splitTextToSize(row.slice(0, 240), pageWidth - margin * 2);
        pdf.text(wrapped, margin, metadataY);
        metadataY += wrapped.length * 4.2 + 1;
      });

      pdf.addPage();
      pdf.setFontSize(14);
      pdf.text('Difference heatmap and review notes', margin, 18);
      const availableWidth = pageWidth - margin * 2;
      const maxHeatmapHeight = 100;
      const aspect = metrics!.width / metrics!.height;
      const heatmapWidth = Math.min(availableWidth, maxHeatmapHeight * aspect);
      const heatmapHeight = heatmapWidth / aspect;
      pdf.addImage(heatmapUrl, 'PNG', margin + (availableWidth - heatmapWidth) / 2, 25, heatmapWidth, heatmapHeight, undefined, 'FAST');
      pdf.setFontSize(8);
      pdf.text('Heatmap legend: blue = lower pixel difference; yellow = moderate; red = higher difference.', margin, 132);
      pdf.setFontSize(11);
      pdf.text('Key observations', margin, 144);
      pdf.setFontSize(8);
      pdf.text(report.analysis.visualObservations, margin, 151);
      pdf.setFontSize(11);
      pdf.text('Observed regions (largest first)', margin, 175);
      pdf.setFontSize(8);
      const regionSummary = regions.slice(0, 12).map((region) =>
        `#${region.id}: (${region.x}, ${region.y}), ${region.width}×${region.height}px, ${Math.round(region.area)}px², mean difference ${formatMetric(region.meanDifference, 1)}`,
      );
      pdf.text(regionSummary.length ? regionSummary : ['No regions met the selected threshold and area filter.'], margin, 182);
      pdf.setFontSize(8);
      pdf.text(pdf.splitTextToSize(
        'Interpretation: Computational observations only; not a determination of image authenticity, authorship, manipulation, or intent. Local working copies are limited to a 1600px longest edge. ORB alignment and copy-move matches may be inconclusive.',
        pageWidth - margin * 2,
      ), margin, 246);
      pdf.save('vexalens-image-comparison-report.pdf');
    } catch (pdfError) {
      setError(pdfError instanceof Error ? pdfError.message : 'Could not generate the PDF report.');
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    panStart.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!panStart.current) return;
    setPan({
      x: panStart.current.panX + event.clientX - panStart.current.x,
      y: panStart.current.panY + event.clientY - panStart.current.y,
    });
  };

  const stopPanning = (event: React.PointerEvent<HTMLDivElement>) => {
    panStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const renderImageControls = (side: 'baseline' | 'suspect') => {
    const localSource = side === 'baseline' ? localBaseline : localSuspect;
    const selectedId = side === 'baseline' ? baselineId : suspectId;
    const setSelectedId = side === 'baseline' ? setBaselineId : setSuspectId;
    const setLocalSource = side === 'baseline' ? setLocalBaseline : setLocalSuspect;
    const sourceLabel = side === 'baseline' ? 'Baseline / reference' : 'Suspect / questioned';

    return (
      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[.2em] text-cyan-300">{sourceLabel}</p>
            <h2 className="mt-1 text-sm font-bold text-slate-100">{localSource?.file.name || images.find((item) => item.id === selectedId)?.fileName || 'Choose an image'}</h2>
          </div>
          {localSource && (
            <button type="button" onClick={() => setLocalSource(null)} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
              <X className="h-3 w-3" /> Clear local file
            </button>
          )}
        </div>
        <label className="block space-y-1.5 text-xs text-slate-400">
          <span>Use image already in evidence intake</span>
          <select
            value={localSource ? '' : selectedId}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setLocalSource(null);
            }}
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-cyan-500 focus:outline-none"
          >
            <option value="">Select existing evidence…</option>
            {images.map((image) => (
              <option key={image.id} value={image.id}>{image.fileName} ({image.isOriginal ? 'Baseline' : 'Suspect'})</option>
            ))}
          </select>
        </label>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-cyan-500/40 bg-cyan-500/[0.04] px-3 py-3 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-500/10">
          <UploadCloud className="h-4 w-4" />
          Choose a local image (never uploaded)
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.tif,.tiff,.webp,.bmp,.avif,.gif"
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void acceptLocalFile(file, side);
            }}
          />
        </label>
        {(() => {
          const source = side === 'baseline' ? baselineSource : suspectSource;
          if (!source) return <p className="text-[11px] text-slate-500">No image selected.</p>;
          return (
            <div className="grid gap-1 text-[11px] text-slate-400">
              <p>{formatBytes(source.size)} · {source.mimeType || 'Format unavailable'}</p>
              <p>{source.metadata.dimensions
                ? `${source.metadata.dimensions.width} × ${source.metadata.dimensions.height}px`
                : 'Dimensions read from the image during analysis'}</p>
              <p className="break-all font-mono text-slate-500">
                SHA-256: {source.sha256 ? formatShortHash(source.sha256, 12, 12) : 'Unavailable'}
              </p>
              {source.url && (
                <a
                  href={source.url}
                  download={source.name}
                  className="mt-1 inline-flex w-fit items-center gap-1 text-cyan-300 hover:text-cyan-100"
                >
                  <Download className="h-3 w-3" /> Download original
                </a>
              )}
            </div>
          );
        })()}
      </section>
    );
  };

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-4 text-slate-100 sm:p-6">
      <header className="flex flex-col justify-between gap-4 rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-950/35 via-slate-950/80 to-blue-950/30 p-6 sm:flex-row sm:items-center">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[.24em] text-cyan-300">VexaLens · local forensic workstation</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Advanced Forensic Image Comparison Laboratory</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
            Compare a baseline and questioned image with independent pixel, structural, feature, edge, metadata, and integrity observations.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-xs text-emerald-200">
          <CheckCircle2 className="h-4 w-4" /> Processing stays in this browser
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {renderImageControls('baseline')}
        {renderImageControls('suspect')}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] p-3 text-sm text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-sm font-bold">Analysis controls</h2>
            <p className="mt-1 text-xs text-slate-400">OpenCV.js, pixel metrics, and report generation run locally. Original evidence bytes are not modified.</p>
          </div>
          <button
            type="button"
            onClick={() => void runAnalysis()}
            disabled={isAnalyzing || !baselineSource || !suspectSource}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isAnalyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
            {isAnalyzing ? 'Analyzing locally…' : 'Analyze image pair'}
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <label className="space-y-2 text-xs text-slate-300">
            <span className="flex items-center justify-between">
              <span>Difference sensitivity threshold</span><strong>{sensitivity}/255</strong>
            </span>
            <input type="range" min="0" max="100" step="1" value={sensitivity} onChange={(event) => changeSensitivity(Number(event.target.value))} className="w-full accent-cyan-400" />
            <span className="block text-[10px] text-slate-500">Pixel differences below this value are not counted as changed.</span>
          </label>
          <label className="space-y-2 text-xs text-slate-300">
            <span className="flex items-center justify-between"><span>Manual alignment X offset</span><strong>{offset.x}px</strong></span>
            <input type="range" min="-100" max="100" value={offset.x} onChange={(event) => setOffset((current) => ({ ...current, x: Number(event.target.value) }))} className="w-full accent-cyan-400" />
            <span className="block text-[10px] text-slate-500">Applied after automatic alignment when analysis is run.</span>
          </label>
          <label className="space-y-2 text-xs text-slate-300">
            <span className="flex items-center justify-between"><span>Manual alignment Y offset</span><strong>{offset.y}px</strong></span>
            <input type="range" min="-100" max="100" value={offset.y} onChange={(event) => setOffset((current) => ({ ...current, y: Number(event.target.value) }))} className="w-full accent-cyan-400" />
            <span className="block text-[10px] text-slate-500">Offsets use the scaled working-image pixel coordinates.</span>
          </label>
        </div>
        {analysisStatus && <p role="status" className="text-xs text-cyan-200">{analysisStatus}</p>}
      </section>

      {analysis && metrics && analysisCanvases && (
        <>
          <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[.2em] text-cyan-300">Comparison viewer</p>
                <h2 className="mt-1 text-lg font-bold">Aligned visual inspection</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                {([
                  ['split', 'Split'],
                  ['side-by-side', 'Side-by-side'],
                  ['overlay', 'Overlay'],
                  ['heatmap', 'Heatmap'],
                  ['edges', 'Edges'],
                ] as Array<[ViewerMode, string]>).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewerMode(mode)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${viewerMode === mode
                      ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-100'
                      : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}
                  >{label}</button>
                ))}
                <button type="button" onClick={() => setZoom((current) => Math.min(4, current + 0.2))} aria-label="Zoom in" className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"><Plus className="h-4 w-4" /></button>
                <button type="button" onClick={() => setZoom((current) => Math.max(0.5, current - 0.2))} aria-label="Zoom out" className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"><Minus className="h-4 w-4" /></button>
                <button type="button" onClick={() => void toggleFullscreen()} aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"><Maximize2 className="h-4 w-4" /></button>
                <button type="button" onClick={resetViewer} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"><RotateCcw className="h-3 w-3" /> Fit / reset</button>
              </div>
            </div>

            <div
              ref={viewerRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={stopPanning}
              onPointerCancel={stopPanning}
              className="relative flex h-[min(70vh,620px)] min-h-[360px] w-full touch-none items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-black"
              style={{ cursor: zoom > 1 ? 'grab' : 'default' }}
            >
              <div
                className={`relative flex h-full w-full items-center justify-center ${viewerMode === 'side-by-side' ? 'gap-2' : ''}`}
                style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center center' }}
              >
                {viewerMode === 'side-by-side' ? (
                  <>
                    <div className="flex h-full flex-1 items-center justify-center border-r border-slate-800 p-2">
                      <img src={baselinePreview} alt="Baseline image" className="max-h-full max-w-full object-contain" />
                    </div>
                    <div className="flex h-full flex-1 items-center justify-center p-2">
                      <img src={suspectPreview} alt="Aligned suspect image" className="max-h-full max-w-full object-contain" />
                    </div>
                  </>
                ) : viewerMode === 'split' ? (
                  <div className="relative flex h-full w-full items-center justify-center">
                    <img src={suspectPreview} alt="Aligned suspect image" className="absolute inset-0 h-full w-full object-contain" />
                    <img
                      src={baselinePreview}
                      alt="Baseline image"
                      className="absolute inset-0 h-full w-full object-contain"
                      style={{ clipPath: `inset(0 ${100 - splitPosition}% 0 0)` }}
                    />
                    <div className="absolute inset-y-0 w-0.5 bg-cyan-300 shadow-[0_0_16px_2px_rgba(34,211,238,.5)]" style={{ left: `${splitPosition}%` }}>
                      <span className="absolute left-1/2 top-1/2 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-cyan-100 bg-cyan-400 text-slate-950"><Sliders className="h-4 w-4" /></span>
                    </div>
                    <span className="absolute bottom-3 left-3 rounded bg-slate-950/85 px-2 py-1 font-mono text-[10px] text-cyan-200">BASELINE</span>
                    <span className="absolute bottom-3 right-3 rounded bg-slate-950/85 px-2 py-1 font-mono text-[10px] text-rose-200">ALIGNED SUSPECT</span>
                  </div>
                ) : viewerMode === 'overlay' ? (
                  <div className="relative flex h-full w-full items-center justify-center">
                    <img src={baselinePreview} alt="Baseline image" className="absolute inset-0 h-full w-full object-contain" />
                    <img src={suspectPreview} alt="Aligned suspect overlay" className="absolute inset-0 h-full w-full object-contain" style={{ opacity: overlayOpacity / 100 }} />
                  </div>
                ) : viewerMode === 'heatmap' ? (
                  <div className="relative flex h-full w-full items-center justify-center">
                    {showOriginalUnderHeatmap && <img src={baselinePreview} alt="Baseline under difference heatmap" className="absolute inset-0 h-full w-full object-contain" />}
                    <img src={heatmapUrl} alt="Pixel difference heatmap" className="absolute inset-0 h-full w-full object-contain" />
                  </div>
                ) : (
                  <img src={analysis.edgeMap} alt="Canny edge-map difference" className="max-h-full max-w-full object-contain" />
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
              {viewerMode === 'split' && (
                <label className="flex min-w-56 flex-1 items-center gap-3">
                  <span>Split</span>
                  <input type="range" min="0" max="100" value={splitPosition} onChange={(event) => setSplitPosition(Number(event.target.value))} className="flex-1 accent-cyan-400" />
                  <span>{splitPosition}%</span>
                </label>
              )}
              {viewerMode === 'overlay' && (
                <label className="flex min-w-56 flex-1 items-center gap-3">
                  <span>Suspect opacity</span>
                  <input type="range" min="0" max="100" value={overlayOpacity} onChange={(event) => setOverlayOpacity(Number(event.target.value))} className="flex-1 accent-cyan-400" />
                  <span>{overlayOpacity}%</span>
                </label>
              )}
              {viewerMode === 'heatmap' && (
                <>
                  <label className="flex min-w-48 flex-1 items-center gap-3">
                    <span>Intensity</span>
                    <input type="range" min="0.25" max="3" step="0.05" value={heatmapIntensity} onChange={(event) => setHeatmapIntensity(Number(event.target.value))} className="flex-1 accent-cyan-400" />
                  </label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={showOriginalUnderHeatmap} onChange={(event) => setShowOriginalUnderHeatmap(event.target.checked)} /> Show baseline underneath</label>
                  {heatmapUrl && <a href={heatmapUrl} download="vexalens-difference-heatmap.png" className="inline-flex items-center gap-1 text-cyan-300"><Download className="h-3 w-3" /> Download heatmap</a>}
                </>
              )}
              <span>Zoom {Math.round(zoom * 100)}% · drag to pan</span>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-[10px] text-slate-400">
              <span className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full bg-sky-400" /> Low difference</span>
              <span className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full bg-yellow-300" /> Moderate difference</span>
              <span className="inline-flex items-center gap-1"><i className="h-2.5 w-2.5 rounded-full bg-red-500" /> Higher difference</span>
              {viewerMode === 'edges' && <span>Canny edge disagreement is a visual aid, not evidence of editing by itself.</span>}
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard title="Pixel MAE" value={formatMetric(metrics.mae)} description="Mean absolute RGB difference; lower means closer pixel values." />
            <MetricCard title="Pixel MSE" value={formatMetric(metrics.mse, 1)} description="Mean squared RGB difference; larger changes contribute more." />
            <MetricCard title="Changed pixels" value={`${metrics.changedPixels.toLocaleString()} · ${formatMetric(metrics.changedPercent, 2)}%`} description={`Pixels at or above the current ${sensitivity}/255 sensitivity threshold.`} />
            <MetricCard title="SSIM" value={formatMetric(metrics.ssim, 4)} description="Structural similarity over local 8×8 windows; 1 indicates matching structure." />
            <MetricCard title="Histogram similarity" value={formatMetric(metrics.histogramSimilarity, 4)} description="Per-channel 64-bin histogram overlap; spatial layout is not represented." />
            <MetricCard title="pHash distance" value={`${metrics.pHashDistance}/64`} description="Hamming distance between 64-bit DCT perceptual hashes." />
            <MetricCard title="dHash distance" value={`${metrics.dHashDistance}/64`} description="Hamming distance between 64-bit horizontal gradient hashes." />
            <MetricCard title="aHash distance" value={`${metrics.aHashDistance}/64`} description="Hamming distance between 64-bit average-luminance hashes." />
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
              <div className="flex items-center gap-2"><ArrowUpDown className="h-4 w-4 text-cyan-300" /><h2 className="text-sm font-bold">Automatic image alignment</h2></div>
              <p className="text-xs text-slate-400">{analysis.alignment.note}</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <SmallStat label="Status" value={analysis.alignment.status === 'homography' ? 'RANSAC homography' : 'Fit / manual'} />
                <SmallStat label="Baseline ORB keypoints" value={analysis.alignment.baselineKeypoints.toLocaleString()} />
                <SmallStat label="Suspect ORB keypoints" value={analysis.alignment.suspectKeypoints.toLocaleString()} />
                <SmallStat label="Good matches / inliers" value={`${analysis.alignment.goodMatches} / ${analysis.alignment.inliers}`} />
              </div>
              <p className="text-[11px] text-slate-500">Inlier rate: {formatMetric(analysis.alignment.inlierRate * 100, 1)}% of ratio-tested matches. This is a match statistic, not a calibrated confidence score.</p>
            </div>
            <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
              <div className="flex items-center gap-2"><ImageIcon className="h-4 w-4 text-cyan-300" /><h2 className="text-sm font-bold">Edge and texture comparison</h2></div>
              <p className="text-xs text-slate-400">Canny edge-map agreement and mean Laplacian magnitude are separate descriptors of boundaries and high-frequency texture.</p>
              <div className="grid grid-cols-2 gap-3">
                <SmallStat label="Canny edge-map agreement" value={`${formatMetric(analysis.edgeSimilarity * 100, 2)}%`} />
                <SmallStat label="Baseline high-pass mean" value={formatMetric(analysis.baselineNoiseMean, 2)} />
                <SmallStat label="Suspect high-pass mean" value={formatMetric(analysis.suspectNoiseMean, 2)} />
                <SmallStat label="Changed regions" value={regions.length.toLocaleString()} />
              </div>
              <div>
                <p className="mb-2 text-[10px] font-semibold text-slate-400">Laplacian residual distribution · normalized frequency</p>
                {(() => {
                  const bins = analysis.noiseDistribution.baseline.map((_, index) => ({
                    baseline: analysis.noiseDistribution.baseline[index],
                    suspect: analysis.noiseDistribution.suspect[index],
                  }));
                  const maximum = Math.max(...bins.flatMap((bin) => [bin.baseline, bin.suspect]), 0.0001);
                  return (
                    <div className="flex h-20 items-end gap-0.5 rounded-lg border border-slate-800 bg-black/20 px-2 pt-2">
                      {bins.map((bin, index) => (
                        <div key={index} title={`Residual ${index * 8}–${(index + 1) * 8}; baseline ${(bin.baseline * 100).toFixed(2)}%, suspect ${(bin.suspect * 100).toFixed(2)}%`} className="flex h-full flex-1 items-end gap-px">
                          <span className="w-1/2 rounded-t bg-cyan-400/80" style={{ height: `${Math.max(1, (bin.baseline / maximum) * 100)}%` }} />
                          <span className="w-1/2 rounded-t bg-rose-400/80" style={{ height: `${Math.max(1, (bin.suspect / maximum) * 100)}%` }} />
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <div className="mt-2 flex gap-4 text-[10px] text-slate-500">
                  <span className="text-cyan-300">■ Baseline</span><span className="text-rose-300">■ Aligned suspect</span>
                </div>
              </div>
              <p className="text-[10px] leading-4 text-slate-500">The high-pass residual is a simple texture proxy, not a calibrated sensor-noise or camera model.</p>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
            <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold">Difference regions</h2>
                  <p className="mt-1 text-xs text-slate-400">Connected components after a 3×3 morphological close; regions are candidates for review, not manipulation labels.</p>
                </div>
                <span className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300">{regions.length} regions</span>
              </div>
              {selectedRegion && regionPreview ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-800 p-2">
                    <p className="mb-2 text-[10px] font-mono text-slate-400">REGION {selectedRegion.id} · BASELINE</p>
                    <img src={regionPreview.baseline} alt={`Baseline crop for region ${selectedRegion.id}`} className="max-h-48 w-full object-contain" />
                  </div>
                  <div className="rounded-lg border border-slate-800 p-2">
                    <p className="mb-2 text-[10px] font-mono text-slate-400">ALIGNED SUSPECT</p>
                    <img src={regionPreview.suspect} alt={`Suspect crop for region ${selectedRegion.id}`} className="max-h-48 w-full object-contain" />
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-800 border-dashed p-5 text-xs text-slate-500">No regions met the current threshold and minimum-area filter. This does not establish that the images are identical.</div>
              )}
              {regions.length > 0 && (
                <div className="max-h-72 overflow-auto rounded-lg border border-slate-800">
                  <table className="w-full min-w-[35rem] text-left text-[11px]">
                    <thead className="sticky top-0 bg-slate-900 text-slate-400">
                      <tr><th className="p-2">Region</th><th className="p-2">Bounding box (x,y)</th><th className="p-2">Dimensions</th><th className="p-2">Area px²</th><th className="p-2">Mean diff</th></tr>
                    </thead>
                    <tbody>
                      {regions.map((region) => (
                        <tr key={region.id} onClick={() => setSelectedRegionId(region.id)} className={`cursor-pointer border-t border-slate-800 ${selectedRegion?.id === region.id ? 'bg-cyan-500/10' : 'hover:bg-slate-900/70'}`}>
                          <td className="p-2">#{region.id}</td>
                          <td className="p-2 font-mono">{region.x}, {region.y}</td>
                          <td className="p-2">{region.width} × {region.height}px</td>
                          <td className="p-2">{Math.round(region.area).toLocaleString()}</td>
                          <td className="p-2">{formatMetric(region.meanDifference, 1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
              <div className="flex items-center gap-2"><ScanSearch className="h-4 w-4 text-amber-300" /><h2 className="text-sm font-bold">Copy-move candidates · experimental</h2></div>
              <p className="text-xs leading-5 text-slate-400">ORB descriptors from the suspect image are self-matched using a distance-ratio filter and repeated displacement vectors. Repeated textures can still produce false matches; candidates are not a copy-move finding.</p>
              {copyMoveOverlay && analysis.copyMoveCandidates.length > 0 && (
                <img src={copyMoveOverlay} alt="Experimental copy-move keypoint candidates joined by colored lines" className="max-h-64 w-full rounded-lg border border-slate-800 bg-black object-contain" />
              )}
              {analysis.copyMoveCandidates.length ? (
                <ul className="max-h-48 space-y-1 overflow-auto text-[11px] text-slate-300">
                  {analysis.copyMoveCandidates.slice(0, 20).map((candidate, index) => (
                    <li key={`${candidate.first.x}-${candidate.first.y}-${candidate.second.x}-${candidate.second.y}`} className="rounded border border-slate-800 p-2">
                      Pair {index + 1}: ({Math.round(candidate.first.x)}, {Math.round(candidate.first.y)}) ↔ ({Math.round(candidate.second.x)}, {Math.round(candidate.second.y)}) · descriptor distance {candidate.descriptorDistance}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-lg border border-slate-800 border-dashed p-4 text-xs text-slate-500">No candidate pairs met the experimental match filter. Insufficient matches do not rule out duplicated regions.</p>
              )}
            </div>
          </section>

          <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
            <div className="flex items-center gap-2"><ArrowUpDown className="h-4 w-4 text-cyan-300" /><h2 className="text-sm font-bold">Metadata comparison</h2></div>
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full min-w-[40rem] text-left text-xs">
                <thead className="bg-slate-900 text-[10px] uppercase tracking-wide text-slate-400">
                  <tr><th className="p-3">Metadata field</th><th className="p-3">Baseline</th><th className="p-3">Suspect</th><th className="p-3 text-right">Comparison</th></tr>
                </thead>
                <tbody>
                  {metadataRows.map(([label, baselineValue, suspectValue]) => {
                    const status = getMetadataStatus(baselineValue, suspectValue);
                    return (
                      <tr key={label} className="border-t border-slate-800/80">
                        <td className="p-3 font-medium text-slate-300">{label}</td>
                        <td className="max-w-[20rem] truncate p-3 text-slate-400">{baselineValue}</td>
                        <td className="max-w-[20rem] truncate p-3 text-slate-400">{suspectValue}</td>
                        <td className={`p-3 text-right ${status === 'Matching' ? 'text-emerald-300' : status === 'Different' ? 'text-amber-300' : 'text-slate-500'}`}>{status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] leading-5 text-slate-500">Metadata can be stripped or edited. Missing or different metadata alone is not proof of manipulation. “Color space” is shown only when extracted from source metadata.</p>
          </section>

          <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
            <div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-amber-300" /><h2 className="text-sm font-bold">File integrity · separate from visual similarity</h2></div>
            <div className="flex flex-col justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4 sm:flex-row sm:items-center">
              <div>
                {hashMatch ? (
                  <p className="inline-flex items-center gap-2 text-sm font-bold text-emerald-300"><CheckCircle2 className="h-4 w-4" /> SHA-256 digests match (byte-identical files)</p>
                ) : (
                  <p className="inline-flex items-center gap-2 text-sm font-bold text-amber-200"><AlertTriangle className="h-4 w-4" /> SHA-256 digests differ or are unavailable</p>
                )}
                <p className="mt-1 text-[11px] text-slate-500">A different hash only shows that the original file bytes differ; it does not establish manipulation.</p>
              </div>
              <div className="grid gap-1 font-mono text-[10px] text-slate-400">
                <span>Baseline: {baselineSource?.sha256 || 'Unavailable'}</span>
                <span>Suspect: {suspectSource?.sha256 || 'Unavailable'}</span>
              </div>
            </div>
          </section>

          <section className="space-y-4 rounded-2xl border border-cyan-500/20 bg-cyan-950/[0.08] p-5">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2"><FileText className="h-4 w-4 text-cyan-300" /><h2 className="text-sm font-bold">Comparison report</h2></div>
                <p className="mt-1 text-xs text-slate-400">Export calculated metrics, SHA-256 digests, metadata, region data, heatmap, and explicit limitations.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void downloadPdfReport()} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/20"><FileText className="h-3.5 w-3.5" /> Download PDF</button>
                <button type="button" onClick={downloadJsonReport} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800"><FileJson className="h-3.5 w-3.5" /> Export JSON</button>
                <button type="button" onClick={downloadRegionCsv} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800"><FileSpreadsheet className="h-3.5 w-3.5" /> Regions CSV</button>
              </div>
            </div>
            <p className="text-[11px] leading-5 text-slate-500">Originals are not changed. No report or analysis history is written to the case database by this module; downloads are generated locally in the browser.</p>
          </section>
        </>
      )}

      {!analysis && !isAnalyzing && (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/40 p-8 text-center">
          <Eye className="mx-auto h-8 w-8 text-cyan-300" />
          <h2 className="mt-3 text-sm font-bold">Select two images to begin</h2>
          <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-slate-400">
            Choose evidence already in intake or select image files for one-time, browser-local analysis. Local files are not uploaded or saved in VexaLens.
          </p>
          {images.length < 2 && <p className="mt-3 text-[11px] text-slate-500">You can add evidence through Evidence Intake, or choose local images above.</p>}
        </div>
      )}

      <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3 text-[11px] leading-5 text-amber-100/80">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>Forensic assistance only. Pixel differences, compression, missing metadata, low SSIM, edge changes, or hash divergence do not independently prove editing or identify an image’s author. Evaluate each observation in context and preserve original evidence.</p>
      </div>
    </main>
  );

};

const MetricCard: React.FC<{ title: string; value: string; description: string }> = ({ title, value, description }) => (
  <article className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
    <p className="text-[10px] font-mono uppercase tracking-wide text-slate-500">{title}</p>
    <p className="mt-2 break-words text-xl font-bold text-cyan-100">{value}</p>
    <p className="mt-2 text-[10px] leading-4 text-slate-500">{description}</p>
  </article>
);

const SmallStat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
    <p className="text-[9px] uppercase tracking-wide text-slate-500">{label}</p>
    <p className="mt-1 break-words text-xs font-semibold text-slate-200">{value}</p>
  </div>
);
