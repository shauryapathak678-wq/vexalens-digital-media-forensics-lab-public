import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Binary, Download, Hash, ShieldCheck, Upload } from 'lucide-react';
import { calculateSHA256 } from '@/lib/forensics/crypto';
import {
  analyzeLsbPixels,
  type LsbAnalysisResult,
} from '@/lib/forensics/lsbAnalysis';
import {
  detectPngTrailingData,
  recoverFstgFile,
  type HiddenFileRecovery,
  type PngDetection,
} from '@/lib/forensics/steganographyFileExtractor';

interface AuditEntry {
  time: string;
  action: string;
  detail: string;
}

function imageDataUrl(imageData: ImageData): string {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d')?.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

export const SteganographyDetectorView: React.FC = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [hashBefore, setHashBefore] = useState('');
  const [hashAfter, setHashAfter] = useState('');
  const [result, setResult] = useState<LsbAnalysisResult | null>(null);
  const [error, setError] = useState('');
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [sourcePixels, setSourcePixels] = useState<ImageData | null>(null);
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState<HiddenFileRecovery | null>(null);
  const [pngDetection, setPngDetection] = useState<PngDetection | null>(null);
  const [recoveredUrl, setRecoveredUrl] = useState('');
  const [pngInput, setPngInput] = useState(false);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => () => {
    if (recoveredUrl) URL.revokeObjectURL(recoveredUrl);
  }, [recoveredUrl]);

  const addAudit = (action: string, detail: string) => {
    setAudit((current) => [...current, { time: new Date().toISOString(), action, detail }]);
  };

  const analyzeFile = async (file?: File) => {
    if (!file) return;
    setError('');
    setResult(null);
    setAudit([]);
    setRecovery(null);
    setPngDetection(null);
    setSourcePixels(null);
    setPassword('');
    setRecoveredUrl('');
    setPngInput(file.type === 'image/png');
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/bmp'].includes(file.type)) {
      setError('Choose a PNG, JPEG, WebP, or BMP image.');
      return;
    }
    try {
      const originalBytes = await file.arrayBuffer();
      const before = await calculateSHA256(originalBytes);
      setHashBefore(before);
      setHashAfter(before);
      setFileName(file.name);
      addAudit('Evidence selected', `${file.name}; ${file.size} bytes`);
      addAudit('SHA-256 before analysis', before);

      const copyUrl = URL.createObjectURL(new Blob([originalBytes], { type: file.type }));
      setPreviewUrl(copyUrl);
      const bitmap = await createImageBitmap(new Blob([originalBytes], { type: file.type }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('This browser could not create an image analysis canvas.');
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);

      setResult(analyzeLsbPixels(pixels));
      setSourcePixels(pixels);
      const fileDetection = detectPngTrailingData(new Uint8Array(originalBytes));
      setPngDetection(fileDetection);
      const hiddenRecovery = file.type === 'image/png'
        ? await recoverFstgFile(pixels)
        : { found: false };
      setRecovery(hiddenRecovery);
      if (hiddenRecovery.recoveredFile) {
        setRecoveredUrl(URL.createObjectURL(hiddenRecovery.recoveredFile));
      }
      addAudit(
        'FSTG1 hidden-file scan',
        hiddenRecovery.found
          ? `Found ${hiddenRecovery.fileName || 'a hidden file'} (${hiddenRecovery.originalSize?.toLocaleString() || 'unknown'} bytes)${hiddenRecovery.passwordProtected ? '; password protected' : ''}.`
          : file.type === 'image/png'
            ? 'No FSTG1 hidden-file marker found.'
            : 'Skipped: this recovery format requires an unchanged PNG image.',
      );
      if (fileDetection.appendedBytes > 0) {
        addAudit('PNG structure scan', fileDetection.reasons[0]);
      }
      const after = await calculateSHA256(originalBytes);
      setHashAfter(after);
      addAudit('LSB plane extraction completed', `${bitmap.width} x ${bitmap.height} pixels`);
      addAudit('SHA-256 after analysis', after);
      addAudit('Integrity check', before === after ? 'MATCH: browser copy unchanged' : 'MISMATCH: file copy changed');
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : 'Could not analyze this image.');
    }
  };

  const retryHiddenFileRecovery = async () => {
    if (!sourcePixels || !fileName) return;
    setError('');
    setRecoveredUrl('');
    try {
      const hiddenRecovery = await recoverFstgFile(sourcePixels, password);
      setRecovery(hiddenRecovery);
      if (!hiddenRecovery.found) {
        addAudit('FSTG1 extraction', 'No hidden-file marker found.');
        return;
      }
      if (hiddenRecovery.recoveredFile) {
        const url = URL.createObjectURL(hiddenRecovery.recoveredFile);
        setRecoveredUrl(url);
        addAudit(
          'Hidden file recovered and verified',
          `${hiddenRecovery.fileName}; ${hiddenRecovery.originalSize?.toLocaleString()} bytes; SHA-256 ${hiddenRecovery.sha256}`,
        );
      } else if (hiddenRecovery.passwordProtected) {
        addAudit('Password required', `${hiddenRecovery.fileName} is password protected.`);
      }
    } catch (recoveryError) {
      const message = recoveryError instanceof Error ? recoveryError.message : 'Hidden file recovery failed.';
      setError(message);
      addAudit('Hidden file recovery failed', message);
    }
  };

  const downloadAudit = () => {
    const text = [
      'VexaLens Steganography Detector - Feature 1 Audit Log',
      `File: ${fileName}`,
      `SHA-256 before: ${hashBefore}`,
      `SHA-256 after: ${hashAfter}`,
      '',
      ...audit.map((entry) => `${entry.time} | ${entry.action} | ${entry.detail}`),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'steganography-feature1-audit.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="mx-auto max-w-7xl space-y-5 p-4 pb-16 sm:p-7" style={{ color: 'var(--vl-text-primary)' }}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: 'var(--vl-ice-cyan)' }}>Offline Image Analysis</div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><Binary size={24} /> Steganography Detector</h1>
          <p className="mt-1 max-w-3xl text-sm" style={{ color: 'var(--vl-text-secondary)' }}>
            Detect and recover files hidden by the uploaded FSTG1 tool, with LSB visual analysis and integrity verification.
          </p>
        </div>
        <a
          href="/downloads/forensics_stego_lab.zip"
          download="forensics_stego_lab.zip"
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold"
          style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface)' }}
        >
          <Download size={14} /> Download Stego Demo ZIP
        </a>
      </header>

      <section className="rounded-xl border p-4" style={{ background: 'var(--vl-surface)', borderColor: 'var(--vl-border)' }}>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" className="sr-only" onChange={(event) => void analyzeFile(event.target.files?.[0])} />
        <button type="button" onClick={() => inputRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-xs font-semibold" style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}>
          <Upload size={15} /> Choose image
        </button>
        <label className="ml-3 inline-flex flex-wrap items-center gap-2 text-xs">
          Password (only for protected demo image)
          <input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Optional"
            className="rounded-md border px-3 py-2 text-xs"
            style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)', color: 'var(--vl-text-primary)' }}
          />
        </label>
        <p className="mt-3 text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
          Try the provided ZIP samples: <code>puppy_stego_nopw.png</code> should recover automatically;
          <code> puppy_stego.png</code> uses password <code>lab123</code>. The clean comparison is <code>puppy_cover.png</code>.
          Hidden-file recovery requires the original PNG; resizing or converting it will destroy the embedded bits.
        </p>
        {sourcePixels && recovery?.found && !recovery.recoveredFile && (
          <button
            type="button"
            onClick={() => void retryHiddenFileRecovery()}
            className="ml-3 rounded-lg border px-3 py-2 text-xs font-semibold"
            style={{ borderColor: 'var(--vl-border)', background: 'var(--vl-surface-elevated)' }}
          >
            Unlock / recover hidden file
          </button>
        )}
        {error && <p className="mt-3 flex items-center gap-2 text-xs text-rose-300"><AlertTriangle size={14} />{error}</p>}
      </section>

      {result && (
        <>
          <section className="rounded-xl border p-4" style={{ background: 'var(--vl-surface)', borderColor: 'var(--vl-border)' }}>
            <h2 className="mb-2 text-sm font-bold">Detector result</h2>
            <p className={`text-lg font-bold ${recovery?.found ? 'text-rose-300' : pngDetection?.verdict === 'Needs review' ? 'text-amber-300' : 'text-emerald-300'}`}>
              {!pngInput
                ? 'LSB review only — FSTG1 recovery requires PNG'
                : recovery?.found
                  ? 'High risk — hidden file marker found'
                  : pngDetection?.verdict || 'Analyzing'}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs" style={{ color: 'var(--vl-text-secondary)' }}>
              {recovery?.found ? (
                <>
                  <li>FSTG1 hidden-file marker found in the image RGB LSB stream.</li>
                  <li>
                    Embedded file: <strong>{recovery.fileName}</strong> · {recovery.originalSize?.toLocaleString()} bytes.
                  </li>
                  <li>
                    Image capacity used: {recovery.capacityUsedPercent}%.
                  </li>
                  {recovery.passwordProtected && <li>This file is password protected.</li>}
                  {recovery.recoveredFile && <li>Recovered file SHA-256 verified successfully.</li>}
                </>
              ) : (
                <li>
                  {pngInput
                    ? 'No FSTG1 marker found. Other steganography formats may still be present.'
                    : 'FSTG1 extraction was not run because this is not a PNG. Other steganography formats may still be present.'}
                </li>
              )}
              {pngDetection?.reasons.map((reason) => <li key={reason}>{reason}</li>)}
              {!pngDetection?.appendedBytes && (
                <li>LSB ratios near 0.50 are only a clue; noisy natural images can have similar ratios.</li>
              )}
            </ul>
            {recovery?.found && !recovery.recoveredFile && (
              <p className="mt-3 rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--vl-border)', color: 'var(--vl-text-secondary)' }}>
                {recovery.passwordProtected
                  ? 'A hidden file was found. Enter its password above and select “Unlock / recover hidden file”.'
                  : 'A hidden file was found, but it has not been recovered yet. Select “Unlock / recover hidden file”.'}
              </p>
            )}
            {recovery?.recoveredFile && recoveredUrl && (
              <div className="mt-4 rounded-lg border p-3" style={{ borderColor: 'var(--vl-border)' }}>
                <p className="text-sm font-semibold">Recovered file: {recovery.fileName}</p>
                <p className="mt-1 text-[10px] font-mono break-all" style={{ color: 'var(--vl-text-dim)' }}>
                  SHA-256: {recovery.sha256}
                </p>
                <a
                  href={recoveredUrl}
                  download={recovery.fileName}
                  className="mt-3 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
                  style={{ borderColor: 'var(--vl-border)' }}
                >
                  <Download size={14} /> Download recovered file
                </a>
                {recovery.recoveredFile.type === 'application/pdf' && (
                  <iframe
                    src={recoveredUrl}
                    title={`Recovered PDF ${recovery.fileName}`}
                    className="mt-3 h-[600px] w-full rounded-lg border bg-white"
                    style={{ borderColor: 'var(--vl-border)' }}
                  />
                )}
              </div>
            )}
          </section>
          <section className="grid gap-4 lg:grid-cols-[0.7fr_1.3fr]">
            <div className="rounded-xl border p-4" style={{ background: 'var(--vl-surface)', borderColor: 'var(--vl-border)' }}>
              <h2 className="mb-3 text-sm font-bold">Evidence copy</h2>
              {previewUrl && <img src={previewUrl} alt={fileName} className="max-h-72 w-full rounded-lg object-contain" />}
              <dl className="mt-3 space-y-2 text-xs">
                <div><dt style={{ color: 'var(--vl-text-dim)' }}>File</dt><dd className="break-all">{fileName}</dd></div>
                <div><dt style={{ color: 'var(--vl-text-dim)' }}>Before</dt><dd className="break-all font-mono text-[10px]">{hashBefore}</dd></div>
                <div><dt style={{ color: 'var(--vl-text-dim)' }}>After</dt><dd className="break-all font-mono text-[10px]">{hashAfter}</dd></div>
              </dl>
              <p className="mt-3 flex items-center gap-2 text-xs text-emerald-300"><ShieldCheck size={14} /> {hashBefore === hashAfter ? 'The browser copy remained unchanged.' : 'The browser copy changed.'}</p>
            </div>
            <div className="rounded-xl border p-4" style={{ background: 'var(--vl-surface)', borderColor: 'var(--vl-border)' }}>
              <h2 className="mb-3 text-sm font-bold"><Hash size={16} className="mr-2 inline" />LSB channel ratios</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                {result.channels.map((channel) => (
                  <div key={channel.name} className="rounded-lg border p-3" style={{ borderColor: 'var(--vl-border)' }}>
                    <p className="text-xs font-semibold">{channel.name}</p>
                    <p className="mt-1 text-xl font-bold">{channel.oneRatio.toFixed(4)}</p>
                    <p className="text-[10px]" style={{ color: 'var(--vl-text-dim)' }}>{channel.ones}/{channel.total} pixels have LSB 1</p>
                    <p className="mt-2 text-[11px]" style={{ color: channel.oneRatio >= 0.47 && channel.oneRatio <= 0.53 ? '#fbbf24' : 'var(--vl-text-secondary)' }}>
                      {channel.oneRatio >= 0.47 && channel.oneRatio <= 0.53
                        ? 'Near 50%: clue only; common in noisy photos'
                        : 'Not close to 50%'}
                    </p>
                    <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--vl-border)' }}>
                      <p className="text-[10px] font-semibold" style={{ color: 'var(--vl-text-dim)' }}>
                        Hidden-text preview
                      </p>
                      <p className="mt-1 max-h-20 overflow-auto break-all font-mono text-[10px]" style={{ color: channel.printableRatio >= 0.6 ? '#34d399' : 'var(--vl-text-secondary)' }}>
                        {channel.printableRatio >= 0.6
                          ? (channel.hiddenTextPreview.trim() || 'No readable text found')
                          : 'No readable text pattern found'}
                      </p>
                      <p className="mt-1 text-[9px]" style={{ color: 'var(--vl-text-dim)' }}>
                        Printable: {(channel.printableRatio * 100).toFixed(1)}%
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="rounded-xl border p-4" style={{ background: 'var(--vl-surface)', borderColor: 'var(--vl-border)' }}>
            <h2 className="mb-3 text-sm font-bold">LSB plane images</h2>
            <p className="mb-4 text-xs" style={{ color: 'var(--vl-text-secondary)' }}>White pixels have LSB 1. Black pixels have LSB 0.</p>
            <div className="grid gap-4 md:grid-cols-3">
              {(['red', 'green', 'blue'] as const).map((name) => (
                <div key={name}>
                  <p className="mb-1 text-xs font-semibold capitalize">{name}</p>
                  <img src={imageDataUrl(result.planes[name])} alt={`${name} LSB plane`} className="max-h-72 w-full rounded-lg border object-contain" style={{ borderColor: 'var(--vl-border)', imageRendering: 'pixelated' }} />
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border p-4" style={{ background: 'var(--vl-surface)', borderColor: 'var(--vl-border)' }}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold">Audit log</h2>
              <button type="button" onClick={downloadAudit} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--vl-border)' }}><Download size={14} /> Download log</button>
            </div>
            <div className="mt-3 space-y-2">
              {audit.map((entry, index) => (
                <p key={`${entry.time}-${index}`} className="text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}><span className="font-mono">{entry.time}</span> · <strong>{entry.action}</strong> · {entry.detail}</p>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
};
