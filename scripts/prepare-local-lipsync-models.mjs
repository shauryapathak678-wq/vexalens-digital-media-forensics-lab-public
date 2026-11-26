import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const modelRoot = path.join(root, 'public', 'models', 'lipsync');
const faceModelPath = path.join(modelRoot, 'face_landmarker.task');
const faceModelUrl = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const faceModelSize = 3_758_596;
const faceModelSha256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

async function ensureFaceModel() {
  let existingModel;
  try {
    existingModel = await readFile(faceModelPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (
    existingModel?.byteLength === faceModelSize &&
    createHash('sha256').update(existingModel).digest('hex') === faceModelSha256
  ) return;

  console.log('[VexaLens] Downloading the MediaPipe face-landmarker model for local analysis.');
  const response = await fetch(faceModelUrl, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) {
    throw new Error(`Could not download the local face-landmarker model (HTTP ${response.status}).`);
  }

  const model = Buffer.from(await response.arrayBuffer());
  if (
    model.byteLength !== faceModelSize ||
    createHash('sha256').update(model).digest('hex') !== faceModelSha256
  ) {
    throw new Error('The downloaded face-landmarker model failed its size or SHA-256 integrity check.');
  }

  await mkdir(modelRoot, { recursive: true });
  const temporaryPath = `${faceModelPath}.tmp`;
  await writeFile(temporaryPath, model);
  await rename(temporaryPath, faceModelPath);
}

async function copyAsset(source, destination) {
  const file = await stat(source).catch((error) => {
    if (error.code === 'ENOENT') {
      throw new Error(`Required local lip-sync runtime asset is missing: ${source}`);
    }
    throw error;
  });
  if (!file.isFile()) throw new Error(`Expected a file at ${source}.`);

  const existingFile = await stat(destination).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (
    existingFile?.isFile() &&
    existingFile.size === file.size &&
    existingFile.mtimeMs === file.mtimeMs
  ) return;

  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function prepareAssets() {
  const visionPackage = path.dirname(require.resolve('@mediapipe/tasks-vision'));
  const visionWasm = path.join(visionPackage, 'wasm');
  const vadDist = path.dirname(require.resolve('@ricky0123/vad-web'));
  const ortDist = path.dirname(require.resolve('onnxruntime-web/wasm'));

  await ensureFaceModel();
  await Promise.all([
    copyAsset(
      path.join(visionWasm, 'vision_wasm_internal.js'),
      path.join(modelRoot, 'mediapipe', 'wasm', 'vision_wasm_internal.js'),
    ),
    copyAsset(
      path.join(visionWasm, 'vision_wasm_internal.wasm'),
      path.join(modelRoot, 'mediapipe', 'wasm', 'vision_wasm_internal.wasm'),
    ),
    copyAsset(
      path.join(vadDist, 'silero_vad_v5.onnx'),
      path.join(modelRoot, 'vad', 'silero_vad_v5.onnx'),
    ),
    copyAsset(
      path.join(vadDist, 'vad.worklet.bundle.min.js'),
      path.join(modelRoot, 'vad', 'vad.worklet.bundle.min.js'),
    ),
    copyAsset(
      path.join(ortDist, 'ort-wasm-simd-threaded.mjs'),
      path.join(modelRoot, 'onnxruntime', 'ort-wasm-simd-threaded.mjs'),
    ),
    copyAsset(
      path.join(ortDist, 'ort-wasm-simd-threaded.wasm'),
      path.join(modelRoot, 'onnxruntime', 'ort-wasm-simd-threaded.wasm'),
    ),
  ]);
}

prepareAssets().then(
  () => console.log('[VexaLens] Local speech and mouth-landmark models are ready.'),
  (error) => {
    console.error(`[VexaLens] Could not prepare local lip-sync models: ${error.message}`);
    process.exitCode = 1;
  },
);
