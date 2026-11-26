import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(ROOT, 'models', 'model_registry.json');
const STATUS_PATH = path.join(ROOT, 'models', 'metadata', 'model_status.local.json');
const PYTHON_PROBE = [
  'import importlib.metadata as m, json, platform, shutil, sys',
  'def version(name):',
  '    try: return m.version(name)',
  '    except m.PackageNotFoundError: return None',
  'try:',
  '    import torch',
  '    torch_version = torch.__version__',
  '    cuda_available = bool(torch.cuda.is_available())',
  '    cuda_version = torch.version.cuda',
  'except Exception as error:',
  '    torch_version = None',
  '    cuda_available = False',
  '    cuda_version = None',
  '    torch_error = str(error)',
  'else: torch_error = None',
  'try:',
  '    import cv2',
  '    opencv_version = cv2.__version__',
  'except Exception as error:',
  '    opencv_version = None',
  '    opencv_error = str(error)',
  'else: opencv_error = None',
  'try:',
  '    import onnxruntime',
  '    onnxruntime_version = onnxruntime.__version__',
  'except Exception as error:',
  '    onnxruntime_version = None',
  '    onnxruntime_error = str(error)',
  'else: onnxruntime_error = None',
  'print(json.dumps({',
  '  "pythonVersion": platform.python_version(), "pythonExecutable": sys.executable,',
  '  "torchVersion": torch_version, "torchCudaAvailable": cuda_available, "torchCudaVersion": cuda_version,',
  '  "torchError": torch_error, "opencvVersion": opencv_version, "opencvError": opencv_error,',
  '  "onnxRuntimeVersion": onnxruntime_version, "onnxRuntimeError": onnxruntime_error,',
  '  "ffmpegPath": shutil.which("ffmpeg"),',
  '  "ffprobePath": shutil.which("ffprobe"), "platform": platform.platform()',
  '}))',
].join('\n');

export interface ModelFileDefinition {
  name: string;
  checkpointUrl: string;
  localPath: string;
  modelVersion: string;
  expectedSizeBytes: number | null;
  expectedSha256: string | null;
  sha256Published: boolean;
}

export interface ModelDefinition {
  id: string;
  name: string;
  repositoryUrl: string;
  releaseUrl?: string;
  modelHostingUrl?: string;
  modelVersion: string;
  licenseId: string;
  licenseName: string;
  licenseUrl: string;
  licenseGate: string;
  supportedDetectionCategory: string;
  compatibility: Record<string, unknown>;
  installationStatus: string;
  inferenceStatus: string;
  reinstallAllowed: boolean;
  files: ModelFileDefinition[];
  sizeNotes?: string;
}

interface ModelRegistryFile {
  schemaVersion: number;
  deploymentContext: string;
  restrictedModelPolicy: string;
  initialDownloadPolicy: string;
  models: ModelDefinition[];
}

export interface VerifiedModelFile extends ModelFileDefinition {
  present: boolean;
  actualSizeBytes: number | null;
  actualModifiedAtMs: number | null;
  actualSha256: string | null;
  integrityStatus: 'missing' | 'verified' | 'mismatch' | 'local_hash_only' | 'not_checked';
}

export type InstallationStatus =
  | 'blocked_by_license'
  | 'not_installed'
  | 'partial_install'
  | 'installed_verified'
  | 'installed_unverified'
  | 'integrity_error';

export interface ModelStatus {
  id: string;
  name: string;
  repositoryUrl: string;
  releaseUrl?: string;
  modelHostingUrl?: string;
  modelVersion: string;
  installedVersion: string | null;
  licenseId: string;
  licenseName: string;
  licenseUrl: string;
  licenseGate: string;
  supportedDetectionCategory: string;
  compatibility: Record<string, unknown>;
  installationStatus: InstallationStatus;
  inferenceStatus: string;
  inferenceDetails: Record<string, unknown> | null;
  lastVerificationAt: string | null;
  lastInferenceAt: string | null;
  files: VerifiedModelFile[];
  sizeNotes?: string;
  reinstallAllowed: boolean;
}

export interface RuntimeCompatibility {
  pythonVersion: string | null;
  pythonExecutable: string | null;
  pythonProbeError: string | null;
  torchVersion: string | null;
  torchCudaAvailable: boolean;
  torchCudaVersion: string | null;
  torchError: string | null;
  opencvVersion: string | null;
  opencvError: string | null;
  onnxRuntimeVersion: string | null;
  onnxRuntimeError: string | null;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  platform: string | null;
  nvidiaSmiAvailable: boolean;
  nvidiaSmiOutput: string | null;
  nvidiaSmiError: string | null;
  cpuModel: string | null;
}

