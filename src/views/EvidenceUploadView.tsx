import React, { useState, useRef, useEffect } from 'react';
import { Investigation, EvidenceItem, EvidenceMetadata, MediaType } from '@/types/forensics';
import { calculateEvidenceHashes } from '@/lib/forensics/crypto';
import { extractMediaMetadata } from '@/lib/forensics/metadata';
import { generateThumbnail, generateVideoThumbnail } from '@/lib/forensics/image';
import {
  UploadCloud,
  FileCheck2,
  Sparkles,
  AlertCircle,
  Check,
  ArrowRight,
  Image as ImageIcon,
  Video,
  Music,
  X,
  ShieldCheck,
  Cpu,
} from 'lucide-react';

interface EvidenceUploadViewProps {
  investigations: Investigation[];
  currentCase?: Investigation;
  onAddEvidence: (
    item: Omit<EvidenceItem, 'id' | 'createdAt'>,
    file: File | Blob,
    hashesPromise: Promise<{ sha256: string; md5: string }>,
    onUploadProgress?: (uploadedBytes: number, totalBytes: number) => void,
  ) => Promise<EvidenceItem>;
  onUpdateEvidenceThumbnail: (id: string, thumbnailUrl: string) => Promise<EvidenceItem>;
  onUpdateEvidenceMetadata: (id: string, metadata: EvidenceMetadata) => Promise<EvidenceItem>;
  onGoToExamine: (item: EvidenceItem) => void;
}

