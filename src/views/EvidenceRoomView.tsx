import React, { useState, useMemo, useEffect, useRef } from 'react';
import { EvidenceItem, Investigation } from '@/types/forensics';
import { getEvidenceSignedUrl } from '@/lib/supabase-sync';
import { EvidenceGpsMap } from '@/components/forensics/EvidenceGpsMap';
import { RoyalPageFrame } from '@/components/common/RoyalPageFrame';
import {
  ArrowLeft,
  Archive,
  Search,
  Image as ImageIcon,
  Video,
  Music,
  FileText,
  Eye,
  FolderOpen,
  Calendar,
  HardDrive,
  Hash,
  Info,
} from 'lucide-react';

interface EvidenceRoomViewProps {
  evidenceList: EvidenceItem[];
  investigations: Investigation[];
  onOpenEvidence: (item: EvidenceItem) => void;
  onOpenCase: (inv: Investigation) => void;
}

type SortMode = 'newest' | 'oldest' | 'case' | 'name';
type MediaFilter = 'all' | 'image' | 'video' | 'audio' | 'document' | 'other';

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function MediaIcon({ type, color }: { type: string; color?: string }) {
  const style = { width: 16, height: 16, color: color || 'var(--vl-text-dim)' };
  if (type === 'video') return <Video style={style} />;
  if (type === 'audio') return <Music style={style} />;
  if (type === 'document') return <FileText style={style} />;
  return <ImageIcon style={style} />;
}

const MEDIA_COLORS: Record<string, string> = {
  image: '#e2c47c',
  video: '#a895d5',
  audio: '#e9b875',
  document: '#83c9a3',
  other: '#b8a8dc',
};

