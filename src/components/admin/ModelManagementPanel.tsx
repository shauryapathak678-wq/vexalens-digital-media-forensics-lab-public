import React, { useCallback, useEffect, useState } from 'react';
import { getAuthSession } from '@/lib/supabase';
import { calculateEvidenceHashes, verifyHashesMatch } from '@/lib/forensics/crypto';
import { analyzeGenConViTVideo } from '@/lib/forensics/genConViTClient';

interface ModelFileStatus {
  name: string;
  checkpointUrl: string;
  localPath: string;
  modelVersion: string;
  expectedSizeBytes: number | null;
  expectedSha256: string | null;
  sha256Published: boolean;
  present: boolean;
  actualSizeBytes: number | null;
  actualSha256: string | null;
  integrityStatus: 'missing' | 'verified' | 'mismatch' | 'local_hash_only' | 'not_checked';
}

interface ManagedModel {
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
  installationStatus: string;
  inferenceStatus: string;
  inferenceDetails: Record<string, unknown> | null;
  lastVerificationAt: string | null;
  lastInferenceAt: string | null;
  files: ModelFileStatus[];
  sizeNotes?: string;
  reinstallAllowed: boolean;
}

interface RuntimeStatus {
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

interface ModelOverview {
  deploymentContext: string;
  restrictedModelPolicy: string;
  initialDownloadPolicy: string;
  checkedAt: string;
  runtime: RuntimeStatus;
  models: ManagedModel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManagedModel(value: unknown): value is ManagedModel {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.repositoryUrl === 'string' &&
    typeof value.modelVersion === 'string' &&
    (typeof value.installedVersion === 'string' || value.installedVersion === null) &&
    typeof value.licenseName === 'string' &&
    typeof value.licenseUrl === 'string' &&
    typeof value.installationStatus === 'string' &&
    typeof value.inferenceStatus === 'string' &&
    typeof value.reinstallAllowed === 'boolean' &&
    isRecord(value.compatibility) &&
    Array.isArray(value.files) &&
    value.files.every((file) => isRecord(file) &&
      typeof file.name === 'string' &&
      typeof file.localPath === 'string' &&
      typeof file.present === 'boolean' &&
      typeof file.integrityStatus === 'string');
}

function isModelOverview(value: unknown): value is ModelOverview {
  return isRecord(value) &&
    typeof value.deploymentContext === 'string' &&
    typeof value.restrictedModelPolicy === 'string' &&
    typeof value.initialDownloadPolicy === 'string' &&
    typeof value.checkedAt === 'string' &&
    isRecord(value.runtime) &&
    Array.isArray(value.models) &&
    value.models.every(isManagedModel);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The model-management request failed.';
}

async function adminRequest(path: string, method = 'GET', body?: unknown): Promise<ModelOverview> {
  const session = await getAuthSession();
  if (!session?.access_token) {
    throw new Error('Sign in with a Supabase administrator account to manage local models.');
  }
  const response = await fetch(`/api/admin/models${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) throw new Error(`Model-management server returned HTTP ${response.status} without a valid response.`);
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `Model-management request failed with HTTP ${response.status}.`);
  }
  if (!isModelOverview(payload.overview)) throw new Error('Model-management server returned an invalid registry response.');
  return payload.overview;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function badgeColor(status: string): string {
  if (status.includes('verified') || status === 'passed') return '#48D597';
  if (status.includes('blocked') || status.includes('error') || status === 'failed') return '#FF667A';
  if (status.includes('partial') || status.includes('unverified') || status === 'not_run') return '#F3BA60';
  return '#62E5E8';
}

function statusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: 'loadedmetadata' | 'loadeddata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener('error', onError);
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out while loading the bundled sample video (${eventName}).`));
    }, 15_000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('The bundled sample video could not be decoded by this browser.'));
    };
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

