import { calculateSHA256 } from './crypto';

export const VIDEO_GENEALOGY_MAX_VIDEO_BYTES = 128 * 1024 * 1024;
export const VIDEO_GENEALOGY_MAX_MEDIA_COUNT = 5;
const VIDEO_GENEALOGY_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const VIDEO_GENEALOGY_TIMEOUT_MS = 47 * 60 * 1000;
const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);

export interface VideoGenealogyFileResult {
  id: string;
  label: string;
  sha256: string;
  size_bytes: number;
  video: {
    duration_seconds: number;
    fps: number;
    width: number;
    height: number;
    frame_count: number;
    sample_count: number;
    average_laplacian_sharpness: number;
  };
  audio: {
    status: string;
    message: string;
    sample_count: number;
  };
  custody: {
    source_sha256: string;
    analysis_copy_sha256: string;
    original_unchanged: true;
  };
}

export interface VideoGenealogyDatabaseMatch {
  id: string;
  label: string;
  sha256: string;
  video: VideoGenealogyFileResult['video'];
  audio: VideoGenealogyFileResult['audio'];
  match_confidence: number;
  matched_against_id: string;
}

export interface VideoGenealogyComparison {
  first_id: string;
  second_id: string;
  match_confidence: number;
  visual_similarity: number;
  audio_similarity: number | null;
  matched_visual_samples: number;
  matched_audio_samples: number;
  average_visual_hamming_distance: number | null;
  scoring_method: string;
  quality_signals: {
    file_size_ratio_smaller_to_larger: number;
    pixel_count_ratio_smaller_to_larger: number;
    sharpness_ratio_smaller_to_larger: number;
    interpretation: string;
  };
  direction_hypothesis: string;
}

export interface VideoGenealogyTreeEdge {
  source_id: string;
  target_id: string;
  match_confidence: number;
  visual_similarity: number;
  audio_similarity: number | null;
  direction_hypothesis: string;
}

export interface VideoGenealogyCluster {
  id: string;
  anchor_id: string;
  media_ids: string[];
  tree_edges: VideoGenealogyTreeEdge[];
}

export interface VideoGenealogySearchResult {
  status: string;
  query: string;
  youtube: {
    status: string;
    message?: string;
    candidates: Array<{
      title: string;
      channel: string;
      duration_seconds: number | null;
      url: string;
    }>;
  };
  search_links: Array<{ provider: string; url: string }>;
  custom_links: Array<{ provider: string; url: string }>;
}

export interface VideoGenealogyResult {
  analysis_id: string;
  analyzed_at: string;
  root_id: string;
  hash_bits: number;
  hash_backend: string;
  files: VideoGenealogyFileResult[];
  local_database_matches: VideoGenealogyDatabaseMatch[];
  comparisons: VideoGenealogyComparison[];
  clusters: VideoGenealogyCluster[];
  search: VideoGenealogySearchResult;
  persistence: string;
  limitations: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function parseResponse(value: unknown, expectedHashes: string[]): VideoGenealogyResult {
  if (!isRecord(value) || !Array.isArray(value.files) || value.files.length !== expectedHashes.length) {
    throw new Error('The local genealogy service returned an invalid response.');
  }
  const files = value.files as unknown[];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!isRecord(file) || !isRecord(file.custody)) {
      throw new Error('The local genealogy service returned an invalid custody record.');
    }
    if (
      !isSha256(file.sha256) ||
      file.sha256.toLowerCase() !== expectedHashes[index].toLowerCase() ||
      file.custody.source_sha256 !== file.sha256 ||
      file.custody.analysis_copy_sha256 !== file.sha256 ||
      file.custody.original_unchanged !== true
    ) {
      throw new Error('An uploaded file did not match its analyzed copy; no result was accepted.');
    }
  }
  if (
    typeof value.analysis_id !== 'string' ||
    typeof value.analyzed_at !== 'string' ||
    typeof value.root_id !== 'string' ||
    typeof value.hash_bits !== 'number' ||
    typeof value.hash_backend !== 'string' ||
    !Array.isArray(value.local_database_matches) ||
    !Array.isArray(value.comparisons) ||
    !Array.isArray(value.clusters) ||
    !isRecord(value.search) ||
    !Array.isArray(value.limitations)
  ) {
    throw new Error('The local genealogy service returned an incomplete result.');
  }
  return value as unknown as VideoGenealogyResult;
}

export interface AnalyzeVideoGenealogyOptions {
  reference: File;
  candidates: File[];
  hashBits: 64 | 256 | 1024;
  onlineSearch: boolean;
  searchQuery: string;
  customSourceLinks: string[];
}

export async function analyzeVideoGenealogy(
  options: AnalyzeVideoGenealogyOptions,
): Promise<VideoGenealogyResult> {
  const videos = [options.reference, ...options.candidates];
  if (videos.length > VIDEO_GENEALOGY_MAX_MEDIA_COUNT) {
    throw new Error('Choose one reference video and up to four candidates.');
  }
  let totalBytes = 0;
  for (const video of videos) {
    const extension = video.name.slice(video.name.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED_VIDEO_EXTENSIONS.has(extension)) {
      throw new Error(`${video.name} is not an AVI, M4V, MKV, MOV, MP4, or WebM video.`);
    }
    if (video.size === 0 || video.size > VIDEO_GENEALOGY_MAX_VIDEO_BYTES) {
      throw new Error('Each video must be non-empty and no larger than 128 MiB.');
    }
    totalBytes += video.size;
  }
  if (totalBytes > VIDEO_GENEALOGY_MAX_TOTAL_BYTES) {
    throw new Error('The combined upload exceeds the 512 MiB limit.');
  }
  if (options.onlineSearch && !options.searchQuery.trim()) {
    throw new Error('Enter a search phrase before enabling online search.');
  }

  const expectedHashes: string[] = [];
  for (const video of videos) expectedHashes.push(await calculateSHA256(video));
  const form = new FormData();
  form.append('root', options.reference, options.reference.name);
  videos.slice(1).forEach((video) => form.append('candidates', video, video.name));
  form.append('root_sha256', expectedHashes[0]);
  expectedHashes.slice(1).forEach((digest) => form.append('candidate_sha256', digest));
  form.append('hash_bits', String(options.hashBits));
  form.append('online_search', String(options.onlineSearch));
  form.append('search_query', options.searchQuery.trim());
  options.customSourceLinks
    .map((link) => link.trim())
    .filter(Boolean)
    .forEach((link) => form.append('custom_source_link', link));

  let response: Response;
  try {
    response = await fetch('/api/forensics/video-genealogy/analyze', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(VIDEO_GENEALOGY_TIMEOUT_MS),
    });
  } catch (requestError) {
    if (requestError instanceof Error && requestError.name === 'TimeoutError') {
      throw new Error('Video-genealogy analysis exceeded its 47-minute browser limit.');
    }
    throw requestError;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`The local genealogy service returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const error = isRecord(payload) && typeof payload.detail === 'string'
      ? payload.detail
      : isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : 'Video-genealogy analysis failed.';
    throw new Error(error);
  }
  return parseResponse(payload, expectedHashes);
}
