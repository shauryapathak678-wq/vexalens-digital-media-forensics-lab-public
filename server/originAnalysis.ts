import crypto from 'crypto';
import ExifReader from 'exifreader';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type VisionStatus =
  | 'not_configured'
  | 'completed'
  | 'no_match'
  | 'quota_exceeded'
  | 'authentication_failed'
  | 'network_error'
  | 'provider_error';

export interface LandmarkEstimate {
  description: string;
  score?: number;
  locations: Array<{ latitude: number; longitude: number }>;
}

export interface LandmarkFrameResult {
  timestampSec?: number;
  formattedTimestamp?: string;
  sha256: string;
  status: VisionStatus;
  landmarks: LandmarkEstimate[];
  message?: string;
}

export interface OriginAnalysisResult {
  evidenceId?: string;
  sha256: string;
  analyzedAt: string;
  mediaType: 'image' | 'video';
  exifToolStatus: 'available' | 'not_installed' | 'error';
  exifToolVersion?: string;
  metadataSource: 'exiftool' | 'exifreader_fallback' | 'unavailable';
  metadata: Record<string, unknown> | null;
  ffprobeStatus: 'not_applicable' | 'available' | 'not_installed' | 'error';
  ffprobeVersion?: string;
  videoMetadata?: Record<string, unknown>;
  ffmpegStatus: 'not_applicable' | 'available' | 'not_installed' | 'error';
  ffmpegVersion?: string;
  frames: LandmarkFrameResult[];
  visionStatus: VisionStatus;
  visionModel?: string;
  externalProcessingConsent?: boolean;
  limitations: string[];
}

interface CommandResult {
  status: 'available' | 'not_installed' | 'error';
  output?: string;
}

const MAX_VIDEO_DURATION_SECONDS = 600;
const MAX_VISION_IMAGE_BYTES = 7 * 1024 * 1024;

export function validateOriginMedia(
  bytes: Buffer,
  mediaType: string,
  mimeType: string,
  fileName: string
): 'image' | 'video' | null {
  if (!bytes.length) return null;
  const extension = path.extname(fileName).toLowerCase();
  const supportedExtensions: Record<string, string[]> = {
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/webp': ['.webp'],
    'image/tiff': ['.tif', '.tiff'],
    'image/bmp': ['.bmp'],
    'video/mp4': ['.mp4', '.m4v'],
    'video/quicktime': ['.mov'],
    'video/webm': ['.webm'],
  };
  if (!supportedExtensions[mimeType]?.includes(extension)) return null;

  const imageSignatures: Array<{ mime: string; matches: () => boolean }> = [
    { mime: 'image/jpeg', matches: () => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    { mime: 'image/png', matches: () => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
    { mime: 'image/webp', matches: () => bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' },
    { mime: 'image/tiff', matches: () => bytes.length >= 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a)) },
    { mime: 'image/bmp', matches: () => bytes.length >= 14 && bytes.toString('ascii', 0, 2) === 'BM' },
  ];
  const videoSignatures: Array<{ mime: string; matches: () => boolean }> = [
    { mime: 'video/mp4', matches: () => bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' },
    { mime: 'video/quicktime', matches: () => bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' },
    { mime: 'video/webm', matches: () => bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  ];

  if (mediaType === 'image') {
    return imageSignatures.some((entry) => entry.mime === mimeType && entry.matches()) ? 'image' : null;
  }
  if (mediaType === 'video') {
    return videoSignatures.some((entry) => entry.mime === mimeType && entry.matches()) ? 'video' : null;
  }
  return null;
}

function runCommand(executable: string, args: string[], timeout: number, maxBuffer: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(executable, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        const commandError = error as NodeJS.ErrnoException;
        resolve({ status: commandError.code === 'ENOENT' ? 'not_installed' : 'error' });
        return;
      }
      resolve({ status: 'available', output: stdout });
    });
  });
}