export const EvidenceRoomView: React.FC<EvidenceRoomViewProps> = ({
  evidenceList,
  investigations,
  onOpenEvidence,
  onOpenCase,
}) => {
  const [search, setSearch] = useState('');
  const [filterMedia, setFilterMedia] = useState<MediaFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedImageUrl, setSelectedImageUrl] = useState<string | null>(null);
  const imageRetryRef = useRef(false);

  const getCaseForEvidence = (ev: EvidenceItem): Investigation | undefined =>
    investigations.find(i => i.id === ev.investigationId);

  const selectedFolder = selectedFolderId
    ? investigations.find((investigation) => investigation.id === selectedFolderId)
    : undefined;

  const evidenceCountByCase = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of evidenceList) {
      counts.set(item.investigationId, (counts.get(item.investigationId) || 0) + 1);
    }
    return counts;
  }, [evidenceList]);

  const filtered = useMemo(() => {
    let list = selectedFolder
      ? evidenceList.filter((item) => item.investigationId === selectedFolder.id)
      : [...evidenceList];

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(ev => {
        const inv = getCaseForEvidence(ev);
        return (
          ev.fileName.toLowerCase().includes(q) ||
          (inv?.title.toLowerCase().includes(q)) ||
          (inv?.caseNumber.toLowerCase().includes(q))
        );
      });
    }

    if (filterMedia !== 'all') {
      list = list.filter(ev => ev.mediaType === filterMedia);
    }

    switch (sortMode) {
      case 'newest':
        list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case 'oldest':
        list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        break;
      case 'case':
        list.sort((a, b) => a.investigationId.localeCompare(b.investigationId));
        break;
      case 'name':
        list.sort((a, b) => a.fileName.localeCompare(b.fileName));
        break;
    }
    return list;
  }, [evidenceList, selectedFolder, search, filterMedia, sortMode]);

  const selectedEvidence = selectedId
    ? evidenceList.find((item) => item.id === selectedId && (!selectedFolder || item.investigationId === selectedFolder.id))
    : null;
  const selectedCase = selectedEvidence ? getCaseForEvidence(selectedEvidence) : undefined;
  const selectedGps = selectedEvidence?.mediaType === 'image'
    ? selectedEvidence.metadata?.gps
    : undefined;
  const gpsLatitude = selectedGps?.latitude;
  const gpsLongitude = selectedGps?.longitude;
  const hasGpsCoordinates = typeof gpsLatitude === 'number' &&
    Number.isFinite(gpsLatitude) &&
    typeof gpsLongitude === 'number' &&
    Number.isFinite(gpsLongitude);
  const isFolderEmpty = Boolean(selectedFolder && !evidenceCountByCase.get(selectedFolder.id));

  const openFolder = (investigationId: string) => {
    setSelectedId(null);
    setSearch('');
    setFilterMedia('all');
    setSortMode('newest');
    setSelectedFolderId(investigationId);
  };

  const closeFolder = () => {
    setSelectedId(null);
    setSelectedFolderId(null);
  };

  useEffect(() => {
    let active = true;
    imageRetryRef.current = false;
    setSelectedImageUrl(selectedEvidence?.previewUrl || selectedEvidence?.thumbnailUrl || null);
    if (
      selectedEvidence?.mediaType === 'image' &&
      !selectedEvidence.previewUrl &&
      !selectedEvidence.thumbnailUrl &&
      selectedEvidence.storageUrl
    ) {
      void getEvidenceSignedUrl(selectedEvidence.storageUrl)
        .then((url) => {
          if (active && url) setSelectedImageUrl(url);
        })
        .catch((error: unknown) => {
          console.error('[EvidenceRoom] Could not resolve image preview URL:', error);
        });
    }
    return () => {
      active = false;
    };
  }, [selectedEvidence?.id, selectedEvidence?.previewUrl, selectedEvidence?.thumbnailUrl, selectedEvidence?.storageUrl]);

  const handleSelectedImageError = async () => {
    if (!selectedEvidence) return;
    if (!imageRetryRef.current && selectedEvidence.storageUrl) {
      imageRetryRef.current = true;
      try {
        const signedUrl = await getEvidenceSignedUrl(selectedEvidence.storageUrl);
        if (signedUrl && signedUrl !== selectedImageUrl) {
          setSelectedImageUrl(signedUrl);
          return;
        }
      } catch (error) {
        console.error('[EvidenceRoom] Could not refresh image preview URL:', error);
      }
    }
    if (selectedEvidence.thumbnailUrl && selectedImageUrl !== selectedEvidence.thumbnailUrl) {
      setSelectedImageUrl(selectedEvidence.thumbnailUrl);
      return;
    }
    setSelectedImageUrl(null);
  };

  const s = {
    card: {
      background: 'var(--vl-surface)',
      border: '1px solid var(--vl-border)',
      borderRadius: 12,
      boxShadow: 'var(--vl-card-shadow)',
    } as React.CSSProperties,
    label: {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.13em',
      textTransform: 'uppercase' as const,
      color: 'var(--vl-text-dim)',
      fontFamily: 'var(--font-mono)',
      marginBottom: 6,
      display: 'block',
    } as React.CSSProperties,
  };

  return (
    <RoyalPageFrame variant="evidence">
    <div
      className="royal-evidence-layout"
      style={{
        padding: '24px',
        maxWidth: 1200,
        margin: '0 auto',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 26,
            fontWeight: 800,
            letterSpacing: '-0.03em',
            color: 'var(--vl-text-primary)',
            lineHeight: 1.2,
            marginBottom: 4,
          }}
        >
          Evidence Room
        </h1>
        <p style={{ fontSize: 13, color: 'var(--vl-text-secondary)' }}>
          {selectedFolder
            ? `${selectedFolder.caseNumber} · ${evidenceCountByCase.get(selectedFolder.id) || 0} evidence item${evidenceCountByCase.get(selectedFolder.id) === 1 ? '' : 's'}`
            : `${investigations.length} case folder${investigations.length !== 1 ? 's' : ''} · ${evidenceList.length} evidence item${evidenceList.length !== 1 ? 's' : ''}`}
        </p>
      </div>

      {!selectedFolder ? (
        investigations.length === 0 ? (
          <div style={{ ...s.card, padding: '48px 20px', textAlign: 'center', color: 'var(--vl-text-dim)' }}>
            <Archive style={{ width: 32, height: 32, margin: '0 auto 12px', opacity: 0.4 }} />
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No case folders yet</div>
            <div style={{ fontSize: 12 }}>Register an investigation to create its evidence folder.</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 14 }}>
            {investigations.map((investigation) => {
              const evidenceCount = evidenceCountByCase.get(investigation.id) || 0;
              return (
                <button
                  key={investigation.id}
                  type="button"
                  data-royal-tilt
                  aria-label={`Open case folder ${investigation.caseNumber}`}
                  onClick={() => openFolder(investigation.id)}
                  style={{
                    ...s.card,
                    padding: 18,
                    color: 'var(--vl-text-primary)',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'border-color 0.15s, transform 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                    <FolderOpen style={{ width: 20, height: 20, color: 'var(--vl-ice-cyan)' }} />
                    <span style={{ ...s.label, marginBottom: 0 }}>Case Folder</span>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
                    {investigation.caseNumber}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--vl-text-secondary)', minHeight: 36 }}>
                    {investigation.title}
                  </div>
                  <div style={{ borderTop: '1px solid var(--vl-border)', marginTop: 14, paddingTop: 12, fontSize: 11, color: 'var(--vl-text-dim)' }}>
                    {evidenceCount} evidence item{evidenceCount === 1 ? '' : 's'}
                  </div>
                </button>
              );
            })}
          </div>
        )
      ) : (
        <>
          <div style={{ ...s.card, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              type="button"
              onClick={closeFolder}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                border: '1px solid var(--vl-border)',
                borderRadius: 8,
                background: 'var(--vl-surface-elevated)',
                color: 'var(--vl-text-secondary)',
                padding: '7px 10px',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <ArrowLeft style={{ width: 13, height: 13 }} />
              Case folders
            </button>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--vl-text-primary)' }}>{selectedFolder.title}</div>
              <div style={{ fontSize: 10.5, color: 'var(--vl-text-dim)', fontFamily: 'var(--font-mono)' }}>{selectedFolder.caseNumber}</div>
            </div>
          </div>
          <div
        style={{
          display: 'grid',
          gridTemplateColumns: selectedId ? 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))' : '1fr',
          gap: 20,
        }}
      >
        {/* Left column: list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Controls */}
          <div
            style={{
              ...s.card,
              padding: '14px 18px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              alignItems: 'center',
            }}
          >
            {/* Search */}
            <div
              style={{
                flex: 1,
                minWidth: 200,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'var(--vl-surface-elevated)',
                border: '1px solid var(--vl-border)',
                borderRadius: 8,
                padding: '7px 12px',
              }}
            >
              <Search style={{ width: 13, height: 13, color: 'var(--vl-text-dim)', flexShrink: 0 }} />
              <input
                id="evidence-room-search"
                type="text"
                placeholder="Search evidence in this case…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  background: 'none',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--vl-text-primary)',
                  fontSize: 12.5,
                  flex: 1,
                  fontFamily: 'var(--font-sans)',
                }}
              />
            </div>

            {/* Media type filter */}
            <div style={{ display: 'flex', gap: 6 }}>
              {(['all', 'image', 'video', 'audio', 'document', 'other'] as MediaFilter[]).map(f => (
                <button
                  key={f}
                  id={`evidence-filter-${f}`}
                  onClick={() => setFilterMedia(f)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 7,
                    border: `1px solid ${filterMedia === f ? 'rgba(98,229,232,0.5)' : 'var(--vl-border)'}`,
                    background: filterMedia === f ? 'rgba(98,229,232,0.1)' : 'var(--vl-surface-elevated)',
                    color: filterMedia === f ? 'var(--vl-ice-cyan)' : 'var(--vl-text-secondary)',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                    transition: 'all 0.15s',
                  }}
                >
                  {f}
                </button>
              ))}
            </div>

            {/* Sort */}
            <select
              id="evidence-sort-select"
              value={sortMode}
              onChange={e => setSortMode(e.target.value as SortMode)}
              style={{
                background: 'var(--vl-surface-elevated)',
                border: '1px solid var(--vl-border)',
                borderRadius: 8,
                color: 'var(--vl-text-secondary)',
                fontSize: 12,
                padding: '7px 10px',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
              }}
            >
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
              <option value="name">By Name</option>
              <option value="case">By Case</option>
            </select>
          </div>

          {/* Evidence grid */}
          {filtered.length === 0 ? (
            <div
              style={{
                ...s.card,
                padding: '48px 20px',
                textAlign: 'center',
                color: 'var(--vl-text-dim)',
              }}
            >
              <Archive style={{ width: 32, height: 32, margin: '0 auto 12px', opacity: 0.3 }} />
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                {isFolderEmpty
                  ? 'No evidence in this case yet'
                  : evidenceList.length === 0
                    ? 'No evidence uploaded yet'
                    : 'No items match your search'}
              </div>
              <div style={{ fontSize: 12 }}>
                {isFolderEmpty
                  ? 'Upload evidence to this case in the Lab. It will appear in this folder automatically.'
                  : evidenceList.length === 0
                  ? 'Upload evidence files in the Lab to start an investigation.'
                  : 'Try different search terms or clear filters.'}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filtered.map(ev => {
                const inv = getCaseForEvidence(ev);
                const mColor = MEDIA_COLORS[ev.mediaType] || '#62E5E8';
                const isSelected = selectedId === ev.id;

                return (
                  <div
                    key={ev.id}
                    data-royal-tilt
                    onClick={() => setSelectedId(isSelected ? null : ev.id)}
                    style={{
                      ...s.card,
                      padding: '14px 18px',
                      cursor: 'pointer',
                      display: 'flex',
                      gap: 14,
                      alignItems: 'flex-start',
                      border: `1px solid ${isSelected ? mColor + '50' : 'var(--vl-border)'}`,
                      background: isSelected ? `${mColor}08` : 'var(--vl-surface)',
                      transition: 'all 0.18s',
                    }}
                    onMouseEnter={e => {
                      if (!isSelected)
                        e.currentTarget.style.borderColor = 'var(--vl-border-highlight)';
                    }}
                    onMouseLeave={e => {
                      if (!isSelected)
                        e.currentTarget.style.borderColor = 'var(--vl-border)';
                    }}
                  >
                    {/* Thumbnail / icon */}
                    <div
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 8,
                        overflow: 'hidden',
                        flexShrink: 0,
                        background: `${mColor}14`,
                        border: `1px solid ${mColor}28`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {ev.thumbnailUrl && ev.mediaType === 'image' ? (
                        <img
                          src={ev.thumbnailUrl}
                          alt={ev.fileName}
                          loading="lazy"
                          decoding="async"
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : (
                        <MediaIcon type={ev.mediaType} color={mColor} />
                      )}
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: 'var(--vl-text-primary)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          marginBottom: 3,
                        }}
                      >
                        {ev.fileName}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--vl-text-secondary)', marginBottom: 5, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                        <span style={{ color: 'var(--vl-ice-cyan)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
                          {inv?.caseNumber || 'No case'}
                        </span>
                        <span>{inv?.title || '—'}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span
                          style={{
                            fontSize: 9.5,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.1em',
                            color: mColor,
                            background: `${mColor}14`,
                            border: `1px solid ${mColor}28`,
                            borderRadius: 999,
                            padding: '1px 8px',
                          }}
                        >
                          {ev.mediaType}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--vl-text-dim)', fontFamily: 'var(--font-mono)' }}>
                          {formatBytes(ev.fileSize)}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--vl-text-dim)' }}>
                          {new Date(ev.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>

                    <div style={{ display: 'flex', flexShrink: 0, gap: 6 }}>
                      <button
                        id={`evidence-view-${ev.id}`}
                        onClick={e => {
                          e.stopPropagation();
                          setSelectedId(ev.id);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          background: 'var(--vl-surface-elevated)',
                          border: '1px solid var(--vl-border)',
                          borderRadius: 7,
                          color: 'var(--vl-text-secondary)',
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '5px 10px',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <Eye style={{ width: 12, height: 12 }} />
                        View Evidence
                      </button>
                      <button
                        id={`evidence-analyze-${ev.id}`}
                        onClick={e => {
                          e.stopPropagation();
                          onOpenEvidence(ev);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          background: 'rgba(98,229,232,0.1)',
                          border: '1px solid rgba(98,229,232,0.25)',
                          borderRadius: 7,
                          color: 'var(--vl-ice-cyan)',
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '5px 10px',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Analyze
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedEvidence && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Preview */}
            <div
              style={{
                ...s.card,
                padding: 0,
                overflow: 'hidden',
              }}
            >
              {selectedImageUrl && selectedEvidence.mediaType === 'image' ? (
                <img
                  src={selectedImageUrl}
                  alt={selectedEvidence.fileName}
                  style={{ width: '100%', maxHeight: 280, objectFit: 'contain', background: 'var(--vl-surface-elevated)' }}
                  onError={() => void handleSelectedImageError()}
                />
              ) : selectedEvidence.previewUrl && selectedEvidence.mediaType === 'video' ? (
                <video
                  src={selectedEvidence.previewUrl}
                  poster={selectedEvidence.thumbnailUrl}
                  controls
                  playsInline
                  preload="metadata"
                  aria-label={selectedEvidence.fileName}
                  style={{ width: '100%', maxHeight: 280, background: 'var(--vl-surface-elevated)' }}
                />
              ) : selectedEvidence.previewUrl && selectedEvidence.mediaType === 'audio' ? (
                <div style={{ padding: 24, background: 'var(--vl-surface-elevated)' }}>
                  <audio src={selectedEvidence.previewUrl} controls preload="metadata" style={{ width: '100%' }} aria-label={selectedEvidence.fileName} />
                </div>
              ) : (
                <div
                  style={{
                    height: 140,
                    background: 'var(--vl-surface-elevated)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <MediaIcon type={selectedEvidence.mediaType} color="var(--vl-text-dim)" />
                </div>
              )}
              <div style={{ padding: '16px 18px' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--vl-text-primary)', marginBottom: 4 }}>
                  {selectedEvidence.fileName}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--vl-text-secondary)' }}>
                  {selectedEvidence.mimeType}
                </div>
                {selectedEvidence.mediaType === 'document' && selectedEvidence.previewUrl && (
                  <a
                    href={selectedEvidence.previewUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: 'inline-block', marginTop: 10, color: 'var(--vl-ice-cyan)', fontSize: 12, fontWeight: 600 }}
                  >
                    Open document
                  </a>
                )}
              </div>
            </div>

            {/* Metadata */}
            <div style={{ ...s.card, padding: '16px 18px' }}>
              <span style={s.label}>File Information</span>
              {[
                { icon: HardDrive, label: 'Size', value: formatBytes(selectedEvidence.fileSize) },
                { icon: Calendar, label: 'Uploaded', value: new Date(selectedEvidence.createdAt).toLocaleString() },
                {
                  icon: Hash,
                  label: 'SHA-256',
                  value: selectedEvidence.sha256Hash
                    ? selectedEvidence.sha256Hash.slice(0, 16) + '…'
                    : '—',
                },
                { icon: FolderOpen, label: 'Case', value: selectedCase?.caseNumber || '—' },
              ].map(({ icon: Icon, label, value }) => (
                <div
                  key={label}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '8px 0',
                    borderBottom: '1px solid var(--vl-border-subtle)',
                  }}
                >
                  <Icon style={{ width: 13, height: 13, color: 'var(--vl-text-dim)', marginTop: 1, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--vl-text-dim)', marginBottom: 1 }}>{label}</div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--vl-text-primary)',
                        fontFamily: label === 'SHA-256' || label === 'Case' ? 'var(--font-mono)' : 'inherit',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {value}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {selectedEvidence.mediaType === 'image' && (
              <div style={{ ...s.card, padding: '16px 18px' }}>
                <span style={s.label}>Image Location</span>
                {hasGpsCoordinates && gpsLatitude !== undefined && gpsLongitude !== undefined ? (
                  <>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                        gap: 12,
                        marginBottom: 14,
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 10.5, color: 'var(--vl-text-dim)', marginBottom: 3 }}>Latitude</div>
                        <div style={{ fontSize: 12, color: 'var(--vl-text-primary)', fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>
                          {gpsLatitude}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10.5, color: 'var(--vl-text-dim)', marginBottom: 3 }}>Longitude</div>
                        <div style={{ fontSize: 12, color: 'var(--vl-text-primary)', fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>
                          {gpsLongitude}
                        </div>
                      </div>
                      {typeof selectedGps?.altitude === 'number' && Number.isFinite(selectedGps.altitude) && (
                        <div>
                          <div style={{ fontSize: 10.5, color: 'var(--vl-text-dim)', marginBottom: 3 }}>Altitude</div>
                          <div style={{ fontSize: 12, color: 'var(--vl-text-primary)' }}>{selectedGps.altitude} m</div>
                        </div>
                      )}
                      <div>
                        <div style={{ fontSize: 10.5, color: 'var(--vl-text-dim)', marginBottom: 3 }}>Date taken</div>
                        <div style={{ fontSize: 12, color: 'var(--vl-text-primary)', overflowWrap: 'anywhere' }}>
                          {selectedEvidence.metadata.dateTimeOriginal || selectedGps?.timestamp || 'Not recorded'}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10.5, color: 'var(--vl-text-dim)', marginBottom: 3 }}>Camera model</div>
                        <div style={{ fontSize: 12, color: 'var(--vl-text-primary)', overflowWrap: 'anywhere' }}>
                          {selectedEvidence.metadata.cameraModel || 'Not recorded'}
                        </div>
                      </div>
                    </div>
                    <EvidenceGpsMap latitude={gpsLatitude} longitude={gpsLongitude} />
                    <a
                      href={`https://www.openstreetmap.org/?mlat=${encodeURIComponent(gpsLatitude)}&mlon=${encodeURIComponent(gpsLongitude)}#map=16/${encodeURIComponent(gpsLatitude)}/${encodeURIComponent(gpsLongitude)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ display: 'inline-block', marginTop: 10, color: 'var(--vl-ice-cyan)', fontSize: 11.5, fontWeight: 600 }}
                    >
                      Open location in OpenStreetMap
                    </a>
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--vl-text-secondary)', lineHeight: 1.5 }}>
                    No GPS data found in this image.
                  </div>
                )}
              </div>
            )}

            {/* Metadata / analysis observations */}
            {selectedEvidence.metadata?.inconsistenciesDetected &&
              selectedEvidence.metadata.inconsistenciesDetected.length > 0 && (
                <div style={{ ...s.card, padding: '16px 18px' }}>
                  <span style={s.label}>Analysis Observations</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {selectedEvidence.metadata.inconsistenciesDetected.map((obs, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          gap: 8,
                          alignItems: 'flex-start',
                        }}
                      >
                        <Info style={{ width: 12, height: 12, color: '#F3BA60', marginTop: 2, flexShrink: 0 }} />
                        <span style={{ fontSize: 12, color: 'var(--vl-text-secondary)', lineHeight: 1.5 }}>
                          {obs}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            {/* No analysis yet */}
            {(!selectedEvidence.metadata?.inconsistenciesDetected ||
              selectedEvidence.metadata.inconsistenciesDetected.length === 0) && (
              <div
                style={{
                  ...s.card,
                  padding: '16px 18px',
                  textAlign: 'center',
                  color: 'var(--vl-text-dim)',
                  fontSize: 12,
                }}
              >
                Analysis pending — open in Lab to begin forensic examination.
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                id={`evidence-detail-analyze-${selectedEvidence.id}`}
                onClick={() => onOpenEvidence(selectedEvidence)}
                style={{
                  flex: 1,
                  padding: '9px',
                  background: 'rgba(98,229,232,0.12)',
                  border: '1px solid rgba(98,229,232,0.3)',
                  borderRadius: 8,
                  color: 'var(--vl-ice-cyan)',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
              >
                Open in Lab
              </button>
              {selectedCase && (
                <button
                  id={`evidence-open-case-${selectedEvidence.id}`}
                  onClick={() => onOpenCase(selectedCase)}
                  style={{
                    flex: 1,
                    padding: '9px',
                    background: 'var(--vl-surface-elevated)',
                    border: '1px solid var(--vl-border)',
                    borderRadius: 8,
                    color: 'var(--vl-text-secondary)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                >
                  View Case
                </button>
              )}
            </div>
          </div>
        )}
      </div>
        </>
      )}
    </div>
    </RoyalPageFrame>
  );
};