async function runFaceLandmarkerSmokeTest(): Promise<{
  passed: boolean;
  details: Record<string, unknown>;
}> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  let closeLandmarker: (() => void) | undefined;
  let details: Record<string, unknown> = {
    sampleFile: 'audio-video-sync-sample.mp4',
    faceCount: 0,
    landmarksPerFace: 0,
  };
  try {
    const metadataReady = waitForVideoEvent(video, 'loadedmetadata');
    const frameReady = waitForVideoEvent(video, 'loadeddata');
    video.src = '/demo/audio-video-sync-sample.mp4';
    await Promise.all([metadataReady, frameReady]);
    if (video.duration > 2) {
      const seekReady = waitForVideoEvent(video, 'seeked');
      video.currentTime = Math.min(1, video.duration / 2);
      await seekReady;
    }

    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(
      new URL('/models/lipsync/mediapipe/wasm/', window.location.origin).toString(),
    );
    const landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: new URL('/models/lipsync/face_landmarker.task', window.location.origin).toString(),
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      numFaces: 5,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    closeLandmarker = () => landmarker.close();
    const result = landmarker.detect(video);
    const faceCount = result.faceLandmarks.length;
    const landmarksPerFace = result.faceLandmarks[0]?.length ?? 0;
    details = {
      sampleFile: 'audio-video-sync-sample.mp4',
      faceCount,
      landmarksPerFace,
      sampleTimeSeconds: video.currentTime,
      inferenceMode: 'CPU / IMAGE',
      message: faceCount > 0
        ? 'Local Face Landmarker inference completed on the bundled sample frame.'
        : 'Model loaded, but no face was detected in the sampled video frame.',
    };
    return { passed: faceCount > 0 && landmarksPerFace === 478, details };
  } catch (error) {
    details = {
      ...details,
      message: getErrorMessage(error),
    };
    return { passed: false, details };
  } finally {
    closeLandmarker?.();
    video.removeAttribute('src');
    video.load();
  }
}

async function runGenConViTSmokeTest(): Promise<{
  passed: boolean;
  details: Record<string, unknown>;
}> {
  const sampleFile = 'audio-video-sync-sample.mp4';
  try {
    const response = await fetch('/demo/audio-video-sync-sample.mp4');
    if (!response.ok) throw new Error(`Bundled sample request failed with HTTP ${response.status}.`);
    const video = await response.blob();
    const hashes = await calculateEvidenceHashes(video);
    const result = await analyzeGenConViTVideo(video, '.mp4', hashes.sha256);
    if (!verifyHashesMatch(result.source_sha256, hashes.sha256)) {
      throw new Error('GenConViT returned a source hash that does not match the bundled sample.');
    }
    return {
      passed: result.faces_detected > 0 &&
        Number.isFinite(result.fake_score) &&
        Number.isFinite(result.real_score),
      details: {
        sampleFile,
        model: result.model,
        modelVersion: result.model_version,
        predictedClass: result.predicted_class,
        fakeScore: result.fake_score,
        realScore: result.real_score,
        facesDetected: result.faces_detected,
        framesWithFaces: result.frames_with_faces,
        sourceSha256: result.source_sha256,
        inferenceSeconds: result.inference_seconds,
        message: 'Local GenConViT inference returned finite model scores on the bundled sample. This smoke test does not measure classification accuracy.',
      },
    };
  } catch (error) {
    return {
      passed: false,
      details: {
        sampleFile,
        message: error instanceof Error ? error.message : 'GenConViT smoke test failed.',
      },
    };
  }
}

const cardStyle: React.CSSProperties = {
  background: 'var(--vl-surface)',
  border: '1px solid var(--vl-border)',
  borderRadius: 12,
  padding: 18,
  boxShadow: 'var(--vl-card-shadow)',
};

const actionStyle: React.CSSProperties = {
  border: '1px solid var(--vl-border)',
  background: 'var(--vl-surface-elevated)',
  color: 'var(--vl-text-primary)',
  borderRadius: 8,
  padding: '8px 11px',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
};