export const EvidenceUploadView: React.FC<EvidenceUploadViewProps> = ({
  investigations,
  currentCase,
  onAddEvidence,
  onUpdateEvidenceThumbnail,
  onUpdateEvidenceMetadata,
  onGoToExamine,
}) => {
  const [targetCaseId, setTargetCaseId] = useState<string>(
    currentCase?.id || investigations[0]?.id || ''
  );
  const [isOriginal, setIsOriginal] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processingStatus, setProcessingStatus] = useState<string>('');
  const [processingStep, setProcessingStep] = useState<number>(0);
  const [hashProgress, setHashProgress] = useState<{ processedBytes: number; totalBytes: number } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ uploadedBytes: number; totalBytes: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [recentIngested, setRecentIngested] = useState<EvidenceItem | null>(null);
  const [error, setError] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (investigations.length === 0) {
      setTargetCaseId('');
      return;
    }
    if (currentCase && investigations.some((investigation) => investigation.id === currentCase.id)) {
      setTargetCaseId(currentCase.id);
      return;
    }
    if (!investigations.some((investigation) => investigation.id === targetCaseId)) {
      setTargetCaseId(investigations[0].id);
    }
  }, [currentCase?.id, investigations, targetCaseId]);

  const steps = [
    'Preparing the file and calculating integrity hashes…',
    'Uploading original file and computing SHA-256 and MD5…',
    'Registering chain-of-custody log…',
    'Evidence registered.',
  ];

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };
  const progressPercent = (completed: number, total: number): number =>
    total === 0 ? 100 : Math.min(100, Math.round((completed / total) * 100));

  const processFile = async (file: File | Blob, customName?: string, customIsOriginal?: boolean) => {
    if (!targetCaseId) {
      setError('Please select or create an investigation first.');
      return;
    }
    setError('');
    setIsProcessing(true);
    setProcessingStep(0);
    setProcessingStatus(steps[0]);
    setHashProgress({ processedBytes: 0, totalBytes: file.size });
    setUploadProgress({ uploadedBytes: 0, totalBytes: file.size });

    try {
      const hashesPromise = calculateEvidenceHashes(file, setHashProgress);
      const metadataPromise = extractMediaMetadata(file);
      const mime = file.type || 'application/octet-stream';
      let mediaType: MediaType = 'other';
      if (mime.startsWith('video/')) mediaType = 'video';
      else if (mime.startsWith('audio/')) mediaType = 'audio';
      else if (mime.startsWith('image/')) mediaType = 'image';
      else if (
        mime === 'application/pdf' ||
        mime.startsWith('text/') ||
        mime.includes('document') ||
        mime.includes('wordprocessingml') ||
        mime.includes('spreadsheet') ||
        mime.includes('presentation')
      ) mediaType = 'document';
      const videoThumbnailPromise = mediaType === 'video' ? generateVideoThumbnail(file) : null;
      setProcessingStep(1);
      setProcessingStatus(steps[1]);

      const previewUrl = URL.createObjectURL(file);
      const thumbnailUrl = mediaType === 'image' ? await generateThumbnail(file) : null;
      const fileName = customName || (file as File).name || `evidence_${Date.now()}.${mime.split('/')[1] || 'bin'}`;

      setProcessingStep(2);
      setProcessingStatus(steps[2]);

      const newItem = {
        investigationId: targetCaseId,
        userId: 'usr_forensic_01',
        fileName,
        fileSize: file.size,
        mimeType: mime,
        mediaType,
        sha256Hash: '',
        storageUrl: previewUrl,
        previewUrl,
        thumbnailUrl: thumbnailUrl || undefined,
        isOriginal: customIsOriginal !== undefined ? customIsOriginal : isOriginal,
        verified: false,
        metadata: { fileSizeBytes: file.size, fileFormat: mime },
      };

      const savedItem = await onAddEvidence(newItem, file, hashesPromise, (uploadedBytes, totalBytes) => {
        setUploadProgress({ uploadedBytes, totalBytes });
      });
      setProcessingStep(3);
      setProcessingStatus(steps[3]);
      setRecentIngested(savedItem);
      void metadataPromise
        .then((metadata) => onUpdateEvidenceMetadata(savedItem.id, metadata))
        .then((updatedItem) => {
          setRecentIngested((current) => current?.id === updatedItem.id ? updatedItem : current);
        })
        .catch((metadataError: unknown) => {
          setError(`Evidence uploaded, but detailed metadata could not be saved: ${metadataError instanceof Error ? metadataError.message : 'Metadata extraction failed.'}`);
        });
      if (videoThumbnailPromise) {
        void videoThumbnailPromise.then(async (videoThumbnail) => {
          if (!videoThumbnail) return;
          try {
            const updatedItem = await onUpdateEvidenceThumbnail(savedItem.id, videoThumbnail);
            setRecentIngested((current) => current?.id === updatedItem.id ? updatedItem : current);
          } catch (error) {
            setError(`Evidence uploaded, but its video preview frame could not be saved: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }).catch((thumbnailError: unknown) => {
          setError(`Evidence uploaded, but its video preview frame could not be created: ${thumbnailError instanceof Error ? thumbnailError.message : 'Video thumbnail generation failed.'}`);
        });
      }
    } catch (err: any) {
      setError(`Evidence intake error: ${err?.message || 'Failed to process file'}`);
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
      setProcessingStep(0);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const mediaTypeIcon = (mediaType: string) => {
    if (mediaType === 'video') return <Video className="w-4 h-4" style={{ color: 'var(--vl-ice-cyan)' }} />;
    if (mediaType === 'audio') return <Music className="w-4 h-4" style={{ color: 'var(--vl-electric-blue)' }} />;
    return <ImageIcon className="w-4 h-4" style={{ color: 'var(--vl-ice-cyan)' }} />;
  };

  return (
    <div
      className="p-5 sm:p-8 max-w-4xl mx-auto space-y-6 pb-16"
      style={{ fontFamily: 'var(--font-sans)' }}
    >
      {/* Header */}
      <div>
        <div
          className="text-[11px] font-mono font-semibold uppercase tracking-[0.1em] mb-1"
          style={{ color: 'var(--vl-ice-cyan)' }}
        >
          Evidence Intake
        </div>
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: 'var(--vl-text-primary)', letterSpacing: '-0.02em' }}
        >
          Digital Evidence Ingestion & Verification
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--vl-text-secondary)' }}>
          Intake digital media into a controlled forensic custody chain with automated SHA-256
          integrity hashing and metadata extraction.
        </p>
      </div>

      {/* Investigation Scope */}
      <div
        className="p-5 rounded-xl space-y-4"
        style={{
          background: 'var(--vl-surface)',
          border: '1px solid var(--vl-border)',
          boxShadow: 'var(--vl-card-shadow)',
        }}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex-1">
            <label
              className="text-[10px] font-semibold uppercase tracking-[0.1em] block mb-1.5"
              style={{ color: 'var(--vl-text-dim)' }}
            >
              Target Investigation
            </label>
            <select
              id="upload-case-selector"
              value={targetCaseId}
              onChange={(e) => setTargetCaseId(e.target.value)}
              disabled={investigations.length === 0}
              className="w-full sm:w-96 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none transition-colors"
              style={{
                background: 'var(--vl-surface-elevated)',
                border: '1px solid var(--vl-border)',
                color: 'var(--vl-text-primary)',
              }}
            >
              {investigations.length === 0 ? (
                <option value="">No investigations — create one first</option>
              ) : (
                investigations.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.caseNumber} · {inv.title.slice(0, 40)}
                  </option>
                ))
              )}
            </select>
          </div>

          <label
            className="flex items-center gap-2.5 cursor-pointer text-xs"
            style={{ color: 'var(--vl-text-secondary)' }}
          >
            <input
              type="checkbox"
              checked={isOriginal}
              onChange={(e) => setIsOriginal(e.target.checked)}
              className="w-4 h-4 rounded"
              id="upload-baseline-toggle"
            />
            <span>Designate as authentic baseline reference</span>
          </label>
        </div>
      </div>

      {/* Dropzone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => !isProcessing && fileInputRef.current?.click()}
        className="rounded-xl p-12 flex flex-col items-center justify-center text-center transition-all duration-200"
        style={{
          background: isDragging ? 'rgba(98,229,232,0.04)' : 'var(--vl-surface)',
          border: `2px dashed ${isDragging ? 'var(--vl-ice-cyan)' : isProcessing ? 'rgba(98,229,232,0.3)' : 'var(--vl-border)'}`,
          cursor: isProcessing ? 'not-allowed' : 'pointer',
          boxShadow: isDragging ? '0 0 32px rgba(98,229,232,0.08)' : 'var(--vl-card-shadow)',
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileInputChange}
          className="hidden"
          id="upload-file-input"
        />

        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5"
          style={{
            background: isProcessing ? 'rgba(98,229,232,0.08)' : 'var(--vl-surface-elevated)',
            border: '1px solid var(--vl-border)',
          }}
        >
          {isProcessing ? (
            <div
              className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin"
              style={{ borderColor: 'var(--vl-ice-cyan)', borderTopColor: 'transparent' }}
            />
          ) : (
            <UploadCloud className="w-6 h-6" style={{ color: isDragging ? 'var(--vl-ice-cyan)' : 'var(--vl-text-dim)' }} />
          )}
        </div>

        {isProcessing ? (
          <div className="space-y-3 w-full max-w-sm">
            <p className="text-sm font-semibold" style={{ color: 'var(--vl-ice-cyan)' }}>
              {processingStatus}
            </p>
            {/* Progress steps */}
            <div className="flex items-center justify-center gap-2">
              {steps.slice(0, 3).map((_, i) => (
                <div
                  key={i}
                  className="h-1 flex-1 rounded-full transition-all duration-500"
                  style={{
                    background: i < processingStep ? 'var(--vl-ice-cyan)' : i === processingStep ? 'rgba(98,229,232,0.4)' : 'var(--vl-border)',
                  }}
                />
              ))}
            </div>
            <p className="text-xs" style={{ color: 'var(--vl-text-dim)' }}>
              {`Integrity hash: ${hashProgress ? `${progressPercent(hashProgress.processedBytes, hashProgress.totalBytes)}%` : 'starting'} · Upload: ${uploadProgress ? `${progressPercent(uploadProgress.uploadedBytes, uploadProgress.totalBytes)}%` : 'starting'}`}
            </p>
            <div className="space-y-2 text-left">
              <div>
                <div className="flex justify-between text-[10px] mb-1" style={{ color: 'var(--vl-text-dim)' }}>
                  <span>File integrity hash</span>
                  <span>{hashProgress ? `${formatBytes(hashProgress.processedBytes)} / ${formatBytes(hashProgress.totalBytes)}` : 'Starting…'}</span>
                </div>
                <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--vl-border)' }}>
                  <div
                    className="h-full transition-[width] duration-150"
                    role="progressbar"
                    aria-label="File integrity hashing progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={hashProgress ? progressPercent(hashProgress.processedBytes, hashProgress.totalBytes) : 0}
                    style={{
                      width: `${hashProgress ? progressPercent(hashProgress.processedBytes, hashProgress.totalBytes) : 0}%`,
                      background: 'var(--vl-electric-blue)',
                    }}
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between text-[10px] mb-1" style={{ color: 'var(--vl-text-dim)' }}>
                  <span>Upload</span>
                  <span>{uploadProgress ? `${formatBytes(uploadProgress.uploadedBytes)} / ${formatBytes(uploadProgress.totalBytes)}` : 'Starting…'}</span>
                </div>
                <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--vl-border)' }}>
                  <div
                    className="h-full transition-[width] duration-150"
                    role="progressbar"
                    aria-label="Evidence upload progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={uploadProgress ? progressPercent(uploadProgress.uploadedBytes, uploadProgress.totalBytes) : 0}
                    style={{
                      width: `${uploadProgress ? progressPercent(uploadProgress.uploadedBytes, uploadProgress.totalBytes) : 0}%`,
                      background: 'var(--vl-ice-cyan)',
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            <h4
              className="text-sm font-semibold mb-1"
              style={{ color: 'var(--vl-text-primary)' }}
            >
              {isDragging ? 'Release to analyze evidence' : 'Drop evidence file here, or click to browse'}
            </h4>
            <p className="text-[12px] mb-4" style={{ color: 'var(--vl-text-secondary)' }}>
              Images, video, audio, PDFs, documents, and other files · Original bytes are preserved
            </p>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {['Images', 'Video', 'Audio', 'PDF', 'Documents', 'Other files'].map((fmt) => (
                <span
                  key={fmt}
                  className="text-[10px] font-mono px-2 py-0.5 rounded"
                  style={{
                    background: 'var(--vl-surface-elevated)',
                    border: '1px solid var(--vl-border)',
                    color: 'var(--vl-text-dim)',
                  }}
                >
                  {fmt}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div
          className="flex items-center gap-2.5 p-3 rounded-lg text-xs"
          style={{
            background: 'rgba(255,102,122,0.08)',
            border: '1px solid rgba(255,102,122,0.25)',
            color: 'var(--vl-critical)',
          }}
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError('')} className="ml-auto">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Forensic Real-Data Intake Standards Card */}
      <div
        className="p-5 rounded-xl space-y-3"
        style={{
          background: 'var(--vl-surface)',
          border: '1px solid var(--vl-border)',
          boxShadow: 'var(--vl-card-shadow)',
        }}
      >
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" style={{ color: 'var(--vl-ice-cyan)' }} />
          <h2 className="text-xs font-semibold" style={{ color: 'var(--vl-text-primary)' }}>
            Real Evidence Custody & Intake Standards (ISO/IEC 27037)
          </h2>
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded ml-auto"
            style={{
              background: 'rgba(72,213,151,0.1)',
              border: '1px solid rgba(72,213,151,0.25)',
              color: 'var(--vl-success)',
            }}
          >
            LIVE FORENSIC LAB
          </span>
        </div>
        <p className="text-[12px]" style={{ color: 'var(--vl-text-secondary)' }}>
          All media ingested is verified through deterministic client-side and server-side cryptographic pipelines. No synthetic mock records are populated.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          <div
            className="p-3 rounded-lg space-y-1.5"
            style={{
              background: 'var(--vl-surface-elevated)',
              border: '1px solid var(--vl-border)',
            }}
          >
            <div className="text-[11px] font-mono font-bold text-cyan-300 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5" /> 1. SHA-256 Digest
            </div>
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--vl-text-secondary)' }}>
              Computes unforgeable bitstream checksum before writing to persistent case storage.
            </p>
          </div>

          <div
            className="p-3 rounded-lg space-y-1.5"
            style={{
              background: 'var(--vl-surface-elevated)',
              border: '1px solid var(--vl-border)',
            }}
          >
            <div className="text-[11px] font-mono font-bold text-cyan-300 flex items-center gap-1.5">
              <FileCheck2 className="w-3.5 h-3.5" /> 2. EXIF / IPTC / XMP
            </div>
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--vl-text-secondary)' }}>
              Extracts camera sensor serials, firmware version, lens focal length, and software modification history.
            </p>
          </div>

          <div
            className="p-3 rounded-lg space-y-1.5"
            style={{
              background: 'var(--vl-surface-elevated)',
              border: '1px solid var(--vl-border)',
            }}
          >
            <div className="text-[11px] font-mono font-bold text-cyan-300 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" /> 3. Immutable Custody
            </div>
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--vl-text-secondary)' }}>
              Generates cryptographic chain-of-custody transfer logs adhering to forensic admissibility standards.
            </p>
          </div>
        </div>
      </div>

      {/* Success card */}
      {recentIngested && (
        <div
          className="p-5 rounded-xl space-y-4"
          style={{
            background: 'rgba(72,213,151,0.06)',
            border: '1px solid rgba(72,213,151,0.25)',
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(72,213,151,0.15)' }}
              >
                <Check className="w-4 h-4" style={{ color: 'var(--vl-success)' }} />
              </div>
              <div>
                <p className="text-xs font-semibold" style={{ color: 'var(--vl-success)' }}>
                  Evidence Ingested Successfully
                </p>
                <p className="text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
                  Chain-of-custody log registered
                </p>
              </div>
            </div>
            <button
              id="upload-examine-now"
              onClick={() => onGoToExamine(recentIngested)}
              className="vl-btn-primary text-[11px] px-3 py-1.5"
            >
              Examine Now
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div
            className="rounded-lg p-3 font-mono text-[11px] space-y-1.5"
            style={{
              background: 'var(--vl-surface)',
              border: '1px solid var(--vl-border)',
            }}
          >
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--vl-text-dim)' }}>Filename:</span>
              <span style={{ color: 'var(--vl-text-primary)' }}>{recentIngested.fileName}</span>
              <span
                className="ml-auto px-1.5 py-0.5 rounded text-[10px]"
                style={{
                  background: recentIngested.isOriginal ? 'rgba(72,213,151,0.1)' : 'rgba(98,229,232,0.1)',
                  color: recentIngested.isOriginal ? 'var(--vl-success)' : 'var(--vl-ice-cyan)',
                }}
              >
                {recentIngested.isOriginal ? 'Baseline' : 'Suspect'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--vl-text-dim)' }}>SHA-256:</span>
              <span className="truncate" style={{ color: 'var(--vl-text-secondary)' }}>
                {recentIngested.sha256Hash || '—'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--vl-text-dim)' }}>Type:</span>
              <span className="uppercase" style={{ color: 'var(--vl-text-primary)' }}>
                {recentIngested.mediaType}
              </span>
              <span style={{ color: 'var(--vl-text-dim)' }}>·</span>
              <span style={{ color: 'var(--vl-text-secondary)' }}>
                {Math.round(recentIngested.fileSize / 1024)} KB
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
