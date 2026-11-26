import React, { useEffect, useMemo, useRef, useState } from 'react';
import { jsPDF } from 'jspdf';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock3,
  Download,
  FileSearch,
  Fingerprint,
  Globe2,
  MapPin,
  Search,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import type {
  EvidenceItem,
  Investigation,
  ProvenanceEvent,
  UserProfile,
} from '@/types/forensics';
import { calculateEvidenceHashes, calculateSHA256, verifyHashesMatch } from '@/lib/forensics/crypto';
import { extractMediaMetadata } from '@/lib/forensics/metadata';
import { getAuthSession, getSupabaseClient } from '@/lib/supabase';
import {
  assessMetadataIntegrity,
  calculateDistanceKm,
  compareEvidenceOrigins,
  flattenMetadata,
  getEmbeddedLocation,
  getExifToolLocation,
  isAnalysisForEvidence,
  isOriginAnalysisTableMissing,
} from '@/lib/forensics/originIntelligence';

interface MediaOriginIntelligenceViewProps {
  evidenceList: EvidenceItem[];
  investigations: Investigation[];
  user: UserProfile;
  onAddProvenance: (event: Omit<ProvenanceEvent, 'id' | 'timestamp'>) => void;
  onAddEvidence: (
    item: Omit<EvidenceItem, 'id' | 'createdAt'>,
    file: File | Blob,
    hashesPromise: Promise<{ sha256: string; md5: string }>
  ) => Promise<EvidenceItem>;
}

interface OriginAnalysisResult {
  evidenceId: string;
  sha256: string;
  analyzedAt: string;
  mediaType: 'image' | 'video';
  exifToolStatus: 'available' | 'not_installed' | 'error';
  exifToolVersion?: string;
  metadataSource?: 'exiftool' | 'exifreader_fallback' | 'unavailable';
  metadata: Record<string, unknown> | null;
  ffprobeStatus: 'not_applicable' | 'available' | 'not_installed' | 'error';
  ffprobeVersion?: string;
  videoMetadata?: Record<string, unknown>;
  ffmpegStatus: 'not_applicable' | 'available' | 'not_installed' | 'error';
  ffmpegVersion?: string;
  externalProcessingConsent?: boolean;
  frames: Array<{
    timestampSec?: number;
    formattedTimestamp?: string;
    sha256: string;
    status: string;
    landmarks: Array<{
      description: string;
      score?: number;
      locations: Array<{ latitude: number; longitude: number }>;
    }>;
    message?: string;
  }>;
  visionStatus: string;
  visionModel?: string;
  limitations: string[];
}

interface SourcePageMetadata {
  title?: string;
  description?: string;
  images: string[];
  siteName?: string;
  favicon?: string;
  domain: string;
  url: string;
  duration?: number;
}

function isOriginAnalysisResult(value: unknown): value is OriginAnalysisResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<OriginAnalysisResult>;
  return typeof result.sha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(result.sha256) &&
    typeof result.evidenceId === 'string' &&
    typeof result.analyzedAt === 'string' &&
    (result.mediaType === 'image' || result.mediaType === 'video') &&
    Array.isArray(result.frames) &&
    result.frames.every((frame) =>
      Boolean(frame) &&
      typeof frame.sha256 === 'string' &&
      typeof frame.status === 'string' &&
      Array.isArray(frame.landmarks) &&
      frame.landmarks.every((landmark) =>
        Boolean(landmark) &&
        typeof landmark.description === 'string' &&
        Array.isArray(landmark.locations) &&
        landmark.locations.every((location) =>
          typeof location.latitude === 'number' && Number.isFinite(location.latitude) &&
          typeof location.longitude === 'number' && Number.isFinite(location.longitude)
        )
      )
    ) &&
    typeof result.visionStatus === 'string' &&
    Array.isArray(result.limitations);
}

interface ReverseSearchResult {
  evidenceId: string;
  investigationId: string;
  fileName: string;
  sourceSha256: string;
  analyzedAt: string;
  externalProcessingConsent: boolean;
  provider: string;
  providerStatus: string;
  providerMessage?: string;
  webMatches: Array<{
    category: string;
    url?: string;
    title?: string;
    imageUrl?: string;
    description?: string;
    score?: number;
    frameIndex: number;
    timestampSeconds: number | null;
  }>;
  localMatches: Array<{
    evidenceId: string;
    matchType: 'exact_file' | 'visually_similar_frame';
    frameIndex?: number;
    candidateFrameIndex?: number;
    timestampSeconds?: number | null;
    hammingDistance?: number;
    note: string;
  }>;
  fingerprint: {
    media_type: 'image' | 'video';
    source_sha256: string;
    video_metadata: Record<string, number> | null;
    frames: Array<{
      frame_index: number;
      timestamp_seconds: number | null;
      width: number;
      height: number;
      thumbnail_base64: string;
    }>;
    limitations: string[];
    processing_seconds: number;
  };
  limitations: string[];
}

function isReverseSearchResult(value: unknown): value is ReverseSearchResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<ReverseSearchResult>;
  const fingerprint = result.fingerprint;
  return typeof result.evidenceId === 'string' &&
    typeof result.investigationId === 'string' &&
    typeof result.fileName === 'string' &&
    typeof result.sourceSha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(result.sourceSha256) &&
    typeof result.analyzedAt === 'string' &&
    typeof result.externalProcessingConsent === 'boolean' &&
    typeof result.provider === 'string' &&
    typeof result.providerStatus === 'string' &&
    Array.isArray(result.webMatches) &&
    result.webMatches.every((match) =>
      Boolean(match) &&
      typeof match.category === 'string' &&
      Number.isInteger(match.frameIndex) &&
      (match.timestampSeconds === null || (typeof match.timestampSeconds === 'number' && Number.isFinite(match.timestampSeconds)))
    ) &&
    Array.isArray(result.localMatches) &&
    result.localMatches.every((match) =>
      Boolean(match) &&
      typeof match.evidenceId === 'string' &&
      (match.matchType === 'exact_file' || match.matchType === 'visually_similar_frame') &&
      typeof match.note === 'string'
    ) &&
    typeof fingerprint === 'object' &&
    fingerprint !== null &&
    (fingerprint.media_type === 'image' || fingerprint.media_type === 'video') &&
    fingerprint.source_sha256.toLowerCase() === result.sourceSha256.toLowerCase() &&
    Array.isArray(fingerprint.frames) &&
    fingerprint.frames.every((frame) =>
      Number.isInteger(frame.frame_index) &&
      (frame.timestamp_seconds === null || (typeof frame.timestamp_seconds === 'number' && Number.isFinite(frame.timestamp_seconds))) &&
      Number.isFinite(frame.width) &&
      Number.isFinite(frame.height) &&
      typeof frame.thumbnail_base64 === 'string'
    ) &&
    Number.isFinite(fingerprint.processing_seconds) &&
    Array.isArray(result.limitations) &&
    result.limitations.every((limitation) => typeof limitation === 'string');
}

const MAX_ORIGIN_UPLOAD_BYTES = 100 * 1024 * 1024;
const ACCEPTED_ORIGIN_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/bmp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);
const ORIGIN_MIME_EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/tiff': ['.tif', '.tiff'],
  'image/bmp': ['.bmp'],
  'video/mp4': ['.mp4', '.m4v'],
  'video/quicktime': ['.mov'],
  'video/webm': ['.webm'],
};

async function hasExpectedOriginSignature(file: File): Promise<boolean> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...header.slice(start, end));
  switch (file.type) {
    case 'image/jpeg':
      return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    case 'image/png':
      return header.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => header[index] === value);
    case 'image/webp':
      return header.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image/tiff':
      return header.length >= 4 &&
        ((header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2a && header[3] === 0) ||
          (header[0] === 0x4d && header[1] === 0x4d && header[2] === 0 && header[3] === 0x2a));
    case 'image/bmp':
      return header.length >= 12 && ascii(0, 2) === 'BM';
    case 'video/mp4':
    case 'video/quicktime':
      return header.length >= 12 && ascii(4, 8) === 'ftyp';
    case 'video/webm':
      return header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
    default:
      return false;
  }
}