export const ModelManagementPanel: React.FC = () => {
  const [overview, setOverview] = useState<ModelOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await adminRequest(''));
      setError('');
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = async (model: ManagedModel, action: 'verify' | 'test' | 'reinstall') => {
    const actionKey = `${model.id}:${action}`;
    setBusyAction(actionKey);
    setError('');
    setNotice('');
    try {
      if (action === 'test') {
        const result = model.id === 'genconvit'
          ? await runGenConViTSmokeTest()
          : await runFaceLandmarkerSmokeTest();
        const updated = await adminRequest(`/${encodeURIComponent(model.id)}/inference-test`, 'POST', result);
        setOverview(updated);
        setNotice(result.passed
          ? `Local ${model.name} smoke test passed on the bundled sample.`
          : `Local ${model.name} smoke test failed: ${String(result.details.message || 'No valid inference output was returned.')}`);
      } else {
        const updated = await adminRequest(`/${encodeURIComponent(model.id)}/${action}`, 'POST');
        setOverview(updated);
        setNotice(action === 'verify'
          ? `Local files checked for ${model.name}.`
          : `Reinstall completed for ${model.name}.`);
      }
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    } finally {
      setBusyAction(null);
    }
  };

  const runtime = overview?.runtime;
  return (
    <section aria-label="Local model management" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ ...cardStyle, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ color: 'var(--vl-ice-cyan)', fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
            Administrator · local model registry
          </div>
          <h2 style={{ color: 'var(--vl-text-primary)', fontSize: 20, margin: '7px 0 4px' }}>Model Management</h2>
          <p style={{ color: 'var(--vl-text-secondary)', fontSize: 12, margin: 0 }}>
            GenConViT is enabled for the declared shared noncommercial deployment; model files remain local and evidence is never sent to a provider.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} style={actionStyle}>
          {loading ? 'Checking…' : 'Refresh status'}
        </button>
      </header>

      {error && <div role="alert" style={{ ...cardStyle, color: '#FF8794', borderColor: 'rgba(255,102,122,0.35)', fontSize: 12 }}>{error}</div>}
      {notice && <div role="status" style={{ ...cardStyle, color: '#48D597', borderColor: 'rgba(72,213,151,0.35)', fontSize: 12 }}>{notice}</div>}
      {loading && !overview && <div style={{ ...cardStyle, color: 'var(--vl-text-secondary)', fontSize: 12 }}>Checking the local registry and runtime…</div>}

      {overview && (
        <>
          <div style={{ ...cardStyle, borderColor: 'rgba(243,186,96,0.35)' }}>
            <div style={{ color: '#F3BA60', fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Deployment and licensing policy
            </div>
            <p style={{ color: 'var(--vl-text-secondary)', fontSize: 12, lineHeight: 1.6, margin: '7px 0' }}>
              Shared noncommercial deployment · GenConViT weights are CC BY-NC 4.0 and may not be used commercially · other restricted models remain blocked pending separate clearance.
            </p>
            <div style={{ color: 'var(--vl-text-dim)', fontSize: 10 }}>
              Status checked {formatTimestamp(overview.checkedAt)}. A locally computed hash without a publisher reference is recorded as unverified, not authentic.
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ color: 'var(--vl-text-primary)', fontSize: 12, fontWeight: 700, marginBottom: 12 }}>Current host compatibility</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
              <RuntimeItem label="Python" value={runtime?.pythonVersion || 'Unavailable'} detail={runtime?.pythonExecutable || runtime?.pythonProbeError || 'Not detected'} />
              <RuntimeItem label="PyTorch / CUDA" value={runtime?.torchVersion || runtime?.torchError || 'Not installed'} detail={runtime?.torchCudaAvailable ? `CUDA ${runtime?.torchCudaVersion || 'available'}` : 'CUDA unavailable'} />
              <RuntimeItem label="OpenCV / ONNX Runtime" value={`${runtime?.opencvVersion || 'OpenCV unavailable'} / ${runtime?.onnxRuntimeVersion || 'ONNX unavailable'}`} detail={[runtime?.opencvError, runtime?.onnxRuntimeError].filter(Boolean).join(' · ') || 'Local package probe'} />
              <RuntimeItem label="FFmpeg" value={runtime?.ffmpegPath || 'Not detected'} detail={`ffprobe: ${runtime?.ffprobePath || 'not detected'}`} />
              <RuntimeItem label="GPU / CPU" value={runtime?.nvidiaSmiAvailable ? runtime?.nvidiaSmiOutput || 'NVIDIA GPU detected' : 'No NVIDIA GPU detected'} detail={runtime?.cpuModel || runtime?.nvidiaSmiError || 'Host hardware probe'} />
              <RuntimeItem label="Platform" value={runtime?.platform || 'Unavailable'} detail={runtime?.pythonProbeError || 'Compatibility reported by local runtime'} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 14 }}>
            {overview.models.map((model) => {
              const isMediaPipe = model.id === 'mediapipe-face-landmarker';
              const isGenConViT = model.id === 'genconvit';
              const modelBusy = busyAction?.startsWith(`${model.id}:`) ?? false;
              const hasLocalFiles = model.files.some((file) => file.present);
              return (
                <article key={model.id} style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                    <div>
                      <h3 style={{ color: 'var(--vl-text-primary)', fontSize: 14, margin: 0 }}>{model.name}</h3>
                      <div style={{ color: 'var(--vl-text-dim)', fontSize: 10, marginTop: 4 }}>
                        Registry version: {model.modelVersion} · installed: {model.installedVersion || (hasLocalFiles ? 'unknown / unverified' : 'not installed')}
                      </div>
                    </div>
                    <span style={{
                      color: badgeColor(model.installationStatus),
                      border: `1px solid ${badgeColor(model.installationStatus)}55`,
                      background: `${badgeColor(model.installationStatus)}12`,
                      borderRadius: 999,
                      padding: '4px 8px',
                      fontSize: 9,
                      fontFamily: 'var(--font-mono)',
                      textTransform: 'uppercase',
                      whiteSpace: 'nowrap',
                    }}>
                      {statusLabel(model.installationStatus)}
                    </span>
                  </div>

                  <p style={{ color: 'var(--vl-text-secondary)', fontSize: 11, lineHeight: 1.5, margin: 0 }}>
                    {model.supportedDetectionCategory}
                  </p>

                  <div style={{ borderTop: '1px solid var(--vl-border)', borderBottom: '1px solid var(--vl-border)', padding: '9px 0', display: 'grid', gap: 6 }}>
                    <div style={{ color: 'var(--vl-text-secondary)', fontSize: 10 }}>
                      License: <span style={{ color: model.licenseGate === 'clear' ? '#48D597' : '#F3BA60' }}>{model.licenseName}</span>
                    </div>
                    <div style={{ color: 'var(--vl-text-secondary)', fontSize: 10 }}>
                      Inference test: <span style={{ color: badgeColor(model.inferenceStatus) }}>{statusLabel(model.inferenceStatus)}</span>
                    </div>
                    <div style={{ color: 'var(--vl-text-dim)', fontSize: 9 }}>
                      Last verification: {formatTimestamp(model.lastVerificationAt)} · last inference: {formatTimestamp(model.lastInferenceAt)}
                    </div>
                  </div>

                  {model.files.map((file) => (
                    <details key={file.localPath} style={{ color: 'var(--vl-text-secondary)', fontSize: 10 }}>
                      <summary style={{ cursor: 'pointer' }}>
                        {file.name} · {file.present ? formatBytes(file.actualSizeBytes) : 'not installed'} · {statusLabel(file.integrityStatus)}
                      </summary>
                      <div style={{ display: 'grid', gap: 5, marginTop: 7, overflowWrap: 'anywhere' }}>
                        <div>Local path: <code>{file.localPath}</code></div>
                        <div>Expected size: {formatBytes(file.expectedSizeBytes)} · SHA-256 publisher-published: {file.sha256Published ? 'yes' : 'no'}</div>
                        <a href={file.checkpointUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--vl-ice-cyan)', overflowWrap: 'anywhere' }}>
                          Official checkpoint source
                        </a>
                        {file.actualSha256 && <div>Local SHA-256: <code title={file.actualSha256}>{file.actualSha256}</code></div>}
                        {file.expectedSha256 && <div>Reference SHA-256: <code>{file.expectedSha256}</code></div>}
                      </div>
                    </details>
                  ))}

                  {model.inferenceDetails && (
                    <details style={{ color: 'var(--vl-text-secondary)', fontSize: 10 }}>
                      <summary style={{ cursor: 'pointer' }}>Last inference-test details</summary>
                      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 9 }}>{JSON.stringify(model.inferenceDetails, null, 2)}</pre>
                    </details>
                  )}

                  <details style={{ color: 'var(--vl-text-secondary)', fontSize: 10 }}>
                    <summary style={{ cursor: 'pointer' }}>Compatibility and limitations</summary>
                    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 9 }}>{JSON.stringify(model.compatibility, null, 2)}</pre>
                    {model.sizeNotes && <p style={{ color: 'var(--vl-text-dim)' }}>{model.sizeNotes}</p>}
                  </details>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 'auto' }}>
                    <a href={model.repositoryUrl} target="_blank" rel="noopener noreferrer" style={{ ...actionStyle, textDecoration: 'none' }}>
                      Source
                    </a>
                    {(model.modelHostingUrl || model.releaseUrl) && (
                      <a href={model.modelHostingUrl || model.releaseUrl} target="_blank" rel="noopener noreferrer" style={{ ...actionStyle, textDecoration: 'none' }}>
                        Weights
                      </a>
                    )}
                    <a href={model.licenseUrl} target="_blank" rel="noopener noreferrer" style={{ ...actionStyle, textDecoration: 'none' }}>
                      License
                    </a>
                    <button
                      type="button"
                      onClick={() => void runAction(model, 'verify')}
                      disabled={modelBusy}
                      style={actionStyle}
                    >
                      {busyAction === `${model.id}:verify` ? 'Hashing files…' : 'Verify'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void runAction(model, 'test')}
                      disabled={modelBusy || (!isMediaPipe && !isGenConViT) || model.installationStatus !== 'installed_verified'}
                      title={isMediaPipe || isGenConViT ? 'Run local inference on the bundled sample video.' : 'No safe local inference adapter is configured for this checkpoint.'}
                      style={{ ...actionStyle, opacity: modelBusy || (!isMediaPipe && !isGenConViT) || model.installationStatus !== 'installed_verified' ? 0.55 : 1 }}
                    >
                      {busyAction === `${model.id}:test` ? 'Running…' : 'Test inference'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void runAction(model, 'reinstall')}
                      disabled={modelBusy || !model.reinstallAllowed}
                      title={model.reinstallAllowed ? 'Reinstall this approved local model.' : 'Reinstall is blocked until licensing and compatibility are cleared.'}
                      style={{ ...actionStyle, opacity: modelBusy || !model.reinstallAllowed ? 0.55 : 1 }}
                    >
                      {busyAction === `${model.id}:reinstall` && model.id === 'genconvit'
                        ? 'Downloading and verifying…'
                        : 'Reinstall'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
};

function RuntimeItem({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div style={{ border: '1px solid var(--vl-border)', borderRadius: 8, padding: 10, minWidth: 0 }}>
      <div style={{ color: 'var(--vl-text-dim)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ color: 'var(--vl-text-primary)', fontSize: 11, fontWeight: 700, marginTop: 5, overflowWrap: 'anywhere' }}>{value}</div>
      <div style={{ color: 'var(--vl-text-dim)', fontSize: 9, marginTop: 4, overflowWrap: 'anywhere' }}>{detail}</div>
    </div>
  );
}