function runBinary(
  executable: string,
  args: string[],
  timeout: number,
  maxBuffer: number
): Promise<{ status: CommandResult['status']; output?: Buffer }> {
  return new Promise((resolve) => {
    execFile(executable, args, {
      encoding: 'buffer',
      timeout,
      maxBuffer,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        const commandError = error as NodeJS.ErrnoException;
        resolve({ status: commandError.code === 'ENOENT' ? 'not_installed' : 'error' });
        return;
      }
      resolve({ status: 'available', output: stdout });
    });
  });
}

function sanitizeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/serial(?:number)?/i.test(key))
        .map(([key, entry]) => [key, sanitizeMetadata(entry)])
    );
  }
  return value;
}

function metadataTagValue(tag: unknown): unknown {
  if (!tag || typeof tag !== 'object') return undefined;
  const entry = tag as { description?: unknown; value?: unknown };
  const value = entry.description ?? entry.value;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((item) =>
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
    ))
  ) return value;
  return undefined;
}

export function normalizeExifReaderMetadata(tags: unknown): Record<string, unknown> | null {
  if (!tags || typeof tags !== 'object') return null;
  const expandedTags = tags as ExifReader.ExpandedTags;
  const metadata: Record<string, unknown> = {};
  for (const [group, groupTags] of Object.entries(expandedTags)) {
    if (!groupTags || typeof groupTags !== 'object' || group === 'metadataRange' || group === 'gps') continue;
    for (const [tagName, tag] of Object.entries(groupTags)) {
      if (/serial/i.test(tagName) || tagName.startsWith('_')) continue;
      const value = metadataTagValue(tag);
      if (value !== undefined) {
        metadata[`[ExifReader][${group.toUpperCase()}]${tagName}`] = value;
      }
    }
  }

  for (const [tagName, value] of Object.entries(expandedTags.gps || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const exifTagName = tagName === 'Latitude' ? 'GPSLatitude'
        : tagName === 'Longitude' ? 'GPSLongitude'
          : tagName === 'Altitude' ? 'GPSAltitude'
            : tagName;
      metadata[`[GPS]${exifTagName}`] = value;
    }
  }

  return Object.keys(metadata).length ? sanitizeMetadata(metadata) as Record<string, unknown> : null;
}

export function extractExifReaderMetadata(bytes: Buffer): Record<string, unknown> | null {
  return normalizeExifReaderMetadata(ExifReader.load(bytes, { expanded: true }));
}

function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}