const cardClass = 'rounded-xl border p-4';
const cardStyle: React.CSSProperties = {
  background: 'var(--vl-surface)',
  borderColor: 'var(--vl-border)',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(value?: string): string {
  if (!value) return 'Not available';
  const parsed = new Date(value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function integrityLabel(status: ReturnType<typeof assessMetadataIntegrity>['status']): string {
  switch (status) {
    case 'consistent_with_available_metadata':
      return 'Consistent with available metadata';
    case 'inconsistencies_detected':
      return 'Inconsistencies detected';
    case 'possible_metadata_modification':
      return 'Possible metadata modification';
    default:
      return 'Insufficient evidence';
  }
}

function getExifToolTag(metadata: Record<string, unknown> | null | undefined, suffix: string): unknown {
  if (!metadata) return undefined;
  return Object.entries(metadata).find(([key]) =>
    key.toLowerCase().replace(/[^a-z]/g, '').endsWith(suffix.toLowerCase())
  )?.[1];
}

function getServerVideoSummary(metadata: Record<string, unknown> | undefined): {
  durationSec?: number;
  resolution?: string;
  codec?: string;
  frameRate?: number;
  timestamp?: string;
} {
  const format = metadata?.format && typeof metadata.format === 'object'
    ? metadata.format as Record<string, unknown>
    : {};
  const streams = Array.isArray(metadata?.streams)
    ? metadata.streams.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    : [];
  const stream = streams.find((entry) => entry.codec_type === 'video');
  const duration = Number.parseFloat(String(format.duration || ''));
  const rate = String(stream?.avg_frame_rate || stream?.r_frame_rate || '');
  const [numerator, denominator] = rate.split('/').map(Number);
  const frameRate = denominator && Number.isFinite(numerator / denominator)
    ? numerator / denominator
    : undefined;
  const formatTags = format.tags && typeof format.tags === 'object'
    ? format.tags as Record<string, unknown>
    : {};
  const streamTags = stream?.tags && typeof stream.tags === 'object'
    ? stream.tags as Record<string, unknown>
    : {};
  const timestamp = formatTags.creation_time ||
    formatTags['com.apple.quicktime.creationdate'] ||
    streamTags.creation_time;
  return {
    ...(Number.isFinite(duration) ? { durationSec: duration } : {}),
    ...(stream?.width && stream?.height ? { resolution: `${stream.width} × ${stream.height}` } : {}),
    ...(typeof stream?.codec_name === 'string' ? { codec: stream.codec_name } : {}),
    ...(frameRate ? { frameRate } : {}),
    ...(typeof timestamp === 'string' ? { timestamp } : {}),
  };
}

function saveOriginReport(
  evidence: EvidenceItem[],
  investigation: Investigation | undefined,
  relations: ReturnType<typeof compareEvidenceOrigins>,
  analyst: UserProfile,
  analysis?: OriginAnalysisResult
): void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const margin = 18;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const addText = (text: string, size = 9, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(text, contentWidth);
    const height = lines.length * (size * 0.42) + 2;
    if (y + height > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
    doc.text(lines, margin, y);
    y += height;
  };

  doc.setFillColor(15, 32, 52);
  doc.rect(0, 0, pageWidth, 45, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('MEDIA ORIGIN INTELLIGENCE REPORT', margin, 20);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('Metadata-derived observations; not an authenticity determination', margin, 29);
  y = 55;
  doc.setTextColor(25, 38, 55);
  addText(`Case: ${investigation?.caseNumber || 'Not available'} — ${investigation?.title || 'Case unavailable'}`, 10, true);
  addText(`Investigation ID: ${investigation?.id || 'Not available'}`);
  addText(`Report generated: ${new Date().toLocaleString()}`);
  addText(`Analyst: ${analyst.fullName || 'Not available'}`);
  addText('Embedded coordinates and landmark estimates are different evidence sources. Any external provider output is identified below and requires independent verification.');
  addText('Evidence inventory', 12, true);

  for (const item of evidence) {
    addText(`${item.fileName} (${item.mediaType}, ${formatBytes(item.fileSize)})`, 10, true);
    addText(`Evidence ID: ${item.id}`);
    addText(`SHA-256 at ingestion: ${item.sha256Hash || 'Not available'}`);
    const capturedTime = item.metadata?.dateTimeOriginal ||
      String(getExifToolTag(analysis?.metadata, 'DateTimeOriginal') || getExifToolTag(analysis?.metadata, 'CreateDate') || '');
    addText(`MIME type: ${item.mimeType || 'Not available'} | Captured metadata time: ${capturedTime || 'Not available'} | Intake time: ${formatDate(item.createdAt)}`);
    addText(`Device: ${[item.metadata?.cameraMake, item.metadata?.cameraModel].filter(Boolean).join(' ') || 'Not available'} | Software: ${item.metadata?.software || 'Not available'}`);
    const location = getEmbeddedLocation(item) ||
      (analysis && analysis.evidenceId === item.id && analysis.sha256.toLowerCase() === item.sha256Hash.toLowerCase()
        ? getExifToolLocation(analysis.metadata)
        : null);
    addText(
      location
        ? `GPS coordinates (${location.source || 'embedded metadata'}): ${location.latitude}, ${location.longitude}${location.altitude === undefined ? '' : `; altitude ${location.altitude} m`}${'accuracyMeters' in location && location.accuracyMeters !== undefined ? `; reported horizontal accuracy ${location.accuracyMeters} m` : ''}`
        : 'Embedded GPS: No embedded GPS coordinates found.'
    );
    addText(`Metadata integrity: ${integrityLabel(assessMetadataIntegrity(item).status)}`);
    for (const warning of assessMetadataIntegrity(item).warnings) addText(`Warning: ${warning}`);
    for (const limitation of assessMetadataIntegrity(item).limitations) addText(`Limitation: ${limitation}`);
  }

  addText('Cross-evidence observations', 12, true);
  if (!relations.length) addText('No comparable metadata fields were available for the selected evidence.');
  for (const relation of relations) {
    const first = evidence.find((item) => item.id === relation.firstId)?.fileName || relation.firstId;
    const second = evidence.find((item) => item.id === relation.secondId)?.fileName || relation.secondId;
    addText(`${first} ↔ ${second}`);
    if (relation.matches.length) addText(`Observed matches: ${relation.matches.join(', ')}`);
    if (relation.differences.length) addText(`Observed differences: ${relation.differences.join(', ')}`);
    addText('These metadata similarities/differences do not establish common physical device ownership or authenticity.');
  }

  if (analysis) {
    addText('Server-side metadata and visual landmark analysis', 12, true);
    addText(`Analysis time: ${analysis.analyzedAt} | Evidence SHA-256: ${analysis.sha256}`);
    addText(`ExifTool: ${analysis.exifToolVersion || analysis.exifToolStatus} | ffprobe: ${analysis.ffprobeVersion || analysis.ffprobeStatus} | FFmpeg: ${analysis.ffmpegVersion || analysis.ffmpegStatus}`);
    addText(`Google Cloud Vision model: ${analysis.visionModel || 'not configured'} | status: ${analysis.visionStatus}. Landmark results are estimates, not verified locations.`);
    addText(`External processing consent: ${analysis.externalProcessingConsent ? 'granted; sanitized derivatives may have been sent to Google Cloud Vision' : 'not granted; local metadata processing only'}.`);
    for (const row of flattenMetadata({
      ...(analysis.metadata ? { ExifTool: analysis.metadata } : {}),
      ...(analysis.videoMetadata ? { FFprobe: analysis.videoMetadata } : {}),
    })) {
      addText(`${row.group} · ${row.field}: ${row.value}`);
    }
    for (const frame of analysis.frames) {
      addText(`Frame ${frame.formattedTimestamp || 'still image'} | SHA-256: ${frame.sha256} | status: ${frame.status}`);
      if (!frame.landmarks.length) addText(frame.message || 'Location could not be determined from available visual evidence.');
      for (const landmark of frame.landmarks) {
        addText(`${landmark.description}${landmark.score === undefined ? '' : ` (API score ${landmark.score.toFixed(3)})`}`);
        for (const location of landmark.locations) {
          addText(`Returned landmark coordinates: ${location.latitude}, ${location.longitude} (provider place coordinate; not device GPS).`);
        }
      }
    }
    for (const limitation of analysis.limitations) addText(`Limitation: ${limitation}`);
  }

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(
      `VexaLens · ${investigation?.caseNumber || 'Unassigned case'} · Page ${page} of ${pages}`,
      margin,
      pageHeight - 8
    );
  }
  const safeCase = (investigation?.caseNumber || 'UNASSIGNED').replace(/[^a-zA-Z0-9_-]/g, '_');
  doc.save(`VexaLens_Origin_Intelligence_${safeCase}.pdf`);
}

function saveReverseMediaReport(result: ReverseSearchResult): void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const margin = 18;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - margin * 2;
  let y = margin;
  const addText = (text: string, size = 9, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(text, contentWidth);
    const height = lines.length * (size * 0.42) + 2;
    if (y + height > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
    doc.text(lines, margin, y);
    y += height;
  };

  doc.setFillColor(15, 32, 52);
  doc.rect(0, 0, pageWidth, 38, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('REVERSE MEDIA INTELLIGENCE REPORT', margin, 18);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('Local perceptual fingerprints and optional public-index observations', margin, 27);
  y = 48;
  doc.setTextColor(25, 38, 55);
  addText(`Original filename: ${result.fileName}`, 10, true);
  addText(`Original SHA-256: ${result.sourceSha256}`);
  addText(`Analysis timestamp: ${result.analyzedAt}`);
  addText(`Video FPS: ${result.fingerprint.video_metadata?.fps ?? 'Not applicable or unavailable'}`);
  addText(`Analysis engine: VexaLens local pHash/dHash/aHash fingerprinting`);
  addText(`External provider: ${result.provider} | status: ${result.providerStatus}`);
  addText(`External processing consent: ${result.externalProcessingConsent ? 'granted for metadata-stripped image/frame derivatives' : 'not granted; local analysis only'}`);
  addText(`Sampled frames: ${result.fingerprint.frames.length} | local processing time: ${result.fingerprint.processing_seconds.toFixed(2)} seconds`);
  addText('Local evidence comparison', 12, true);
  if (!result.localMatches.length) addText('No matches were found in the available user-scoped local search history.');
  for (const match of result.localMatches) {
    addText(`${match.matchType === 'exact_file' ? 'Exact-file SHA-256 match' : 'Visually similar sampled frame'} · evidence ID ${match.evidenceId}`);
    addText(match.note);
    if (match.timestampSeconds !== undefined && match.timestampSeconds !== null) {
      addText(`Source frame timestamp: ${match.timestampSeconds.toFixed(2)} seconds`);
    }
  }
  addText('Public Web Detection observations', 12, true);
  if (!result.webMatches.length) {
    addText(result.providerMessage || 'No indexed matches were returned. This does not establish that the media is absent from the web.');
  }
  for (const match of result.webMatches.slice(0, 80)) {
    const where = match.timestampSeconds === null ? '' : ` · sampled frame at ${match.timestampSeconds.toFixed(2)} s`;
    addText(`${match.category.replace(/_/g, ' ')}${where}`, 9, true);
    if (match.title) addText(`Page: ${match.title}`);
    if (match.url) addText(`Page URL: ${match.url}`);
    if (match.imageUrl) addText(`Image URL: ${match.imageUrl}`);
    if (match.description) addText(`Description: ${match.description}`);
    addText('Publication date: Not provided or independently verified.');
  }
  addText('Limitations and forensic disclaimer', 12, true);
  for (const limitation of result.limitations) addText(limitation);
  addText('A search result, absent result, visual similarity, or indexed page does not by itself establish origin, ownership, authenticity, date, or full-video identity.');

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(`VexaLens · ${result.fileName} · Page ${page} of ${pages}`, margin, pageHeight - 8);
  }
  const safeName = result.fileName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) || 'evidence';
  doc.save(`VexaLens_Reverse_Media_Search_${safeName}.pdf`);
}

export const MediaOriginIntelligenceView: React.FC<MediaOriginIntelligenceViewProps> = ({
  evidenceList,
  investigations,
  user,
  onAddProvenance,
  onAddEvidence,
}) => {
  const [caseId, setCaseId] = useState('all');
  const [selectedId, setSelectedId] = useState<string>('');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [metadataSearch, setMetadataSearch] = useState('');
  const [verification, setVerification] = useState<{ message: string; matched: boolean | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [visionConfigured, setVisionConfigured] = useState<boolean | null>(null);
  const [jsonLinkConfigured, setJsonLinkConfigured] = useState<boolean | null>(null);
  const [externalProcessingConsent, setExternalProcessingConsent] = useState(false);
  const [sourcePageUrl, setSourcePageUrl] = useState('');
  const [sourcePageConsent, setSourcePageConsent] = useState(false);
  const [sourcePageBusy, setSourcePageBusy] = useState(false);
  const [sourcePageError, setSourcePageError] = useState('');
  const [sourcePageResult, setSourcePageResult] = useState<{
    evidenceId: string;
    metadata: SourcePageMetadata;
  } | null>(null);
  const sourcePageRequestId = useRef(0);
  const [analysis, setAnalysis] = useState<OriginAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [analysisNotice, setAnalysisNotice] = useState('');
  const [analysisProgress, setAnalysisProgress] = useState('');
  const [reverseSearchConfigured, setReverseSearchConfigured] = useState<boolean | null>(null);
  const [reverseProcessingConsent, setReverseProcessingConsent] = useState(false);
  const [reverseSearchResult, setReverseSearchResult] = useState<ReverseSearchResult | null>(null);
  const [reverseSearchBusy, setReverseSearchBusy] = useState(false);
  const [reverseSearchError, setReverseSearchError] = useState('');
  const [reverseSearchNotice, setReverseSearchNotice] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadMessage, setUploadMessage] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [frameSampleCount, setFrameSampleCount] = useState(4);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const analysisRequestId = useRef(0);
  const analysisAbortController = useRef<AbortController | null>(null);
  const reverseSearchRequestId = useRef(0);

  const mediaEvidence = useMemo(
    () => evidenceList.filter((item) => item.mediaType === 'image' || item.mediaType === 'video'),
    [evidenceList]
  );
  const visibleEvidence = useMemo(
    () => caseId === 'all' ? mediaEvidence : mediaEvidence.filter((item) => item.investigationId === caseId),
    [caseId, mediaEvidence]
  );
  const activeEvidence = visibleEvidence.find((item) => item.id === selectedId) || visibleEvidence[0];
  const activeAnalysis = activeEvidence && isAnalysisForEvidence(activeEvidence, analysis)
    ? analysis
    : null;
  const activeSourcePageMetadata = sourcePageResult && sourcePageResult.evidenceId === activeEvidence?.id
    ? sourcePageResult.metadata
    : null;
  const activeCase = investigations.find((item) => item.id === activeEvidence?.investigationId);
  const activeLocation = activeEvidence
    ? getEmbeddedLocation(activeEvidence) || getExifToolLocation(activeAnalysis?.metadata)
    : null;
  const serverVideoSummary = getServerVideoSummary(activeAnalysis?.videoMetadata);
  const selectedForComparison = visibleEvidence.filter((item) => compareIds.includes(item.id));
  const locations = selectedForComparison
    .map((item) => {
      const location = getEmbeddedLocation(item) ||
        (item.id === activeEvidence?.id ? getExifToolLocation(activeAnalysis?.metadata) : null);
      return location ? { ...location, evidenceId: item.id, fileName: item.fileName } : null;
    })
    .filter((location): location is NonNullable<typeof location> => location !== null);
  const relations = compareEvidenceOrigins(selectedForComparison);
  const activeIntegrity = activeEvidence ? assessMetadataIntegrity(activeEvidence) : null;
  const metadataRows = activeEvidence
    ? [
      ...flattenMetadata((activeEvidence.metadata || {}) as Record<string, unknown>),
      ...(activeAnalysis?.metadata
        ? flattenMetadata({
          [activeAnalysis.metadataSource === 'exifreader_fallback' ? 'ExifReader' : 'ExifTool']: activeAnalysis.metadata,
        })
        : []),
      ...(activeAnalysis?.videoMetadata ? flattenMetadata({ FFprobe: activeAnalysis.videoMetadata }) : []),
    ]
      .filter((row) => `${row.group} ${row.field} ${row.value}`.toLowerCase().includes(metadataSearch.toLowerCase()))
    : [];
  const hasExtractedMetadata = metadataRows.length > 0;
  const distance = locations.length >= 2
    ? calculateDistanceKm(locations[0], locations[1])
    : null;

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/forensics/origin-analysis/status')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Origin analysis status returned HTTP ${response.status}.`);
        return response.json() as Promise<{
          visionConfigured?: boolean;
          jsonLinkConfigured?: boolean;
          googleWebDetectionConfigured?: boolean;
        }>;
      })
      .then((status) => {
        if (!cancelled) {
          setVisionConfigured(status.visionConfigured === true);
          setJsonLinkConfigured(status.jsonLinkConfigured === true);
          setReverseSearchConfigured(status.googleWebDetectionConfigured === true);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setVisionConfigured(false);
          setJsonLinkConfigured(false);
          setReverseSearchConfigured(false);
          setAnalysisError(error instanceof Error ? error.message : 'Could not load origin-analysis service status.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    sourcePageRequestId.current += 1;
    setSourcePageResult(null);
    setSourcePageError('');
    setSourcePageConsent(false);
    setSourcePageBusy(false);
  }, [activeEvidence?.id]);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++analysisRequestId.current;
    analysisAbortController.current?.abort();
    analysisAbortController.current = null;
    setBusy(false);
    setAnalysisProgress('');
    setAnalysis(null);
    setAnalysisError('');
    setAnalysisNotice('');
    setExternalProcessingConsent(false);
    if (!activeEvidence) return () => { cancelled = true; };

    const client = getSupabaseClient();
    if (!client) return () => { cancelled = true; };
    void (async () => {
      try {
        const { data, error } = await client
          .from('origin_landmark_analyses')
          .select('result, evidence_id')
          .eq('evidence_id', activeEvidence.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (cancelled || requestId !== analysisRequestId.current) return;
        if (error) {
          if (isOriginAnalysisTableMissing(error)) {
            setAnalysisNotice(
              'Saved analysis is unavailable because the Supabase table is not installed. Apply supabase/migrations/20261032_origin_landmark_analysis.sql in the Supabase SQL Editor, then reload the schema cache.'
            );
            return;
          }
          setAnalysisError(`Saved landmark analysis could not be loaded: ${error.message}`);
          return;
        }
        const result = data?.result && typeof data.result === 'object'
          ? { ...data.result, evidenceId: data.evidence_id }
          : data?.result;
        if (requestId !== analysisRequestId.current) return;
        if (isOriginAnalysisResult(result) && isAnalysisForEvidence(activeEvidence, result)) {
          setAnalysis(result);
          setAnalysisNotice('Loaded a previously saved analysis for this evidence.');
        } else if (data?.result) {
          setAnalysisError('Saved origin-analysis record has an invalid data shape and was not displayed.');
        }
      } catch (error) {
        if (!cancelled && requestId === analysisRequestId.current) {
          setAnalysisError(error instanceof Error ? error.message : 'Could not load the saved origin analysis.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeEvidence?.id, activeEvidence?.sha256Hash, caseId]);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++reverseSearchRequestId.current;
    setReverseSearchResult(null);
    setReverseSearchError('');
    setReverseSearchNotice('');
    setReverseProcessingConsent(false);
    setReverseSearchBusy(false);
    if (!activeEvidence) return () => { cancelled = true; };

    const client = getSupabaseClient();
    if (!client) return () => { cancelled = true; };
    void (async () => {
      try {
        const { data, error } = await client
          .from('reverse_media_searches')
          .select('result, evidence_id')
          .eq('evidence_id', activeEvidence.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (cancelled || requestId !== reverseSearchRequestId.current) return;
        if (error) {
          if (/reverse_media_searches|schema cache|does not exist/i.test(error.message)) {
            setReverseSearchNotice(
              'Search history is not installed, so prior searches cannot be compared yet. Local fingerprinting still works. Apply supabase/migrations/20261115010000_reverse_media_searches.sql in the Supabase SQL Editor, then reload the schema cache to enable saved history.'
            );
            return;
          }
          setReverseSearchError(`Saved reverse-search result could not be loaded: ${error.message}`);
          return;
        }
        if (data?.result && typeof data.result === 'object') {
          const result = data.result as unknown;
          if (
            isReverseSearchResult(result) &&
            result.evidenceId === activeEvidence.id &&
            result.sourceSha256.toLowerCase() === activeEvidence.sha256Hash.toLowerCase()
          ) {
            setReverseSearchResult(result);
            setReverseSearchNotice('Loaded the most recent saved reverse-search result for this evidence.');
          } else {
            setReverseSearchError('Saved reverse-search record has an invalid shape or belongs to different evidence.');
          }
        }
      } catch (error) {
        if (!cancelled && requestId === reverseSearchRequestId.current) {
          setReverseSearchError(error instanceof Error ? error.message : 'Could not load saved reverse-search history.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeEvidence?.id, activeEvidence?.sha256Hash, caseId]);

  const selectEvidence = (evidenceId: string) => {
    if (evidenceId === activeEvidence?.id) {
      setVerification(null);
      return;
    }
    analysisRequestId.current += 1;
    analysisAbortController.current?.abort();
    analysisAbortController.current = null;
    setSelectedId(evidenceId);
    setAnalysis(null);
    setAnalysisError('');
    setAnalysisNotice('');
    setAnalysisProgress('');
    setBusy(false);
    setVerification(null);
  };

  const ingestFile = async (file?: File) => {
    if (!file) return;
    setUploadError('');
    setUploadMessage('');
    setAnalysisError('');
    if (!ACCEPTED_ORIGIN_MIME_TYPES.has(file.type)) {
      setUploadError('Unsupported file type. Choose JPEG, PNG, WebP, TIFF, MP4, MOV, or WebM.');
      return;
    }
    const fileExtension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ORIGIN_MIME_EXTENSIONS[file.type]?.includes(fileExtension)) {
      setUploadError('The filename extension does not match the selected media type.');
      return;
    }
    if (file.size <= 0 || file.size > MAX_ORIGIN_UPLOAD_BYTES) {
      setUploadError('File must be non-empty and no larger than 100 MiB.');
      return;
    }
    try {
      if (!(await hasExpectedOriginSignature(file))) {
        setUploadError('The file signature does not match its declared type. The file was not added.');
        return;
      }
    } catch (error) {
      setUploadError(error instanceof Error ? `Could not validate the file signature: ${error.message}` : 'Could not validate the file signature.');
      return;
    }
    const investigationId = caseId !== 'all'
      ? caseId
      : activeEvidence?.investigationId || investigations.find((item) => item.status !== 'closed')?.id;
    const investigation = investigations.find((item) => item.id === investigationId);
    if (!investigation || investigation.status === 'closed') {
      setUploadError('Select an open investigation before adding evidence.');
      return;
    }

    setUploadBusy(true);
    const localPreviewUrl = URL.createObjectURL(file);
    try {
      const mimeType = file.type;
      const mediaType = mimeType.startsWith('image/') ? 'image' : 'video';
      const hashesPromise = calculateEvidenceHashes(file);
      const metadata = await extractMediaMetadata(file);
      const saved = await onAddEvidence({
        investigationId: investigation.id,
        userId: user.id,
        fileName: file.name,
        fileSize: file.size,
        mimeType,
        mediaType,
        sha256Hash: '',
        storageUrl: localPreviewUrl,
        previewUrl: localPreviewUrl,
        isOriginal: true,
        verified: false,
        metadata,
      }, file, hashesPromise);
      URL.revokeObjectURL(localPreviewUrl);
      setCaseId(investigation.id);
      selectEvidence(saved.id);
      setCompareIds([]);
      setExternalProcessingConsent(false);
      setUploadMessage(`${saved.fileName} added to ${investigation.caseNumber}. The original upload was preserved and hashed at intake.`);
    } catch (error) {
      URL.revokeObjectURL(localPreviewUrl);
      setUploadError(error instanceof Error ? error.message : 'Evidence upload failed.');
    } finally {
      setUploadBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const analyzeActiveEvidence = async () => {
    if (!activeEvidence) return;
    const evidence = activeEvidence;
    const requestId = ++analysisRequestId.current;
    analysisAbortController.current?.abort();
    const abortController = new AbortController();
    analysisAbortController.current = abortController;
    setBusy(true);
    setAnalysisProgress('Checking the signed-in investigator and evidence record…');
    setAnalysis(null);
    setAnalysisError('');
    setAnalysisNotice('');
    try {
      const session = await getAuthSession();
      if (!session?.access_token || session.user.id !== activeEvidence.userId) {
        throw new Error('Sign in as the evidence owner with Supabase before requesting server analysis.');
      }

      setAnalysisProgress(evidence.mediaType === 'video'
        ? 'Retrieving the authorized original and extracting the selected video frames…'
        : externalProcessingConsent
          ? 'Retrieving the authorized original and preparing a sanitized landmark-analysis derivative…'
          : 'Retrieving the authorized original for local metadata analysis…');
      const response = await fetch('/api/forensics/origin-analysis', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        signal: abortController.signal,
        body: JSON.stringify({
          evidenceId: evidence.id,
          investigationId: evidence.investigationId,
          expectedSha256: evidence.sha256Hash,
          frameSampleCount,
          externalProcessingConsent: externalProcessingConsent && visionConfigured === true,
        }),
      });
      const responseText = await response.text();
      let payload: {
        result?: OriginAnalysisResult;
        persistenceStatus?: string;
        error?: string;
      };
      try {
        const parsed: unknown = JSON.parse(responseText);
        if (!parsed || typeof parsed !== 'object') throw new Error('Response was not an object.');
        payload = parsed as typeof payload;
      } catch {
        throw new Error(`Origin analysis returned an unreadable response (HTTP ${response.status}).`);
      }
      if (!response.ok) {
        const failedResult = isOriginAnalysisResult(payload.result) &&
          isAnalysisForEvidence(evidence, payload.result)
          ? payload.result
          : null;
        if (requestId === analysisRequestId.current && failedResult) {
          setAnalysis(failedResult);
        }
        if (
          requestId === analysisRequestId.current &&
          failedResult &&
          isOriginAnalysisTableMissing({ message: payload.error || '' })
        ) {
          setAnalysisNotice(
            'Analysis completed, but it could not be saved because the Supabase table is not installed. Apply supabase/migrations/20261032_origin_landmark_analysis.sql in the Supabase SQL Editor, then reload the schema cache.'
          );
          onAddProvenance({
            evidenceId: evidence.id,
            investigationId: evidence.investigationId,
            actionType: 'metadata_check',
            actor: user.fullName || user.email || 'Authenticated investigator',
            recordedSha256: evidence.sha256Hash,
            verifiedMatch: false,
            notes: `Origin analysis completed with ${failedResult.visionStatus} visual landmark status, but its saved analysis table is not installed. Analysis timestamp: ${failedResult.analyzedAt}.`,
          });
          return;
        }
        throw new Error(payload.error || `Origin analysis failed (HTTP ${response.status}).`);
      }
      if (!isOriginAnalysisResult(payload.result) ||
        payload.result.evidenceId !== evidence.id ||
        payload.result.sha256.toLowerCase() !== evidence.sha256Hash.toLowerCase()) {
        throw new Error('Origin-analysis service returned a result for different evidence.');
      }
      if (requestId !== analysisRequestId.current) return;
      setAnalysis(payload.result);
      setAnalysisNotice(
        payload.persistenceStatus === 'saved'
          ? 'Analysis completed and its audit record was saved to the investigation.'
          : 'Analysis completed, but a saved audit record was not confirmed.'
      );
      onAddProvenance({
        evidenceId: evidence.id,
        investigationId: evidence.investigationId,
        actionType: 'metadata_check',
        actor: user.fullName || user.email || 'Authenticated investigator',
        recordedSha256: evidence.sha256Hash,
        verifiedMatch: false,
        notes: `Origin analysis completed with ${payload.result.visionStatus} visual landmark status. ${payload.result.externalProcessingConsent ? 'External processing consent was recorded.' : 'No external Vision processing was requested.'} Analysis timestamp: ${payload.result.analyzedAt}.`,
      });
    } catch (error) {
      if (requestId === analysisRequestId.current && !(error instanceof DOMException && error.name === 'AbortError')) {
        setAnalysisError(error instanceof Error ? error.message : 'Origin analysis failed.');
      }
    } finally {
      if (requestId === analysisRequestId.current) {
        setBusy(false);
        setAnalysisProgress('');
        analysisAbortController.current = null;
      }
    }
  };

  const runReverseMediaSearch = async () => {
    if (!activeEvidence) return;
    const evidence = activeEvidence;
    const requestId = ++reverseSearchRequestId.current;
    setReverseSearchBusy(true);
    setReverseSearchError('');
    setReverseSearchNotice('');
    setReverseSearchResult(null);
    try {
      const session = await getAuthSession();
      if (!session?.access_token || session.user.id !== evidence.userId) {
        throw new Error('Sign in as the evidence owner with Supabase before requesting reverse search.');
      }
      if (!evidence.previewUrl || evidence.previewUrl === evidence.thumbnailUrl) {
        throw new Error('The original evidence bytes are not available in this browser session. Reopen or reselect the original evidence, then retry.');
      }
      setReverseSearchNotice('Reading and verifying the original evidence bytes before local analysis…');
      const originalResponse = await fetch(evidence.previewUrl, {
        signal: AbortSignal.timeout(25_000),
        cache: 'force-cache',
      });
      if (!originalResponse.ok) {
        throw new Error(`Could not read the evidence preview (HTTP ${originalResponse.status}). Reopen the evidence and retry.`);
      }
      const originalBlob = await originalResponse.blob();
      if (originalBlob.size !== evidence.fileSize) {
        throw new Error('The browser evidence bytes do not match the recorded file size. The search was stopped.');
      }
      const browserSha256 = await calculateSHA256(originalBlob);
      if (browserSha256.toLowerCase() !== evidence.sha256Hash.toLowerCase()) {
        throw new Error('The browser evidence bytes do not match the recorded SHA-256. The search was stopped.');
      }
      const response = await fetch('/api/forensics/reverse-media-search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/octet-stream',
          'X-Evidence-Id': evidence.id,
          'X-Investigation-Id': evidence.investigationId,
          'X-Expected-Sha256': browserSha256,
          'X-Frame-Sample-Count': String(frameSampleCount),
          'X-External-Processing-Consent': String(reverseProcessingConsent && reverseSearchConfigured === true),
        },
        signal: AbortSignal.timeout(70_000),
        body: originalBlob,
      });
      const responseText = await response.text();
      let payload: {
        result?: unknown;
        persistenceStatus?: string;
        error?: string;
      };
      try {
        const parsed: unknown = JSON.parse(responseText);
        if (!parsed || typeof parsed !== 'object') throw new Error('Response was not an object.');
        payload = parsed as typeof payload;
      } catch {
        throw new Error(`Reverse media search returned an unreadable response (HTTP ${response.status}).`);
      }
      if (!response.ok) throw new Error(payload.error || `Reverse media search failed (HTTP ${response.status}).`);
      if (
        !isReverseSearchResult(payload.result) ||
        payload.result.evidenceId !== evidence.id ||
        payload.result.sourceSha256.toLowerCase() !== evidence.sha256Hash.toLowerCase()
      ) {
        throw new Error('Reverse-search service returned an invalid result or a result for different evidence.');
      }
      if (requestId !== reverseSearchRequestId.current) return;
      setReverseSearchResult(payload.result);
      setReverseSearchNotice(
        payload.persistenceStatus === 'saved'
          ? 'Local fingerprints and any consented public-index results were saved to the investigation audit history.'
          : 'Search completed locally, but prior-search comparison and saved history are unavailable until the reverse-search migration is applied in Supabase.'
      );
      onAddProvenance({
        evidenceId: evidence.id,
        investigationId: evidence.investigationId,
        actionType: 'metadata_check',
        actor: user.fullName || user.email || 'Authenticated investigator',
        recordedSha256: evidence.sha256Hash,
        verifiedMatch: false,
        notes: `Reverse media search completed with provider status ${payload.result.providerStatus}. ${payload.result.externalProcessingConsent ? 'External processing consent was recorded.' : 'No external provider processing was requested.'} Analysis timestamp: ${payload.result.analyzedAt}.`,
      });
    } catch (error) {
      if (requestId === reverseSearchRequestId.current) {
        setReverseSearchNotice('');
        setReverseSearchError(error instanceof Error ? error.message : 'Reverse media search failed.');
      }
    } finally {
      if (requestId === reverseSearchRequestId.current) setReverseSearchBusy(false);
    }
  };

  const lookupSourcePageMetadata = async () => {
    if (!activeEvidence || !sourcePageConsent) return;
    const requestId = ++sourcePageRequestId.current;
    setSourcePageBusy(true);
    setSourcePageError('');
    setSourcePageResult(null);
    try {
      const url = new URL(sourcePageUrl);
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('Enter a public HTTPS webpage URL without embedded credentials.');
      }
      const session = await getAuthSession();
      if (!session?.access_token || session.user.id !== activeEvidence.userId) {
        throw new Error('Sign in as the evidence owner before requesting webpage metadata.');
      }
      const response = await fetch('/api/forensics/source-page-metadata', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: url.toString(), externalProcessingConsent: true }),
      });
      const payload = await response.json() as {
        metadata?: SourcePageMetadata;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || `JSONLink request failed (HTTP ${response.status}).`);
      if (
        !payload.metadata ||
        payload.metadata.url !== url.toString() ||
        !Array.isArray(payload.metadata.images) ||
        typeof payload.metadata.domain !== 'string'
      ) {
        throw new Error('JSONLink returned an invalid webpage metadata response.');
      }
      if (requestId === sourcePageRequestId.current) {
        setSourcePageResult({ evidenceId: activeEvidence.id, metadata: payload.metadata });
      }
    } catch (error) {
      if (requestId === sourcePageRequestId.current) {
        setSourcePageError(error instanceof Error ? error.message : 'Could not retrieve webpage metadata.');
      }
    } finally {
      if (requestId === sourcePageRequestId.current) setSourcePageBusy(false);
    }
  };

  const toggleComparison = (id: string) => {
    const target = visibleEvidence.find((item) => item.id === id);
    if (!target) return;
    setCompareIds((current) => {
      if (current.includes(id)) return current.filter((entry) => entry !== id);
      const existingCaseId = current.length
        ? visibleEvidence.find((item) => item.id === current[0])?.investigationId
        : undefined;
      return existingCaseId && existingCaseId !== target.investigationId
        ? [id]
        : [...current, id];
    });
  };

  const recordOriginAssessment = () => {
    if (!activeEvidence) return;
    const assessment = assessMetadataIntegrity(activeEvidence);
    const gps = activeLocation;
    onAddProvenance({
      evidenceId: activeEvidence.id,
      investigationId: activeEvidence.investigationId,
      actionType: 'metadata_check',
      actor: user.fullName || user.email || 'Authenticated investigator',
      recordedSha256: activeEvidence.sha256Hash,
      verifiedMatch: false,
      notes: [
        'Media Origin Intelligence assessment recorded.',
        `Integrity status: ${integrityLabel(assessment.status)}.`,
        `Embedded GPS: ${gps ? `${gps.latitude}, ${gps.longitude}` : 'none found'}.`,
        `Metadata warnings: ${assessment.warnings.join(' | ') || 'none recorded'}.`,
      ].join(' '),
    });
  };

  const verifyRetrievedOriginal = async () => {
    if (!activeEvidence) return;
    if (!activeEvidence.previewUrl || activeEvidence.previewUrl === activeEvidence.thumbnailUrl) {
      setVerification({ message: 'Original file is not available for retrieval in this session.', matched: null });
      return;
    }
    setBusy(true);
    setVerification(null);
    try {
      const response = await fetch(activeEvidence.previewUrl);
      if (!response.ok) throw new Error(`Original retrieval failed (HTTP ${response.status}).`);
      const digest = await calculateSHA256(await response.blob());
      const matched = verifyHashesMatch(digest, activeEvidence.sha256Hash);
      const message = matched
        ? 'Retrieved bytes match the SHA-256 recorded at intake.'
        : 'Retrieved bytes do not match the SHA-256 recorded at intake.';
      setVerification({ message, matched });
      onAddProvenance({
        evidenceId: activeEvidence.id,
        investigationId: activeEvidence.investigationId,
        actionType: 'hashing',
        actor: user.fullName || user.email || 'Authenticated investigator',
        recordedSha256: activeEvidence.sha256Hash,
        verifiedMatch: matched,
        sourceUrl: activeEvidence.storageUrl || undefined,
        sourceStatus: matched ? 'verified' : 'unverified',
        notes: `Retrieved original hash recalculated as ${digest}; ${message}`,
      });
    } catch (error) {
      setVerification({
        message: error instanceof Error ? error.message : 'Could not retrieve or hash the original file.',
        matched: null,
      });
    } finally {
      setBusy(false);
    }
  };

  const exportReport = () => {
    saveOriginReport(activeEvidence ? [activeEvidence] : [], activeCase, [], user, activeAnalysis || undefined);
  };

  const plottedLocations = locations.map((location) => ({
    ...location,
    x: 30 + ((location.longitude + 180) / 360) * 740,
    y: 30 + ((90 - location.latitude) / 180) * 340,
  }));
  const landmarkGroups = useMemo(() => {
    const groups = new Map<string, { count: number; timestamps: string[] }>();
    for (const frame of activeAnalysis?.frames || []) {
      for (const landmark of frame.landmarks) {
        const group = groups.get(landmark.description) || { count: 0, timestamps: [] };
        group.count += 1;
        group.timestamps.push(frame.formattedTimestamp || 'still image');
        groups.set(landmark.description, group);
      }
    }
    return [...groups.entries()];
  }, [activeAnalysis]);

  return (
    <main className="mx-auto max-w-7xl space-y-5 p-4 pb-16 sm:p-7" style={{ color: 'var(--vl-text-primary)' }}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: 'var(--vl-ice-cyan)' }}>
            Forensic Intelligence
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Media Origin Intelligence Lab</h1>
          <p className="mt-1 max-w-3xl text-sm" style={{ color: 'var(--vl-text-secondary)' }}>
            Review embedded metadata and local or consented public-index similarity leads; neither establishes source or authenticity.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href="/image-trace.html"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold"
            style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface)', color: 'var(--vl-text-primary)' }}
          >
            <FileSearch size={14} /> Open Image Trace
          </a>
          <button
            type="button"
            onClick={exportReport}
            disabled={!activeEvidence}
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface)' }}
          >
            <Download size={14} /> Download Origin Report (PDF)
          </button>
        </div>
      </header>

      <section className={`${cardClass} flex flex-wrap items-end gap-4`} style={cardStyle}>
        <label className="min-w-56 flex-1 text-xs font-semibold">
          Investigation
          <select
            value={caseId}
            onChange={(event) => {
              setCaseId(event.target.value);
              selectEvidence('');
              setCompareIds([]);
            }}
            className="mt-1 block w-full rounded-lg border px-3 py-2 text-xs"
            style={{ background: 'var(--vl-surface-elevated)', borderColor: 'var(--vl-border)', color: 'var(--vl-text-primary)' }}
          >
            <option value="all">All open investigations</option>
            {investigations.map((investigation) => (
              <option key={investigation.id} value={investigation.id}>
                {investigation.caseNumber} — {investigation.title}
              </option>
            ))}
          </select>
        </label>
        <div className="text-xs" style={{ color: 'var(--vl-text-secondary)' }}>
          {visibleEvidence.length} image/video item{visibleEvidence.length === 1 ? '' : 's'} available
        </div>
      </section>

      <section
        className={`${cardClass} ${isDragging ? 'border-dashed' : ''} space-y-3`}
        style={{ ...cardStyle, borderColor: isDragging ? 'var(--vl-ice-cyan)' : 'var(--vl-border)' }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          void ingestFile(event.dataTransfer.files[0]);
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-bold"><Upload size={16} /> Add image or video evidence</h2>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
              Files are registered through the existing evidence intake so the original is preserved and hashed before analysis.
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/tiff,image/bmp,video/mp4,video/quicktime,video/webm"
            className="sr-only"
            aria-label="Choose an image or video evidence file"
            onChange={(event) => void ingestFile(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadBusy || !investigations.some((item) => item.status !== 'closed')}
            className="rounded-lg border px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}
          >
            {uploadBusy ? 'Preserving original…' : 'Choose media'}
          </button>
        </div>
        <div className="rounded-lg border border-dashed p-4 text-center text-xs" style={{ borderColor: 'var(--vl-border)', color: 'var(--vl-text-secondary)' }}>
          Drop one JPEG, PNG, WebP, TIFF, BMP, MP4, MOV, or WebM file here · maximum 100 MiB
        </div>
        {uploadMessage && <p role="status" className="text-xs text-emerald-300">{uploadMessage}</p>}
        {uploadError && <p role="alert" className="flex items-start gap-2 text-xs text-rose-300"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{uploadError}</p>}
      </section>

      {!visibleEvidence.length ? (
        <section className={`${cardClass} py-12 text-center`} style={cardStyle}>
          <FileSearch className="mx-auto mb-3" size={28} style={{ color: 'var(--vl-text-dim)' }} />
          <h2 className="font-semibold">No image or video evidence in this scope</h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--vl-text-secondary)' }}>
            Upload an image or video into an open case. Intake already calculates its SHA-256 and extracts supported image metadata.
          </p>
        </section>
      ) : (
        <>
          <section className={`${cardClass} space-y-3`} style={cardStyle}>
            <h2 className="flex items-center gap-2 text-sm font-bold"><FileSearch size={16} /> Evidence selection and comparison</h2>
            <div className="grid gap-2 md:grid-cols-2">
              {visibleEvidence.map((item) => (
                <div
                  key={item.id}
                  className="flex min-w-0 items-center gap-3 rounded-lg border p-3"
                  style={{
                    borderColor: item.id === activeEvidence?.id ? 'var(--vl-ice-cyan)' : 'var(--vl-border)',
                    background: 'var(--vl-surface-elevated)',
                  }}
                >
                  <input
                    aria-label={`Analyze ${item.fileName}`}
                    type="radio"
                    name="origin-analysis-evidence"
                    checked={item.id === activeEvidence?.id}
                    onChange={() => selectEvidence(item.id)}
                  />
                  <input
                    aria-label={`Compare ${item.fileName}`}
                    type="checkbox"
                    checked={compareIds.includes(item.id)}
                    onChange={() => toggleComparison(item.id)}
                  />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => {
                    selectEvidence(item.id);
                  }}>
                    <span className="block truncate text-xs font-semibold">{item.fileName}</span>
                    <span className="block truncate text-[10px]" style={{ color: 'var(--vl-text-dim)' }}>
                      {item.mediaType.toUpperCase()} · {formatBytes(item.fileSize)} · {investigations.find((inv) => inv.id === item.investigationId)?.caseNumber || 'Case unavailable'}
                    </span>
                  </button>
                  <span className="text-[10px] uppercase" style={{ color: 'var(--vl-text-dim)' }}>{item.mimeType}</span>
                </div>
              ))}
            </div>
          </section>

          {activeEvidence && activeIntegrity && (
            <>
              <section className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(300px,0.9fr)]">
                <div className={`${cardClass} space-y-4`} style={cardStyle}>
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="flex items-center gap-2 text-sm font-bold"><Fingerprint size={16} /> Evidence identity</h2>
                    <button
                      type="button"
                      onClick={verifyRetrievedOriginal}
                      disabled={busy}
                      className="rounded-md border px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
                      style={{ borderColor: 'var(--vl-border)' }}
                    >
                      {busy ? 'Verifying…' : 'Verify retrieved original'}
                    </button>
                  </div>
                  {activeEvidence.previewUrl && activeEvidence.mediaType === 'image' && (
                    <img src={activeEvidence.previewUrl} alt={activeEvidence.fileName} className="max-h-64 w-full rounded-lg object-contain" />
                  )}
                  {activeEvidence.previewUrl && activeEvidence.mediaType === 'video' && (
                    <video src={activeEvidence.previewUrl} controls preload="metadata" className="max-h-64 w-full rounded-lg bg-black" aria-label={activeEvidence.fileName} />
                  )}
                  <dl className="grid gap-x-4 gap-y-3 text-xs sm:grid-cols-2">
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Filename</dt><dd className="break-all font-medium">{activeEvidence.fileName}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>File identity</dt><dd>{activeEvidence.mimeType} · {formatBytes(activeEvidence.fileSize)}</dd></div>
                    <div className="sm:col-span-2"><dt style={{ color: 'var(--vl-text-dim)' }}>SHA-256 recorded at intake</dt><dd className="break-all font-mono text-[10px]">{activeEvidence.sha256Hash || 'Not available'}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Case</dt><dd>{activeCase?.caseNumber || 'Not available'}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Evidence intake time (not capture time)</dt><dd>{formatDate(activeEvidence.createdAt)}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Origin analysis</dt><dd>{activeAnalysis ? `Analyzed ${formatDate(activeAnalysis.analyzedAt)} · Vision ${activeAnalysis.visionStatus}` : 'Not yet analyzed on the server'}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Metadata extraction</dt><dd>{hasExtractedMetadata ? activeAnalysis?.metadataSource === 'exifreader_fallback' ? 'Server ExifReader fallback and intake metadata are shown below' : 'Intake and available server extraction fields are shown below' : 'No extracted fields recorded yet; run Analyze locally. Unsupported or stripped metadata is possible.'}</dd></div>
                  </dl>
                  {verification && (
                    <p className="flex items-start gap-2 rounded-lg border p-3 text-xs" style={{ borderColor: verification.matched ? '#16876b' : verification.matched === false ? '#c2413a' : 'var(--vl-border)' }}>
                      {verification.matched ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                      {verification.message}
                    </p>
                  )}
                </div>

                <div className={`${cardClass} space-y-3`} style={cardStyle}>
                  <h2 className="flex items-center gap-2 text-sm font-bold"><MapPin size={16} /> Location intelligence</h2>
                  {activeLocation ? (
                    <>
                      {(() => {
                        const location = activeLocation;
                        return (
                          <>
                            <p className="text-xs">Coordinates come from {location.source || 'embedded metadata'}; they are not independently verified.</p>
                            <dl className="grid grid-cols-2 gap-3 text-xs">
                              <div><dt style={{ color: 'var(--vl-text-dim)' }}>Latitude</dt><dd className="font-mono">{location.latitude}</dd></div>
                              <div><dt style={{ color: 'var(--vl-text-dim)' }}>Longitude</dt><dd className="font-mono">{location.longitude}</dd></div>
                              <div><dt style={{ color: 'var(--vl-text-dim)' }}>Altitude</dt><dd>{location.altitude === undefined ? 'Not available' : `${location.altitude} m`}</dd></div>
                              <div><dt style={{ color: 'var(--vl-text-dim)' }}>Reported horizontal accuracy</dt><dd>{'accuracyMeters' in location && location.accuracyMeters !== undefined ? `${location.accuracyMeters} m` : 'Not available'}</dd></div>
                              <div><dt style={{ color: 'var(--vl-text-dim)' }}>Place name</dt><dd>Not available (no geocoder configured)</dd></div>
                              {location.timestamp && <div><dt style={{ color: 'var(--vl-text-dim)' }}>GPS timestamp (UTC)</dt><dd>{location.timestamp}</dd></div>}
                              {location.direction !== undefined && <div><dt style={{ color: 'var(--vl-text-dim)' }}>Image direction</dt><dd>{location.direction}° {location.directionReference || ''}</dd></div>}
                              {location.track !== undefined && <div><dt style={{ color: 'var(--vl-text-dim)' }}>GPS track</dt><dd>{location.track}°</dd></div>}
                              {location.speed !== undefined && <div><dt style={{ color: 'var(--vl-text-dim)' }}>GPS speed</dt><dd>{location.speed} {location.speedUnit || ''}</dd></div>}
                            </dl>
                            <a
                              className="inline-flex items-center gap-1 text-xs font-semibold"
                              style={{ color: 'var(--vl-ice-cyan)' }}
                              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.latitude},${location.longitude}`)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Globe2 size={13} /> Open coordinates in Google Maps
                            </a>
                            <p className="text-[10px]" style={{ color: 'var(--vl-text-dim)' }}>Opening this link shares the coordinates with Google Maps. VexaLens has not sent coordinates to a geocoding service.</p>
                          </>
                        );
                      })()}
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed p-4 text-xs" style={{ borderColor: 'var(--vl-border)', color: 'var(--vl-text-secondary)' }}>
                      No embedded GPS coordinates found.
                    </div>
                  )}
                  {locations.length > 0 && (
                    <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--vl-border)' }}>
                      <p className="text-[10px] font-semibold uppercase tracking-wide">Selected evidence coordinate plot · metadata coordinates only</p>
                      <svg viewBox="0 0 800 400" role="img" aria-label="Interactive longitude and latitude coordinate comparison plot" className="h-48 w-full rounded-lg" style={{ background: 'var(--vl-surface-elevated)' }}>
                        <path d="M 30 200 H 770 M 400 30 V 370" stroke="var(--vl-border)" strokeDasharray="4 5" />
                        {plottedLocations.map((point, index) => (
                          <g key={point.evidenceId} role="button" tabIndex={0} aria-label={`${point.fileName}: ${point.latitude}, ${point.longitude}`}>
                            <circle
                              cx={point.x}
                              cy={point.y}
                              r="7"
                              fill="#62E5E8"
                              stroke="#082f49"
                              strokeWidth="2"
                              onClick={() => selectEvidence(point.evidenceId)}
                              style={{ cursor: 'pointer' }}
                            />
                            <text x={point.x + 10} y={point.y - 9} fill="currentColor" fontSize="12">{index + 1}</text>
                          </g>
                        ))}
                      </svg>
                      {locations.length >= 2 && (
                        <p className="text-xs">Distance between the first two selected embedded locations: <strong>{distance?.toFixed(2)} km</strong> (straight-line estimate).</p>
                      )}
                    </div>
                  )}
                </div>
              </section>

              <section className={`${cardClass} space-y-4`} style={cardStyle}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-sm font-bold"><Search size={16} /> Reverse Media Intelligence</h2>
                    <p className="mt-1 max-w-3xl text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
                      Compare local SHA-256/perceptual fingerprints with prior user-scoped searches. Optionally query Google Web Detection for publicly indexed image matches. A video match refers only to the sampled frame.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {activeEvidence.mediaType === 'video' && (
                      <label className="text-[11px]">
                        Sampled frames
                        <select
                          value={frameSampleCount}
                          onChange={(event) => setFrameSampleCount(Number(event.target.value))}
                          className="ml-2 rounded-md border px-2 py-1"
                          style={{ background: 'var(--vl-surface-elevated)', borderColor: 'var(--vl-border)', color: 'var(--vl-text-primary)' }}
                        >
                          {[1, 2, 4, 6, 8].map((count) => <option key={count} value={count}>{count}</option>)}
                        </select>
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => void runReverseMediaSearch()}
                      disabled={reverseSearchBusy || reverseSearchConfigured === null}
                      className="rounded-lg border px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}
                    >
                      {reverseSearchBusy ? 'Searching…' : reverseProcessingConsent ? 'Search local + public index' : 'Search local evidence'}
                    </button>
                    {reverseSearchResult && (
                      <button
                        type="button"
                        onClick={() => saveReverseMediaReport(reverseSearchResult)}
                        className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-semibold"
                        style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}
                      >
                        <Download size={13} /> Download report
                      </button>
                    )}
                  </div>
                </div>

                {reverseSearchConfigured ? (
                  <label className="flex items-start gap-2 rounded-lg border p-3 text-[11px]" style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}>
                    <input
                      type="checkbox"
                      checked={reverseProcessingConsent}
                      onChange={(event) => setReverseProcessingConsent(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      I consent to send locally generated, metadata-stripped image or sampled-video-frame derivatives to Google Cloud Vision Web Detection. This may incur provider charges and is subject to Google processing, quota, and retention policies. The preserved original is not sent. Unchecked means local evidence comparison only.
                    </span>
                  </label>
                ) : (
                  <p className="rounded-lg border p-3 text-[11px]" style={{ borderColor: 'var(--vl-border)', color: 'var(--vl-text-secondary)' }}>
                    {reverseSearchConfigured === false
                      ? 'Google Web Detection is not configured. Local SHA-256 and perceptual comparison remains available; add the server-only GOOGLE_CLOUD_VISION_API_KEY and restart the server to enable consented public-index searches.'
                      : 'The API status could not be reached. Check the VexaLens server and reload this page.'}
                  </p>
                )}

                {reverseSearchError && <p role="alert" className="flex items-start gap-2 text-xs text-rose-300"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{reverseSearchError}</p>}
                {reverseSearchNotice && <p role="status" className="text-xs text-emerald-300">{reverseSearchNotice}</p>}
                {reverseSearchBusy && (
                  <p role="status" className="text-xs" style={{ color: 'var(--vl-text-secondary)' }}>
                    Verifying the original SHA-256, then sampling media locally{reverseProcessingConsent ? ' and querying Google Web Detection' : ''}…
                  </p>
                )}
                {reverseSearchResult && (
                  <div className="space-y-4 rounded-lg border p-3" style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}>
                    <div className="grid gap-2 text-[11px] sm:grid-cols-2">
                      <p><strong>Analysis time:</strong> {formatDate(reverseSearchResult.analyzedAt)}</p>
                      <p><strong>Original SHA-256:</strong> <span className="break-all font-mono">{reverseSearchResult.sourceSha256}</span></p>
                      <p><strong>Local fingerprint engine:</strong> pHash/dHash/aHash</p>
                      <p><strong>Local processing:</strong> {reverseSearchResult.fingerprint.processing_seconds.toFixed(2)} s</p>
                      {reverseSearchResult.fingerprint.video_metadata && (
                        <>
                          <p><strong>Video FPS:</strong> {reverseSearchResult.fingerprint.video_metadata.fps}</p>
                          <p><strong>Video duration:</strong> {reverseSearchResult.fingerprint.video_metadata.duration_seconds?.toFixed(2)} s</p>
                        </>
                      )}
                      <p><strong>Google Web Detection:</strong> {reverseSearchResult.providerStatus}</p>
                      <p><strong>External processing:</strong> {reverseSearchResult.externalProcessingConsent ? 'consented; derivative images only' : 'not requested'}</p>
                    </div>

                    <div className="space-y-2">
                      <h3 className="text-xs font-bold">Local evidence matches</h3>
                      {!reverseSearchResult.localMatches.length && (
                        <p className="text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
                          No local match was found in the most recent 100 user-scoped reverse-search records. This is not a search of the public web or all workspace files.
                        </p>
                      )}
                      {reverseSearchResult.localMatches.map((match, index) => {
                        const matchedEvidence = evidenceList.find((item) => item.id === match.evidenceId);
                        return (
                          <article key={`${match.evidenceId}-${index}`} className="rounded-md border p-3 text-[11px]" style={{ borderColor: 'var(--vl-border)' }}>
                            <strong>{match.matchType === 'exact_file' ? 'Exact-file SHA-256 match' : 'Visually similar sampled frame'}</strong>
                            <p>{matchedEvidence?.fileName || `Evidence ${match.evidenceId}`}</p>
                            {match.hammingDistance !== undefined && <p>pHash Hamming distance: {match.hammingDistance}/64 (lower is more visually similar; not a probability).</p>}
                            {match.timestampSeconds !== undefined && match.timestampSeconds !== null && <p>Source video timestamp: {match.timestampSeconds.toFixed(2)} s</p>}
                            <p style={{ color: 'var(--vl-text-secondary)' }}>{match.note}</p>
                          </article>
                        );
                      })}
                    </div>

                    <div className="space-y-2">
                      <h3 className="text-xs font-bold">Publicly indexed Web Detection observations</h3>
                      {!reverseSearchResult.webMatches.length && (
                        <p className="text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
                          {reverseSearchResult.providerMessage || 'No indexed matches were returned. This does not establish that the media is absent from the web.'}
                        </p>
                      )}
                      {reverseSearchResult.webMatches.map((match, index) => (
                        <article key={`${match.category}-${match.url || match.imageUrl || match.description || index}`} className="rounded-md border p-3 text-[11px]" style={{ borderColor: 'var(--vl-border)' }}>
                          <div className="flex flex-wrap justify-between gap-2">
                            <strong>{match.category.replace(/_/g, ' ')}</strong>
                            <span>{match.timestampSeconds === null ? 'Still image' : `Sampled video frame · ${match.timestampSeconds.toFixed(2)} s`}</span>
                          </div>
                          {match.title && <p className="mt-1 font-semibold">{match.title}</p>}
                          {match.description && <p className="mt-1">{match.description}{match.score === undefined ? '' : ` · provider score ${match.score.toFixed(3)}, not a calibrated probability`}</p>}
                          {match.url && <a className="mt-1 block break-all underline" href={match.url} target="_blank" rel="noreferrer">Open matching page: {match.url}</a>}
                          {match.imageUrl && <a className="mt-1 block break-all underline" href={match.imageUrl} target="_blank" rel="noreferrer">Open indexed image: {match.imageUrl}</a>}
                          <p className="mt-1" style={{ color: 'var(--vl-text-secondary)' }}>Publication date: Not provided or independently verified.</p>
                        </article>
                      ))}
                    </div>

                    {reverseSearchResult.fingerprint.frames.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-xs font-bold">Locally sampled frames</h3>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          {reverseSearchResult.fingerprint.frames.map((frame) => (
                            <figure key={frame.frame_index} className="rounded-md border p-2" style={{ borderColor: 'var(--vl-border)' }}>
                              <img
                                src={`data:image/jpeg;base64,${frame.thumbnail_base64}`}
                                alt={`Locally sampled frame ${frame.frame_index + 1}`}
                                className="max-h-40 w-full rounded object-contain"
                              />
                              <figcaption className="mt-1 text-[10px]" style={{ color: 'var(--vl-text-secondary)' }}>
                                {reverseSearchResult.fingerprint.media_type === 'video'
                                  ? `Frame ${frame.frame_index + 1} · ${frame.timestamp_seconds?.toFixed(2) ?? 'timestamp unavailable'} s`
                                  : `${frame.width} × ${frame.height}`}
                              </figcaption>
                            </figure>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="space-y-1 border-t pt-3" style={{ borderColor: 'var(--vl-border)' }}>
                      {reverseSearchResult.limitations.map((limitation, index) => (
                        <p key={`${index}-${limitation}`} className="flex items-start gap-2 text-[10px]" style={{ color: 'var(--vl-text-secondary)' }}>
                          <AlertTriangle size={12} className="mt-0.5 shrink-0" />{limitation}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <section className={`${cardClass} space-y-4`} style={cardStyle}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-sm font-bold"><MapPin size={16} /> Visual landmark analysis</h2>
                    <p className="mt-1 max-w-3xl text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
                      {activeEvidence.mediaType === 'video'
                        ? 'The server samples a limited number of frames and associates each response with its video timestamp.'
                        : 'With consent, the server sends a scaled, metadata-stripped image derivative to Google Cloud Vision; the original stays preserved.'}
                      {' '}A recognized landmark is an estimate, not proof of capture location.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {activeEvidence.mediaType === 'video' && (
                      <label className="text-[11px]">
                        Sampled frames
                        <select
                          value={frameSampleCount}
                          onChange={(event) => setFrameSampleCount(Number(event.target.value))}
                          className="ml-2 rounded-md border px-2 py-1"
                          style={{ background: 'var(--vl-surface-elevated)', borderColor: 'var(--vl-border)', color: 'var(--vl-text-primary)' }}
                        >
                          {[1, 2, 4, 6, 8].map((count) => <option key={count} value={count}>{count}</option>)}
                        </select>
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => void analyzeActiveEvidence()}
                      disabled={busy || visionConfigured === null}
                      className="rounded-lg border px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}
                    >
                      {busy ? 'Analyzing…' : externalProcessingConsent ? 'Analyze with Google Vision' : 'Analyze locally'}
                    </button>
                  </div>
                </div>

                {visionConfigured ? (
                  <label className="flex items-start gap-2 rounded-lg border p-3 text-[11px]" style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}>
                    <input
                      type="checkbox"
                      checked={externalProcessingConsent}
                      onChange={(event) => setExternalProcessingConsent(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      If checked, I consent to sending a locally generated, metadata-stripped image derivative or sampled video-frame derivatives to Google Cloud Vision for landmark detection. The provider’s processing, billing, quota, and retention policies apply. If unchecked, only local metadata extraction runs. The preserved original is never sent to Google.
                    </span>
                  </label>
                ) : (
                  <p className="rounded-lg border p-3 text-[11px]" style={{ borderColor: 'var(--vl-border)', color: 'var(--vl-text-secondary)' }}>
                    {visionConfigured === false
                      ? 'The API server reports Google Cloud Vision is not configured. If GOOGLE_CLOUD_VISION_API_KEY is already in .env, fully restart npm run dev and reload this page; otherwise add it as a server-only variable first. Analyze locally extracts metadata only; no media is sent to Google.'
                      : 'The API server status could not be reached. Check that npm run dev is running, then reload this page. Local metadata analysis does not send media to Google.'}
                  </p>
                )}

                {analysisError && <p role="alert" className="flex items-start gap-2 text-xs text-rose-300"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{analysisError}</p>}
                {analysisNotice && <p role="status" className="text-xs text-emerald-300">{analysisNotice}</p>}
                {analysisProgress && <p role="status" className="text-xs" style={{ color: 'var(--vl-text-secondary)' }}>{analysisProgress}</p>}
                {activeAnalysis && (
                  <div className="space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}>
                    <div className="grid gap-2 text-[11px] sm:grid-cols-2">
                      <p><strong>Analysis:</strong> {formatDate(activeAnalysis.analyzedAt)}</p>
                      <p className="break-all"><strong>Verified original SHA-256:</strong> {activeAnalysis.sha256}</p>
                      <p><strong>Metadata extractor:</strong> {activeAnalysis.metadataSource === 'exifreader_fallback'
                        ? 'ExifReader server fallback'
                        : activeAnalysis.metadataSource === 'exiftool'
                          ? `ExifTool ${activeAnalysis.exifToolVersion || 'available'}`
                          : `ExifTool ${activeAnalysis.exifToolStatus}; no server fallback result`}</p>
                      {activeEvidence.mediaType === 'video' && (
                        <>
                          <p><strong>ffprobe:</strong> {activeAnalysis.ffprobeVersion || activeAnalysis.ffprobeStatus}</p>
                          <p><strong>FFmpeg:</strong> {activeAnalysis.ffmpegVersion || activeAnalysis.ffmpegStatus}</p>
                        </>
                      )}
                      <p><strong>Vision status:</strong> {activeAnalysis.visionStatus}</p>
                      <p><strong>Vision model:</strong> {activeAnalysis.visionModel || 'Not configured'}</p>
                      <p><strong>External processing:</strong> {activeAnalysis.externalProcessingConsent ? 'consented; derivative only' : 'not consented; local only'}</p>
                    </div>
                    {!activeAnalysis.frames.some((frame) => frame.landmarks.length > 0) && (
                      <p className="text-xs" style={{ color: 'var(--vl-text-secondary)' }}>
                        {activeAnalysis.visionStatus === 'no_match'
                          ? 'Location could not be determined from available visual evidence.'
                          : activeAnalysis.frames.find((frame) => frame.message)?.message || 'No visual landmark result is available.'}
                      </p>
                    )}
                    {activeEvidence.mediaType === 'video' && landmarkGroups.length > 0 && (
                      <div className="rounded-md border p-3 text-[11px]" style={{ borderColor: 'var(--vl-border)' }}>
                        <p className="font-semibold">Repeated landmark observations</p>
                        {landmarkGroups.map(([name, group]) => (
                          <p key={name} className="mt-1">{name}: {group.count} frame{group.count === 1 ? '' : 's'} ({group.timestamps.join(', ')})</p>
                        ))}
                        <p className="mt-2" style={{ color: 'var(--vl-text-secondary)' }}>
                          Different labels at different timestamps are retained as separate observations; a video may move between locations, so they are not automatically treated as a contradiction.
                        </p>
                      </div>
                    )}
                    <div className="space-y-2">
                      {activeAnalysis.frames.map((frame, frameIndex) => (
                        <article key={`${frame.sha256}-${frameIndex}`} className="rounded-md border p-3" style={{ borderColor: 'var(--vl-border)' }}>
                          <div className="flex flex-wrap justify-between gap-2 text-[11px]">
                            <strong>{activeEvidence.mediaType === 'video' ? `Video frame ${frame.formattedTimestamp || frameIndex + 1}` : 'Still image'}</strong>
                            <span>{frame.status}</span>
                          </div>
                          {frame.landmarks.map((landmark, landmarkIndex) => (
                            <div key={`${landmark.description}-${landmarkIndex}`} className="mt-2 text-xs">
                              <p className="font-semibold">{landmark.description}</p>
                              {typeof landmark.score === 'number' && (
                                <p className="text-[10px]" style={{ color: 'var(--vl-text-secondary)' }}>
                                  Google Vision response score: {landmark.score.toFixed(3)} (provider score, not calibrated location probability)
                                </p>
                              )}
                              {landmark.locations.map((location, locationIndex) => {
                                const embeddedGps = activeLocation;
                                const distanceKm = embeddedGps
                                  ? calculateDistanceKm(embeddedGps, location)
                                  : null;
                                return (
                                  <div key={`${location.latitude}-${location.longitude}-${locationIndex}`} className="mt-1">
                                    <a
                                      href={`https://www.openstreetmap.org/?mlat=${encodeURIComponent(location.latitude)}&mlon=${encodeURIComponent(location.longitude)}#map=15/${encodeURIComponent(location.latitude)}/${encodeURIComponent(location.longitude)}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="font-mono underline"
                                    >
                                      {location.latitude}, {location.longitude} · OpenStreetMap
                                    </a>
                                    {distanceKm !== null && (
                                      <p className="mt-1 text-[10px]" style={{ color: 'var(--vl-text-secondary)' }}>
                                        {distanceKm.toFixed(2)} km from embedded GPS. Landmark place coordinates and embedded capture coordinates have different meanings; review independently.
                                      </p>
                                    )}
                                    <p className="mt-1 text-[10px]" style={{ color: 'var(--vl-text-secondary)' }}>
                                      Geographic accuracy radius was not returned by the landmark provider.
                                    </p>
                                  </div>
                                );
                              })}
                              {!landmark.locations.length && (
                                <a
                                  className="text-[10px] underline"
                                  href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(landmark.description)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Search this landmark in OpenStreetMap (not a verified match)
                                </a>
                              )}
                            </div>
                          ))}
                          {frame.message && <p className="mt-2 text-[10px]" style={{ color: 'var(--vl-text-secondary)' }}>{frame.message}</p>}
                        </article>
                      ))}
                    </div>
                    {activeAnalysis.limitations.map((limitation, index) => (
                      <p key={`${limitation}-${index}`} className="flex items-start gap-2 text-[10px]" style={{ color: 'var(--vl-text-secondary)' }}>
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />{limitation}
                      </p>
                    ))}
                  </div>
                )}
              </section>

              <section className={`${cardClass} space-y-3`} style={cardStyle}>
                <div>
                  <h2 className="text-sm font-bold">Source webpage metadata (JSONLink)</h2>
                  <p className="mt-1 text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
                    This optional lookup returns webpage title, description, and image links. It does not extract image EXIF, device data, or GPS.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    type="url"
                    value={sourcePageUrl}
                    onChange={(event) => {
                      sourcePageRequestId.current += 1;
                      setSourcePageUrl(event.target.value);
                      setSourcePageResult(null);
                      setSourcePageError('');
                      setSourcePageBusy(false);
                    }}
                    placeholder="https://example.com/page"
                    aria-label="Public source webpage URL"
                    className="min-w-64 flex-1 rounded-lg border px-3 py-2 text-xs"
                    style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)', color: 'var(--vl-text-primary)' }}
                  />
                  <button
                    type="button"
                    onClick={() => void lookupSourcePageMetadata()}
                    disabled={
                      sourcePageBusy ||
                      jsonLinkConfigured !== true ||
                      !sourcePageConsent ||
                      !sourcePageUrl.trim()
                    }
                    className="rounded-lg border px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}
                  >
                    {sourcePageBusy ? 'Looking up webpage…' : 'Extract webpage metadata'}
                  </button>
                </div>
                <label className="flex items-start gap-2 text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={sourcePageConsent}
                    onChange={(event) => setSourcePageConsent(event.target.checked)}
                    className="mt-0.5"
                    disabled={jsonLinkConfigured !== true}
                  />
                  <span>I consent to sending this manually entered public webpage URL to JSONLink. The uploaded image and its private storage URL are not sent.</span>
                </label>
                {jsonLinkConfigured === false && (
                  <p className="text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
                    JSONLink is not configured on the API server. Add a rotated JSONLINK_API_KEY to server-only .env and restart npm run dev.
                  </p>
                )}
                {jsonLinkConfigured === null && (
                  <p className="text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>Checking JSONLink server configuration…</p>
                )}
                {sourcePageError && <p role="alert" className="text-xs text-rose-300">{sourcePageError}</p>}
                {activeSourcePageMetadata && (
                  <dl className="grid gap-2 rounded-lg border p-3 text-xs sm:grid-cols-2" style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Page title</dt><dd>{activeSourcePageMetadata.title || 'Not provided'}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Site / domain</dt><dd>{activeSourcePageMetadata.siteName || activeSourcePageMetadata.domain}</dd></div>
                    <div className="sm:col-span-2"><dt style={{ color: 'var(--vl-text-dim)' }}>Description</dt><dd>{activeSourcePageMetadata.description || 'Not provided'}</dd></div>
                    <div className="sm:col-span-2">
                      <dt style={{ color: 'var(--vl-text-dim)' }}>Webpage URL</dt>
                      <dd><a className="break-all underline" href={activeSourcePageMetadata.url} target="_blank" rel="noreferrer">{activeSourcePageMetadata.url}</a></dd>
                    </div>
                    {activeSourcePageMetadata.favicon && (
                      <div className="sm:col-span-2">
                        <dt style={{ color: 'var(--vl-text-dim)' }}>Favicon</dt>
                        <dd><a className="break-all underline" href={activeSourcePageMetadata.favicon} target="_blank" rel="noreferrer">{activeSourcePageMetadata.favicon}</a></dd>
                      </div>
                    )}
                    <div className="sm:col-span-2">
                      <dt style={{ color: 'var(--vl-text-dim)' }}>Image links ({activeSourcePageMetadata.images.length})</dt>
                      <dd className="mt-1 space-y-1">
                        {activeSourcePageMetadata.images.slice(0, 20).map((imageUrl) => (
                          <a key={imageUrl} className="block break-all underline" href={imageUrl} target="_blank" rel="noreferrer">{imageUrl}</a>
                        ))}
                        {!activeSourcePageMetadata.images.length && 'No image links returned.'}
                      </dd>
                    </div>
                  </dl>
                )}
              </section>

              <section className="grid gap-4 lg:grid-cols-2">
                <div className={`${cardClass} space-y-3`} style={cardStyle}>
                  <h2 className="flex items-center gap-2 text-sm font-bold"><Camera size={16} /> Device intelligence</h2>
                  <dl className="grid grid-cols-2 gap-3 text-xs">
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Manufacturer</dt><dd>{activeEvidence.metadata?.cameraMake || String(getExifToolTag(activeAnalysis?.metadata, 'Make') || '') || 'Not available'}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Camera / device</dt><dd>{activeEvidence.metadata?.cameraModel || String(getExifToolTag(activeAnalysis?.metadata, 'Model') || '') || 'Not available'}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Lens</dt><dd>{activeEvidence.metadata?.lensModel || String(getExifToolTag(activeAnalysis?.metadata, 'LensModel') || '') || 'Not available'}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Software identifier</dt><dd className="break-words">{activeEvidence.metadata?.software || String(getExifToolTag(activeAnalysis?.metadata, 'Software') || '') || 'Not available'}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Dimensions / resolution</dt><dd>{activeEvidence.metadata?.dimensions ? `${activeEvidence.metadata?.dimensions.width} × ${activeEvidence.metadata?.dimensions.height}` : activeEvidence.metadata?.videoSpecs?.resolution || serverVideoSummary.resolution || 'Not available'}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Exposure / aperture / ISO</dt><dd>{[activeEvidence.metadata?.exposureTime, activeEvidence.metadata?.aperture, activeEvidence.metadata?.iso && `ISO ${activeEvidence.metadata?.iso}`].filter(Boolean).join(' · ') || 'Not available'}</dd></div>
                    {activeEvidence.mediaType === 'video' && (
                      <>
                        <div><dt style={{ color: 'var(--vl-text-dim)' }}>Duration</dt><dd>{activeEvidence.metadata?.videoSpecs?.durationSec === undefined && serverVideoSummary.durationSec === undefined ? 'Not available (FFprobe not configured)' : `${activeEvidence.metadata?.videoSpecs?.durationSec ?? serverVideoSummary.durationSec} s`}</dd></div>
                        <div><dt style={{ color: 'var(--vl-text-dim)' }}>Codec / frame rate</dt><dd>{[activeEvidence.metadata?.videoSpecs?.videoCodec || serverVideoSummary.codec, activeEvidence.metadata?.videoSpecs?.frameRateFps && `${activeEvidence.metadata?.videoSpecs?.frameRateFps} fps`, !activeEvidence.metadata?.videoSpecs?.frameRateFps && serverVideoSummary.frameRate && `${serverVideoSummary.frameRate.toFixed(2)} fps`].filter(Boolean).join(' · ') || 'Not available (FFprobe not configured)'}</dd></div>
                      </>
                    )}
                  </dl>
                  <p className="text-[10px]" style={{ color: 'var(--vl-text-dim)' }}>
                    Matching model names or settings are observed metadata similarities, not proof of the same physical device or owner.
                  </p>
                </div>

                <div className={`${cardClass} space-y-3`} style={cardStyle}>
                  <h2 className="flex items-center gap-2 text-sm font-bold"><Clock3 size={16} /> Timeline and metadata integrity</h2>
                  <div className="rounded-lg border p-3" style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}>
                    <p className="text-xs font-semibold">{integrityLabel(activeIntegrity.status)}</p>
                    <p className="mt-1 text-[10px]" style={{ color: 'var(--vl-text-secondary)' }}>
                      Assessment of fields that are available; it does not establish authenticity or rule out modification.
                    </p>
                  </div>
                  <dl className="grid grid-cols-2 gap-3 text-xs">
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>EXIF capture time</dt><dd>{formatDate(activeEvidence.metadata?.dateTimeOriginal || String(getExifToolTag(activeAnalysis?.metadata, 'DateTimeOriginal') || ''))}</dd></div>
                    <div><dt style={{ color: 'var(--vl-text-dim)' }}>Digitized time</dt><dd>{formatDate(activeEvidence.metadata?.dateTimeDigitized || String(getExifToolTag(activeAnalysis?.metadata, 'CreateDate') || ''))}</dd></div>
                    <div className="col-span-2"><dt style={{ color: 'var(--vl-text-dim)' }}>Container/stream timeline</dt><dd>{serverVideoSummary.timestamp ? formatDate(serverVideoSummary.timestamp) : activeEvidence.mediaType === 'video' ? `Not available${activeAnalysis?.ffprobeStatus === 'not_installed' ? ' (ffprobe not installed)' : ''}.` : 'Not applicable for this image.'}</dd></div>
                  </dl>
                  {[...activeIntegrity.warnings, ...activeIntegrity.limitations].map((note, index) => (
                    <p key={`${index}-${note}`} className="flex items-start gap-2 text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />{note}
                    </p>
                  ))}
                </div>
              </section>

              <section className={`${cardClass} space-y-3`} style={cardStyle}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-bold"><Search size={16} /> Metadata explorer</h2>
                  <input
                    value={metadataSearch}
                    onChange={(event) => setMetadataSearch(event.target.value)}
                    placeholder="Search field or value"
                    className="rounded-lg border px-3 py-2 text-xs"
                    style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)', color: 'var(--vl-text-primary)' }}
                  />
                </div>
                <div className="max-h-80 overflow-auto rounded-lg border" style={{ borderColor: 'var(--vl-border)' }}>
                  <table className="w-full text-left text-[11px]">
                    <thead className="sticky top-0" style={{ background: 'var(--vl-surface-elevated)' }}>
                      <tr><th className="p-2">Group</th><th className="p-2">Field</th><th className="p-2">Raw / stored value</th><th className="p-2">Source</th></tr>
                    </thead>
                    <tbody>
                      {metadataRows.map((row, index) => (
                        <tr key={`${row.group}-${row.field}-${index}`} className="border-t" style={{ borderColor: 'var(--vl-border)' }}>
                          <td className="p-2">{row.group}</td><td className="p-2">{row.field}</td><td className="break-all p-2">{row.value}</td>
                          <td className="p-2">{row.group.startsWith('ExifTool') ? 'Server ExifTool' : row.group.startsWith('ExifReader') ? 'Server ExifReader fallback' : row.group.startsWith('FFprobe') ? 'Server ffprobe' : 'Stored intake metadata'}</td>
                        </tr>
                      ))}
                      {!metadataRows.length && <tr><td colSpan={4} className="p-5 text-center" style={{ color: 'var(--vl-text-secondary)' }}>No matching extracted fields. Metadata may be missing or unsupported.</td></tr>}
                    </tbody>
                  </table>
                </div>
                <p className="text-[10px]" style={{ color: 'var(--vl-text-dim)' }}>
                  Existing evidence uses stored intake metadata; Analyze locally also re-reads the authorized original with server ExifTool, falling back to ExifReader for supported images. Video stream details require ffprobe/FFmpeg. Missing tools and unsupported or stripped metadata are reported without inventing values.
                </p>
              </section>

              <section className={`${cardClass} space-y-3`} style={cardStyle}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-sm font-bold"><ShieldCheck size={16} /> Evidence Origin Correlation</h2>
                    <p className="mt-1 text-[10px]" style={{ color: 'var(--vl-text-secondary)' }}>Select files above; connections list exact matching and differing metadata fields.</p>
                  </div>
                  <button type="button" onClick={recordOriginAssessment} className="rounded-md border px-3 py-2 text-[11px] font-semibold" style={{ borderColor: 'var(--vl-border)' }}>
                    Record origin assessment
                  </button>
                </div>
                {!selectedForComparison.length ? (
                  <p className="text-xs" style={{ color: 'var(--vl-text-secondary)' }}>Select two or more evidence files to compare their available metadata.</p>
                ) : relations.length ? (
                  <div className="grid gap-2 md:grid-cols-2">
                    {relations.map((relation) => {
                      const first = selectedForComparison.find((item) => item.id === relation.firstId);
                      const second = selectedForComparison.find((item) => item.id === relation.secondId);
                      return (
                        <article key={`${relation.firstId}-${relation.secondId}`} className="rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}>
                          <h3 className="font-semibold">{first?.fileName || relation.firstId} ↔ {second?.fileName || relation.secondId}</h3>
                          {relation.matches.length > 0 && <p className="mt-2"><strong>Observed matches:</strong> {relation.matches.join(', ')}</p>}
                          {relation.differences.length > 0 && <p className="mt-1"><strong>Observed differences:</strong> {relation.differences.join(', ')}</p>}
                          <p className="mt-2 text-[10px]" style={{ color: 'var(--vl-text-dim)' }}>No relationship strength or common-device conclusion is inferred.</p>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs" style={{ color: 'var(--vl-text-secondary)' }}>No comparable fields were present in the selected files.</p>
                )}
                {selectedForComparison.length > 1 && (
                  <div className="flex flex-wrap gap-2 text-[10px]" style={{ color: 'var(--vl-text-dim)' }}>
                    {selectedForComparison.map((item) => <span key={item.id} className="rounded-full border px-2 py-1" style={{ borderColor: 'var(--vl-border)' }}>{item.fileName}</span>)}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
};