interface StoredModelStatus {
  lastVerificationAt?: string;
  files?: Record<string, { sizeBytes: number; modifiedAtMs: number; sha256: string }>;
  inferenceStatus?: 'passed' | 'failed';
  inferenceDetails?: Record<string, unknown>;
  lastInferenceAt?: string;
}

interface StoredStatusFile {
  models: Record<string, StoredModelStatus>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModelFileDefinition(value: unknown): value is ModelFileDefinition {
  return isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.checkpointUrl === 'string' &&
    typeof value.localPath === 'string' &&
    typeof value.modelVersion === 'string' &&
    (typeof value.expectedSizeBytes === 'number' || value.expectedSizeBytes === null) &&
    (typeof value.expectedSha256 === 'string' || value.expectedSha256 === null) &&
    typeof value.sha256Published === 'boolean';
}

function isModelDefinition(value: unknown): value is ModelDefinition {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.repositoryUrl === 'string' &&
    typeof value.modelVersion === 'string' &&
    typeof value.licenseId === 'string' &&
    typeof value.licenseName === 'string' &&
    typeof value.licenseUrl === 'string' &&
    typeof value.licenseGate === 'string' &&
    typeof value.supportedDetectionCategory === 'string' &&
    isRecord(value.compatibility) &&
    typeof value.installationStatus === 'string' &&
    typeof value.inferenceStatus === 'string' &&
    typeof value.reinstallAllowed === 'boolean' &&
    Array.isArray(value.files) &&
    value.files.every(isModelFileDefinition);
}

function isModelRegistryFile(value: unknown): value is ModelRegistryFile {
  return isRecord(value) &&
    typeof value.schemaVersion === 'number' &&
    typeof value.deploymentContext === 'string' &&
    typeof value.restrictedModelPolicy === 'string' &&
    typeof value.initialDownloadPolicy === 'string' &&
    Array.isArray(value.models) &&
    value.models.every(isModelDefinition);
}

function isStoredStatusFile(value: unknown): value is StoredStatusFile {
  return isRecord(value) && isRecord(value.models);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function loadRegistry(): Promise<ModelRegistryFile> {
  const contents = await readFile(REGISTRY_PATH, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`The model registry JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isModelRegistryFile(parsed)) throw new Error('The model registry does not match the supported schema.');
  return parsed;
}

async function readStoredStatus(): Promise<StoredStatusFile> {
  let contents: string;
  try {
    contents = await readFile(STATUS_PATH, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { models: {} };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`The local model status file is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isStoredStatusFile(parsed)) throw new Error('The local model status file does not match the supported schema.');
  return parsed;
}

async function writeStoredStatus(value: StoredStatusFile): Promise<void> {
  await mkdir(path.dirname(STATUS_PATH), { recursive: true });
  const temporaryPath = `${STATUS_PATH}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporaryPath, STATUS_PATH);
}

let statusUpdateQueue: Promise<void> = Promise.resolve();

async function updateStoredStatus(update: (current: StoredStatusFile) => StoredStatusFile): Promise<void> {
  const operation = statusUpdateQueue.then(async () => {
    const current = await readStoredStatus();
    await writeStoredStatus(update(current));
  });
  statusUpdateQueue = operation.then(() => undefined, () => undefined);
  await operation;
}

function resolveModelFile(localPath: string): string {
  if (path.isAbsolute(localPath)) throw new Error('Model registry paths must be relative to the project root.');
  const resolvedPath = path.resolve(ROOT, localPath);
  if (!resolvedPath.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error('A model registry path resolves outside the project root.');
  }
  return resolvedPath;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectModelFile(
  definition: ModelFileDefinition,
  storedHash?: { sizeBytes: number; modifiedAtMs: number; sha256: string },
  forceHash = false,
): Promise<VerifiedModelFile> {
  const filePath = resolveModelFile(definition.localPath);
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        ...definition,
        present: false,
        actualSizeBytes: null,
        actualModifiedAtMs: null,
        actualSha256: null,
        integrityStatus: 'missing',
      };
    }
    throw error;
  }
  if (!fileInfo.isFile()) throw new Error(`Expected a model file at ${definition.localPath}.`);

  const actualSha256 = forceHash
    ? await sha256File(filePath)
    : storedHash?.sizeBytes === fileInfo.size && storedHash.modifiedAtMs === fileInfo.mtimeMs
      ? storedHash.sha256
      : definition.expectedSha256 &&
          definition.expectedSizeBytes === fileInfo.size &&
          fileInfo.size <= 32 * 1024 * 1024
        ? await sha256File(filePath)
        : null;
  const sizeMatches = definition.expectedSizeBytes === null || definition.expectedSizeBytes === fileInfo.size;
  const digestMatches = definition.expectedSha256 === null ||
    (actualSha256 !== null && actualSha256.toLowerCase() === definition.expectedSha256.toLowerCase());
  const integrityStatus: VerifiedModelFile['integrityStatus'] = !sizeMatches || !digestMatches
    ? 'mismatch'
    : actualSha256
      ? definition.expectedSha256 || definition.sha256Published
        ? 'verified'
        : 'local_hash_only'
      : 'not_checked';

  return {
    ...definition,
    present: true,
    actualSizeBytes: fileInfo.size,
    actualModifiedAtMs: fileInfo.mtimeMs,
    actualSha256,
    integrityStatus,
  };
}

export function getInstallationStatus(
  model: Pick<ModelDefinition, 'licenseGate'>,
  files: readonly Pick<VerifiedModelFile, 'present' | 'integrityStatus'>[],
): InstallationStatus {
  const presentCount = files.filter((file) => file.present).length;
  if (presentCount === 0) {
    return model.licenseGate === 'clear' ? 'not_installed' : 'blocked_by_license';
  }
  if (files.some((file) => file.integrityStatus === 'mismatch')) return 'integrity_error';
  if (presentCount < files.length) return 'partial_install';
  if (files.every((file) => file.integrityStatus === 'verified')) return 'installed_verified';
  return 'installed_unverified';
}

let runtimeCache: { expiresAt: number; value: RuntimeCompatibility } | undefined;
let runtimeProbe: Promise<RuntimeCompatibility> | undefined;

async function probeRuntimeCompatibility(): Promise<RuntimeCompatibility> {
  const pythonExecutable = process.env.VEXALENS_PYTHON || 'python';
  let pythonResult: Partial<RuntimeCompatibility> = {};
  let pythonProbeError: string | null = null;
  try {
    const { stdout } = await execFileAsync(pythonExecutable, ['-c', PYTHON_PROBE], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    pythonResult = JSON.parse(stdout) as Partial<RuntimeCompatibility>;
  } catch (error) {
    pythonProbeError = error instanceof Error ? error.message : String(error);
  }

  let nvidiaSmiOutput: string | null = null;
  let nvidiaSmiError: string | null = null;
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    nvidiaSmiOutput = stdout.trim();
  } catch (error) {
    nvidiaSmiError = error instanceof Error ? error.message : String(error);
  }

  return {
    pythonVersion: pythonResult.pythonVersion ?? null,
    pythonExecutable: pythonResult.pythonExecutable ?? null,
    pythonProbeError,
    torchVersion: pythonResult.torchVersion ?? null,
    torchCudaAvailable: pythonResult.torchCudaAvailable === true,
    torchCudaVersion: pythonResult.torchCudaVersion ?? null,
    torchError: pythonResult.torchError ?? null,
    opencvVersion: pythonResult.opencvVersion ?? null,
    opencvError: pythonResult.opencvError ?? null,
    onnxRuntimeVersion: pythonResult.onnxRuntimeVersion ?? null,
    onnxRuntimeError: pythonResult.onnxRuntimeError ?? null,
    ffmpegPath: pythonResult.ffmpegPath ?? null,
    ffprobePath: pythonResult.ffprobePath ?? null,
    platform: pythonResult.platform ?? null,
    nvidiaSmiAvailable: nvidiaSmiOutput !== null,
    nvidiaSmiOutput,
    nvidiaSmiError,
    cpuModel: osCpuModel(),
  };
}

async function getRuntimeCompatibility(): Promise<RuntimeCompatibility> {
  if (runtimeCache && runtimeCache.expiresAt > Date.now()) return runtimeCache.value;
  if (!runtimeProbe) runtimeProbe = probeRuntimeCompatibility();
  try {
    const value = await runtimeProbe;
    runtimeCache = { value, expiresAt: Date.now() + 30_000 };
    return value;
  } finally {
    runtimeProbe = undefined;
  }
}

function osCpuModel(): string | null {
  return os.cpus()[0]?.model || process.env.PROCESSOR_IDENTIFIER?.trim() || null;
}

export async function getModelManagementOverview(): Promise<{
  deploymentContext: string;
  restrictedModelPolicy: string;
  initialDownloadPolicy: string;
  checkedAt: string;
  runtime: RuntimeCompatibility;
  models: ModelStatus[];
}> {
  const [registry, storedStatus, runtime] = await Promise.all([
    loadRegistry(),
    readStoredStatus(),
    getRuntimeCompatibility(),
  ]);
  const models = await Promise.all(registry.models.map(async (model): Promise<ModelStatus> => {
    const stored = isRecord(storedStatus.models[model.id])
      ? storedStatus.models[model.id] as StoredModelStatus
      : {};
    const files = await Promise.all(model.files.map((file) => inspectModelFile(
      file,
      stored.files?.[file.localPath],
    )));
    return {
      id: model.id,
      name: model.name,
      repositoryUrl: model.repositoryUrl,
      releaseUrl: model.releaseUrl,
      modelHostingUrl: model.modelHostingUrl,
      modelVersion: model.modelVersion,
      installedVersion: files.every((file) => file.present) &&
        files.every((file) => file.expectedSha256 !== null && file.integrityStatus === 'verified')
        ? model.modelVersion
        : null,
      licenseId: model.licenseId,
      licenseName: model.licenseName,
      licenseUrl: model.licenseUrl,
      licenseGate: model.licenseGate,
      supportedDetectionCategory: model.supportedDetectionCategory,
      compatibility: model.compatibility,
      installationStatus: getInstallationStatus(model, files),
      inferenceStatus: stored.inferenceStatus ?? model.inferenceStatus,
      inferenceDetails: stored.inferenceDetails ?? null,
      lastVerificationAt: stored.lastVerificationAt ?? null,
      lastInferenceAt: stored.lastInferenceAt ?? null,
      files,
      sizeNotes: model.sizeNotes,
      reinstallAllowed: model.reinstallAllowed && model.licenseGate === 'clear',
    };
  }));
  return {
    deploymentContext: registry.deploymentContext,
    restrictedModelPolicy: registry.restrictedModelPolicy,
    initialDownloadPolicy: registry.initialDownloadPolicy,
    checkedAt: new Date().toISOString(),
    runtime,
    models,
  };
}

export async function verifyModelFiles(modelId: string): Promise<ModelStatus> {
  const registry = await loadRegistry();
  const model = registry.models.find((item) => item.id === modelId);
  if (!model) throw new Error('Unknown model ID.');
  const files = await Promise.all(model.files.map((file) => inspectModelFile(
    file,
    undefined,
    true,
  )));
  const now = new Date().toISOString();
  const verifiedHashes = Object.fromEntries(files.flatMap((file) =>
    file.present &&
    file.actualSha256 !== null &&
    file.actualSizeBytes !== null &&
    file.actualModifiedAtMs !== null
      ? [[file.localPath, {
        sizeBytes: file.actualSizeBytes,
        modifiedAtMs: file.actualModifiedAtMs,
        sha256: file.actualSha256,
      }]]
      : [],
  ));
  await updateStoredStatus((storedStatus) => {
    const existing = isRecord(storedStatus.models[modelId])
      ? storedStatus.models[modelId] as StoredModelStatus
      : {};
    return {
      ...storedStatus,
      models: {
        ...storedStatus.models,
        [modelId]: {
          ...existing,
          lastVerificationAt: now,
          files: verifiedHashes,
        },
      },
    };
  });
  const current = await getModelManagementOverview();
  const verifiedModel = current.models.find((item) => item.id === modelId);
  if (!verifiedModel) throw new Error('The model verification result could not be refreshed.');
  return verifiedModel;
}

export async function recordModelInference(
  modelId: string,
  outcome: { passed: boolean; details: Record<string, unknown> },
): Promise<ModelStatus> {
  if (modelId === 'genconvit') {
    const details = outcome.details;
    if (details.sampleFile !== 'audio-video-sync-sample.mp4') {
      throw new Error('The GenConViT inference test must use the bundled sample video.');
    }
    if (outcome.passed) {
      const scoreValues = [details.fakeScore, details.realScore];
      if (
        details.model !== 'GenConViT' ||
        typeof details.modelVersion !== 'string' ||
        (details.predictedClass !== 'REAL' && details.predictedClass !== 'FAKE') ||
        !scoreValues.every((score) => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1) ||
        typeof details.facesDetected !== 'number' ||
        !Number.isInteger(details.facesDetected) ||
        details.facesDetected < 1 ||
        typeof details.sourceSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(details.sourceSha256)
      ) {
        throw new Error('A passing GenConViT test must include a face and valid model output.');
      }
    }
  } else if (modelId !== 'mediapipe-face-landmarker') {
    throw new Error('Inference smoke testing is not configured for this model.');
  } else {
    const faceCount = outcome.details.faceCount;
    const landmarksPerFace = outcome.details.landmarksPerFace;
    if (
      outcome.details.sampleFile !== 'audio-video-sync-sample.mp4' ||
      typeof faceCount !== 'number' ||
      !Number.isInteger(faceCount) ||
      typeof landmarksPerFace !== 'number' ||
      !Number.isInteger(landmarksPerFace)
    ) {
      throw new Error('The local inference result is missing required validation fields.');
    }
    if (
      outcome.passed &&
      (faceCount < 1 || landmarksPerFace !== 478)
    ) {
      throw new Error('A passing face-landmarker test must detect a face with 478 landmarks.');
    }
  }

  const registry = await loadRegistry();
  if (!registry.models.some((item) => item.id === modelId)) throw new Error('Unknown model ID.');
  const now = new Date().toISOString();
  await updateStoredStatus((storedStatus) => {
    const existing = isRecord(storedStatus.models[modelId])
      ? storedStatus.models[modelId] as StoredModelStatus
      : {};
    return {
      ...storedStatus,
      models: {
        ...storedStatus.models,
        [modelId]: {
          ...existing,
          inferenceStatus: outcome.passed ? 'passed' : 'failed',
          inferenceDetails: outcome.details,
          lastInferenceAt: now,
        },
      },
    };
  });
  const current = await getModelManagementOverview();
  const updatedModel = current.models.find((item) => item.id === modelId);
  if (!updatedModel) throw new Error('The recorded inference result could not be refreshed.');
  return updatedModel;
}

export async function reinstallModel(modelId: string): Promise<ModelStatus> {
  const registry = await loadRegistry();
  const model = registry.models.find((item) => item.id === modelId);
  if (!model) throw new Error('Unknown model ID.');
  if (!model.reinstallAllowed || model.licenseGate !== 'clear') {
    throw new Error('Installation is blocked until the model license and deployment compatibility are cleared.');
  }
  if (modelId === 'genconvit') {
    const current = await verifyModelFiles(modelId);
    for (const file of current.files) {
      if (file.integrityStatus === 'verified') continue;
      await downloadGenConViTFile(file);
    }
    return verifyModelFiles(modelId);
  }
  if (modelId !== 'mediapipe-face-landmarker') {
    throw new Error('No approved installer is configured for this model.');
  }
  await execFileAsync(process.execPath, [path.join(ROOT, 'scripts', 'prepare-local-lipsync-models.mjs')], {
    cwd: ROOT,
    timeout: 120_000,
    windowsHide: true,
  });
  return verifyModelFiles(modelId);
}

async function downloadGenConViTFile(file: ModelFileDefinition): Promise<void> {
  const url = new URL(file.checkpointUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'huggingface.co' ||
    file.expectedSizeBytes === null ||
    file.expectedSha256 === null ||
    !file.sha256Published
  ) {
    throw new Error(`The GenConViT registry entry for ${file.name} lacks an approved pinned source or checksum.`);
  }

  const destination = resolveModelFile(file.localPath);
  await mkdir(path.dirname(destination), { recursive: true });
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const temporaryPath = `${destination}.${randomUUID()}.partial`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Download of ${file.name} failed with HTTP ${response.status}.`);
      }
      if (!response.body) throw new Error(`The official source returned no body for ${file.name}.`);
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength !== file.expectedSizeBytes) {
        throw new Error(`The official source reported an unexpected size for ${file.name}.`);
      }

      const hash = createHash('sha256');
      let receivedBytes = 0;
      const hashStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          receivedBytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const responseBody = response.body;
      async function* readResponseBody(): AsyncGenerator<Uint8Array> {
        const reader = responseBody.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          reader.releaseLock();
        }
      }
      await pipeline(
        Readable.from(readResponseBody()),
        hashStream,
        createWriteStream(temporaryPath, { flags: 'wx' }),
      );
      if (receivedBytes !== file.expectedSizeBytes) {
        throw new Error(`Downloaded ${file.name} has ${receivedBytes} bytes; expected ${file.expectedSizeBytes}.`);
      }
      const actualSha256 = hash.digest('hex');
      if (actualSha256 !== file.expectedSha256.toLowerCase()) {
        throw new Error(`SHA-256 verification failed for downloaded model file ${file.name}.`);
      }

      await rm(destination, { force: true });
      await rename(temporaryPath, destination);
      return;
    } catch (error) {
      lastError = error;
      await rm(temporaryPath, { force: true });
      if (attempt < 3) continue;
    }
  }
  throw new Error(
    `Could not install ${file.name} after three attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