export async function detectLandmarks(bytes: Buffer, apiKey: string): Promise<{
  status: VisionStatus;
  landmarks: LandmarkEstimate[];
  message?: string;
}> {
  if (bytes.length > MAX_VISION_IMAGE_BYTES) {
    return {
      status: 'provider_error',
      landmarks: [],
      message: 'The image exceeds the safe 7 MiB inline Vision request limit.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(
      'https://vision.googleapis.com/v1/images:annotate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          requests: [{
            image: { content: bytes.toString('base64') },
            features: [{ type: 'LANDMARK_DETECTION', maxResults: 10 }],
          }],
        }),
      }
    );

    if (response.status === 401 || response.status === 403) {
      return { status: 'authentication_failed', landmarks: [], message: 'Google Cloud Vision rejected the configured credentials or API permissions.' };
    }
    if (response.status === 429) {
      return { status: 'quota_exceeded', landmarks: [], message: 'Google Cloud Vision quota or rate limit was reached.' };
    }
    if (!response.ok) {
      return { status: 'provider_error', landmarks: [], message: `Google Cloud Vision returned HTTP ${response.status}.` };
    }

    const payload = await response.json() as {
      responses?: Array<{
        error?: { message?: string };
        landmarkAnnotations?: Array<{
          description?: string;
          score?: number;
          locations?: Array<{ latLng?: { latitude?: number; longitude?: number } }>;
        }>;
      }>;
    };
    const providerError = payload.responses?.[0]?.error;
    if (providerError) {
      return {
        status: 'provider_error',
        landmarks: [],
        message: providerError.message || 'Google Cloud Vision could not analyze this media.',
      };
    }
    const landmarks = (payload.responses?.[0]?.landmarkAnnotations || [])
      .filter((item): item is typeof item & { description: string } => Boolean(item.description))
      .map((item) => ({
        description: item.description,
        ...(typeof item.score === 'number' && Number.isFinite(item.score) ? { score: item.score } : {}),
        locations: (item.locations || [])
          .map((location) => location.latLng)
          .filter((location): location is { latitude: number; longitude: number } =>
            typeof location?.latitude === 'number' &&
            Number.isFinite(location.latitude) &&
            typeof location.longitude === 'number' &&
            Number.isFinite(location.longitude)
          )
          .map((location) => ({ latitude: location.latitude, longitude: location.longitude })),
      }));
    return {
      status: landmarks.length ? 'completed' : 'no_match',
      landmarks,
      ...(landmarks.length ? {} : { message: 'Location could not be determined from available visual evidence.' }),
    };
  } catch (error) {
    return {
      status: 'network_error',
      landmarks: [],
      message: error instanceof Error && error.name === 'AbortError'
        ? 'Google Cloud Vision request timed out.'
        : 'Could not reach Google Cloud Vision.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeOriginMedia(
  bytes: Buffer,
  mediaType: 'image' | 'video',
  expectedSha256: string,
  frameSampleCount: number,
  visionApiKey: string | undefined,
  mimeType: string
): Promise<OriginAnalysisResult> {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256.toLowerCase()) {
    throw new Error('The uploaded bytes do not match the SHA-256 recorded for this evidence.');
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vexalens-origin-'));
  const extensionByMimeType: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/tiff': '.tiff',
    'image/bmp': '.bmp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  };
  const extension = extensionByMimeType[mimeType];
  if (!extension) {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    throw new Error('The recorded evidence MIME type is not supported for metadata extraction.');
  }
  const inputPath = path.join(tempDirectory, `evidence${extension}`);
  fs.writeFileSync(inputPath, bytes, { flag: 'wx', mode: 0o600 });
  const limitations: string[] = [
    'Metadata and visual landmark output can be incomplete or altered and do not establish device identity or physical location.',
    'Landmark detections and any returned coordinates are estimates that require independent investigator verification.',
  ];

  try {
    const exifTool = process.env.EXIFTOOL_PATH || 'exiftool';
    const exifVersion = await runCommand(exifTool, ['-ver'], 5000, 1024 * 1024);
    const exifJson = exifVersion.status === 'available'
      ? await runCommand(exifTool, ['-json', '-n', '-a', '-G1', '-s', '--', inputPath], 10000, 8 * 1024 * 1024)
      : exifVersion;
    let metadata: Record<string, unknown> | null = null;
    let metadataSource: OriginAnalysisResult['metadataSource'] = 'unavailable';
    let exifToolStatus: OriginAnalysisResult['exifToolStatus'] = exifJson.status;
    if (exifJson.status === 'available' && exifJson.output) {
      try {
        const parsed = JSON.parse(exifJson.output) as unknown[];
        const first = parsed[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) {
          metadata = sanitizeMetadata(first) as Record<string, unknown>;
          metadataSource = 'exiftool';
        }
      } catch {
        exifToolStatus = 'error';
        limitations.push('ExifTool returned metadata that could not be parsed.');
      }
    } else if (exifJson.status === 'not_installed') {
      limitations.push('ExifTool is not installed or not available on the server PATH.');
    } else {
      limitations.push('ExifTool could not extract metadata from this file.');
    }
    if (!metadata && mediaType === 'image') {
      try {
        metadata = extractExifReaderMetadata(bytes);
        if (metadata) {
          metadataSource = 'exifreader_fallback';
          limitations.push('Server ExifTool did not provide metadata; installed ExifReader was used as a local fallback.');
        } else {
          limitations.push('ExifReader found no supported embedded metadata in this image.');
        }
      } catch (error) {
        limitations.push(
          `ExifReader fallback could not parse this image: ${error instanceof Error ? error.message : 'unsupported image data'}.`
        );
      }
    }

    let ffprobeStatus: OriginAnalysisResult['ffprobeStatus'] = 'not_applicable';
    let ffmpegStatus: OriginAnalysisResult['ffmpegStatus'] = 'not_applicable';
    let ffprobeVersion: string | undefined;
    let ffmpegVersion: string | undefined;
    let videoMetadata: Record<string, unknown> | undefined;
    let frameBuffers: Array<{ timestampSec?: number; bytes: Buffer }> = [{ bytes }];

    if (mediaType === 'image' && visionApiKey) {
      const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
      const ffmpegVersionResult = await runCommand(ffmpeg, ['-version'], 5000, 1024 * 1024);
      ffmpegStatus = ffmpegVersionResult.status;
      ffmpegVersion = ffmpegVersionResult.output?.split(/\r?\n/, 1)[0];
      if (ffmpegStatus === 'available') {
        const derivative = await runBinary(ffmpeg, [
          '-nostdin',
          '-v', 'error',
          '-i', inputPath,
          '-map_metadata', '-1',
          '-frames:v', '1',
          '-vf', 'scale=1600:1600:force_original_aspect_ratio=decrease',
          '-q:v', '3',
          '-f', 'image2pipe',
          '-vcodec', 'mjpeg',
          'pipe:1',
        ], 15000, MAX_VISION_IMAGE_BYTES + 1);
        if (derivative.status === 'available' && derivative.output?.length && derivative.output.length <= MAX_VISION_IMAGE_BYTES) {
          frameBuffers = [{ bytes: derivative.output }];
          limitations.push('Google Cloud Vision received only a scaled, metadata-stripped JPEG derivative; the preserved original was not modified or sent to the provider.');
        } else {
          frameBuffers = [];
          ffmpegStatus = derivative.status;
          limitations.push('FFmpeg could not create an appropriately sized, metadata-stripped still-image derivative; visual landmark analysis was not submitted.');
        }
      } else {
        frameBuffers = [];
        limitations.push(ffmpegStatus === 'not_installed'
          ? 'FFmpeg is not installed to create a metadata-stripped image derivative; visual landmark analysis was not submitted.'
          : 'FFmpeg could not create a metadata-stripped image derivative; visual landmark analysis was not submitted.');
      }
    }

    if (mediaType === 'video') {
      const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
      const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
      const probeVersion = await runCommand(ffprobe, ['-version'], 5000, 1024 * 1024);
      ffprobeStatus = probeVersion.status;
      ffprobeVersion = probeVersion.output?.split(/\r?\n/, 1)[0];
      const ffmpegVersionResult = await runCommand(ffmpeg, ['-version'], 5000, 1024 * 1024);
      ffmpegStatus = ffmpegVersionResult.status;
      ffmpegVersion = ffmpegVersionResult.output?.split(/\r?\n/, 1)[0];
      if (ffprobeStatus !== 'available') {
        limitations.push(ffprobeStatus === 'not_installed' ? 'ffprobe is not installed or not available on the server PATH.' : 'ffprobe could not inspect this video.');
      } else {
        const probeResult = await runCommand(ffprobe, [
          '-v', 'error',
          '-show_format',
          '-show_streams',
          '-of', 'json',
          inputPath,
        ], 10000, 8 * 1024 * 1024);
        if (probeResult.status === 'available' && probeResult.output) {
          try {
            videoMetadata = JSON.parse(probeResult.output) as Record<string, unknown>;
            const format = videoMetadata.format as { duration?: string } | undefined;
            const duration = Number.parseFloat(format?.duration || '');
            if (Number.isFinite(duration) && duration > 0 && duration <= MAX_VIDEO_DURATION_SECONDS && ffmpegStatus === 'available') {
              const ffmpegFrames: Array<{ timestampSec: number; bytes: Buffer }> = [];
              const sampleCount = Math.max(1, Math.min(8, Math.floor(frameSampleCount)));
              limitations.push('Video landmark detection uses resized JPEG frame derivatives sampled from the preserved original video.');
              for (let index = 1; index <= sampleCount; index += 1) {
                const timestampSec = (duration * index) / (sampleCount + 1);
                try {
                  const frame = await runBinary(ffmpeg, [
                    '-nostdin',
                    '-v', 'error',
                    '-ss', timestampSec.toFixed(3),
                    '-i', inputPath,
                    '-map_metadata', '-1',
                    '-frames:v', '1',
                    '-vf', 'scale=1600:1600:force_original_aspect_ratio=decrease',
                    '-f', 'image2pipe',
                    '-vcodec', 'mjpeg',
                    'pipe:1',
                  ], 15000, MAX_VISION_IMAGE_BYTES + 1);
                  if (frame.status === 'available' && frame.output?.length && frame.output.length <= MAX_VISION_IMAGE_BYTES) {
                    ffmpegFrames.push({ timestampSec, bytes: frame.output });
                  } else {
                    limitations.push(`Video frame at ${formatTimestamp(timestampSec)} was empty or exceeded the 7 MiB safe landmark-analysis limit.`);
                  }
                } catch {
                  limitations.push(`FFmpeg could not extract a frame at ${formatTimestamp(timestampSec)}.`);
                }
              }
              frameBuffers = ffmpegFrames;
            } else if (Number.isFinite(duration) && duration > MAX_VIDEO_DURATION_SECONDS) {
              limitations.push(`Video duration exceeds the ${MAX_VIDEO_DURATION_SECONDS}-second sampling limit.`);
              ffmpegStatus = 'error';
              frameBuffers = [];
            } else if (ffmpegStatus !== 'available') {
              limitations.push(ffmpegStatus === 'not_installed' ? 'FFmpeg is not installed or not available on the server PATH; video landmark frames were not extracted.' : 'FFmpeg could not extract video frames.');
              frameBuffers = [];
            } else {
              limitations.push('Video duration was unavailable or invalid; no landmark frames were sampled.');
              frameBuffers = [];
            }
          } catch {
            ffprobeStatus = 'error';
            limitations.push('ffprobe returned stream data that could not be parsed.');
            frameBuffers = [];
          }
        } else {
          ffprobeStatus = probeResult.status;
          limitations.push('ffprobe could not read the video container or streams.');
          frameBuffers = [];
        }
      }
    }

    const frames: LandmarkFrameResult[] = [];
    for (const frame of frameBuffers) {
      const frameSha256 = crypto.createHash('sha256').update(frame.bytes).digest('hex');
      if (!visionApiKey) {
        frames.push({
          ...(frame.timestampSec === undefined ? {} : {
            timestampSec: frame.timestampSec,
            formattedTimestamp: formatTimestamp(frame.timestampSec),
          }),
          sha256: frameSha256,
          status: 'not_configured',
          landmarks: [],
          message: 'Google Cloud Vision is not configured on the server.',
        });
        continue;
      }
      const result = await detectLandmarks(frame.bytes, visionApiKey);
      frames.push({
        ...(frame.timestampSec === undefined ? {} : {
          timestampSec: frame.timestampSec,
          formattedTimestamp: formatTimestamp(frame.timestampSec),
        }),
        sha256: frameSha256,
        ...result,
      });
    }

    const visionStatuses = frames.map((frame) => frame.status);
    const visionStatus: VisionStatus = !visionApiKey
      ? 'not_configured'
      : !visionStatuses.length
        ? 'provider_error'
        : visionStatuses.includes('completed')
        ? 'completed'
        : visionStatuses.includes('quota_exceeded')
          ? 'quota_exceeded'
          : visionStatuses.includes('authentication_failed')
            ? 'authentication_failed'
            : visionStatuses.includes('network_error')
              ? 'network_error'
              : visionStatuses.includes('provider_error')
                ? 'provider_error'
                : 'no_match';

    return {
      sha256,
      analyzedAt: new Date().toISOString(),
      mediaType,
      exifToolStatus,
      ...(exifVersion.output ? { exifToolVersion: exifVersion.output.trim() } : {}),
      metadataSource,
      metadata,
      ffprobeStatus,
      ...(ffprobeVersion ? { ffprobeVersion } : {}),
      ...(videoMetadata ? { videoMetadata: sanitizeMetadata(videoMetadata) as Record<string, unknown> } : {}),
      ffmpegStatus,
      ...(ffmpegVersion ? { ffmpegVersion } : {}),
      frames,
      visionStatus,
      ...(visionApiKey ? { visionModel: 'Google Cloud Vision API v1 / LANDMARK_DETECTION' } : {}),
      limitations,
    };
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}
