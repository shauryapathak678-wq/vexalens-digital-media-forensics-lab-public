import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });
const venvPython = path.join(
  root,
  'age-gender-estimation',
  'venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const systemPython = process.platform === 'win32' ? 'python' : 'python3';
const python = process.env.VEXALENS_PYTHON || (existsSync(venvPython) ? venvPython : systemPython);
const backendHealthUrl = 'http://127.0.0.1:8000/api/ela/health';
const requiredBackendFeatures = ['reverse_media_fingerprint', 'video_genealogy'];
const children = [];
let stopping = false;

function spawnChild(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  children.push(child);
  return child;
}

function stopChildren(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBackendHealthStatus() {
  try {
    const response = await fetch(backendHealthUrl, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return 'unavailable';
    const body = await response.json();
    if (body.status !== 'operational') return 'unavailable';
    return Array.isArray(body.features) && requiredBackendFeatures.every((feature) => body.features.includes(feature))
      ? 'current'
      : 'outdated';
  } catch {
    return 'unavailable';
  }
}

async function backendIsHealthy() {
  return (await getBackendHealthStatus()) === 'current';
}

async function waitForBackend(backend, getSpawnError) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await backendIsHealthy()) return;
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (backend.exitCode !== null) {
      throw new Error(`Local backend exited with code ${backend.exitCode}.`);
    }
    await sleep(500);
  }
  throw new Error('Timed out waiting for the local backend health check on port 8000.');
}

async function runInstaller() {
  process.env.VEXALENS_PYTHON = python;
  await new Promise((resolve, reject) => {
    const installer = spawnChild(python, [
      '-m',
      'pip',
      'install',
      '-r',
      path.join(root, 'backend', 'requirements.txt'),
    ]);
    installer.once('error', reject);
    installer.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Backend dependency installation exited with code ${code ?? 1}.`));
    });
  });
}

async function main() {
  if (process.argv.includes('--install-backend')) {
    await runInstaller();
    return;
  }

  process.env.VEXALENS_PYTHON = python;
  let ownedBackend = null;
  let backendSpawnError = null;
  const backendStatus = await getBackendHealthStatus();
  if (backendStatus === 'current') {
    console.log('[VexaLens] Reusing the healthy local backend at 127.0.0.1:8000.');
  } else if (backendStatus === 'outdated') {
    throw new Error(
      'An older VexaLens backend is still running on port 8000 and does not provide reverse-media fingerprinting. Stop that specific process, then run npm run dev again.'
    );
  } else {
    console.log(`[VexaLens] Starting local FastAPI backend with ${python}.`);
    ownedBackend = spawnChild(python, [
      '-m',
      'uvicorn',
      'backend.main:app',
      '--host',
      '127.0.0.1',
      '--port',
      '8000',
    ]);
    ownedBackend.once('error', (error) => {
      backendSpawnError = error;
      console.error(`[VexaLens] Could not start Python backend: ${error.message}`);
      stopChildren(1);
    });
    ownedBackend.once('exit', (code) => {
      if (!stopping) {
        console.error(`[VexaLens] Local backend exited unexpectedly with code ${code ?? 1}.`);
        stopChildren(code ?? 1);
      }
    });
  }

  console.log('[VexaLens] Starting the web app without waiting for backend initialization.');
  const frontend = spawnChild(process.execPath, [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'server.ts',
  ]);
  frontend.once('error', (error) => {
    console.error(`[VexaLens] Could not start the web app: ${error.message}`);
    stopChildren(1);
  });
  frontend.once('exit', (code) => {
    if (!stopping) stopChildren(code ?? 0);
  });

  process.on('SIGINT', () => stopChildren(0));
  process.on('SIGTERM', () => stopChildren(0));

  if (ownedBackend) {
    void waitForBackend(ownedBackend, () => backendSpawnError).then(
      () => console.log('[VexaLens] Local backend is ready.'),
      (error) => console.error(`[VexaLens] Local backend did not become ready: ${error.message}`),
    );
  }
}

main().catch((error) => {
  console.error(`[VexaLens] ${error instanceof Error ? error.message : String(error)}`);
  stopChildren(1);
});
