import { useState } from 'react';
import { Activity, AlertCircle, GitBranch, Loader2, Search, ShieldCheck, Video } from 'lucide-react';
import {
  analyzeVideoGenealogy,
  VIDEO_GENEALOGY_MAX_MEDIA_COUNT,
  VIDEO_GENEALOGY_MAX_VIDEO_BYTES,
  type VideoGenealogyResult,
} from '@/lib/forensics/videoGenealogy';

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${remaining.toString().padStart(2, '0')}`;
}

function getFileLabel(result: VideoGenealogyResult, mediaId: string): string {
  return result.files.find((file) => file.id === mediaId)?.label ||
    result.local_database_matches.find((file) => file.id === mediaId)?.label ||
    mediaId;
}

export function VideoMutationTreePanel() {
  const [reference, setReference] = useState<File | null>(null);
  const [candidates, setCandidates] = useState<File[]>([]);
  const [hashBits, setHashBits] = useState<64 | 256 | 1024>(256);
  const [searchQuery, setSearchQuery] = useState('');
  const [customSourceText, setCustomSourceText] = useState('');
  const [onlineSearch, setOnlineSearch] = useState(false);
  const [result, setResult] = useState<VideoGenealogyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const chooseReference = (file: File | null) => {
    setReference(file);
    setResult(null);
    setError(null);
  };

  const chooseCandidates = (files: File[]) => {
    setCandidates(files.slice(0, VIDEO_GENEALOGY_MAX_MEDIA_COUNT - 1));
    setResult(null);
    setError(null);
  };

  const runAnalysis = async () => {
    if (!reference) {
      setError('Choose a reference video first.');
      return;
    }
    setIsAnalyzing(true);
    setResult(null);
    setError(null);
    try {
      setResult(await analyzeVideoGenealogy({
        reference,
        candidates,
        hashBits,
        onlineSearch,
        searchQuery,
        customSourceLinks: customSourceText.split(/\r?\n/),
      }));
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : 'Video-genealogy analysis failed.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="rounded-xl border border-violet-800/50 bg-violet-950/40 p-2 text-violet-300">
          <GitBranch className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-100">Video Mutation Tree</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-400">
            Compare a reference with locally supplied versions using dense visual and audio fingerprints.
            The database stores hashes and analysis metadata, not video files.
          </p>
        </div>
      </div>

      <div className="vl-surface grid gap-5 p-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="genealogy-reference" className="block text-xs font-medium text-slate-300">
              Reference video (AVI, M4V, MKV, MOV, MP4, or WebM; up to 128 MiB)
            </label>
            <input
              id="genealogy-reference"
              type="file"
              accept="video/*,.avi,.m4v,.mkv,.mov,.mp4,.webm"
              disabled={isAnalyzing}
              onChange={(event) => chooseReference(event.target.files?.[0] || null)}
              className="block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border file:border-slate-700 file:bg-slate-900 file:px-3 file:py-2 file:text-xs file:text-slate-200 hover:file:border-violet-700"
            />
            <p className="text-[11px] text-slate-500">
              {reference ? `${reference.name} (${formatBytes(reference.size)})` : 'The selected reference is the display-tree root.'}
              {reference && reference.size > VIDEO_GENEALOGY_MAX_VIDEO_BYTES && ' This file exceeds the per-video limit.'}
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="genealogy-candidates" className="block text-xs font-medium text-slate-300">
              Candidate videos (up to four; downloaded or collected by you)
            </label>
            <input
              id="genealogy-candidates"
              type="file"
              multiple
              accept="video/*,.avi,.m4v,.mkv,.mov,.mp4,.webm"
              disabled={isAnalyzing}
              onChange={(event) => chooseCandidates(Array.from(event.target.files || []))}
              className="block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border file:border-slate-700 file:bg-slate-900 file:px-3 file:py-2 file:text-xs file:text-slate-200 hover:file:border-violet-700"
            />
            <p className="text-[11px] text-slate-500">
              {candidates.length
                ? `${candidates.length} candidate${candidates.length === 1 ? '' : 's'} selected.`
                : 'Online search returns links only; candidate media is never downloaded automatically.'}
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="genealogy-hash-bits" className="block text-xs font-medium text-slate-300">
              Perceptual fingerprint size
            </label>
            <select
              id="genealogy-hash-bits"
              value={hashBits}
              disabled={isAnalyzing}
              onChange={(event) => setHashBits(Number(event.target.value) as 64 | 256 | 1024)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200"
            >
              <option value={64}>64-bit (fastest)</option>
              <option value={256}>256-bit (recommended)</option>
              <option value={1024}>1024-bit (more detail, slower)</option>
            </select>
            <p className="text-[11px] text-slate-500">Visual samples are taken about once per second; audio windows overlap.</p>
          </div>

          <div className="space-y-2">
            <label htmlFor="genealogy-search-query" className="block text-xs font-medium text-slate-300">
              Optional online text-search phrase
            </label>
            <input
              id="genealogy-search-query"
              type="text"
              maxLength={200}
              value={searchQuery}
              disabled={isAnalyzing}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Example: interview location or quoted headline"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
            />
            <label className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-400">
              <input
                type="checkbox"
                checked={onlineSearch}
                disabled={isAnalyzing}
                onChange={(event) => setOnlineSearch(event.target.checked)}
                className="mt-0.5 accent-violet-500"
              />
              Search online using this text. Only the phrase is sent to YouTube; no video, frame, or hash is uploaded.
            </label>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label htmlFor="genealogy-custom-sources" className="block text-xs font-medium text-slate-300">
              Optional custom source links (one HTTPS URL per line)
            </label>
            <textarea
              id="genealogy-custom-sources"
              rows={2}
              maxLength={20000}
              value={customSourceText}
              disabled={isAnalyzing}
              onChange={(event) => setCustomSourceText(event.target.value)}
              placeholder="Paste candidate links from social media, news sites, or reverse-search services"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
            />
            <p className="text-[11px] text-slate-500">Links are recorded and displayed only. VexaLens does not visit them or download their media.</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void runAnalysis()}
          disabled={isAnalyzing}
          className="vl-btn-primary inline-flex items-center justify-center gap-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isAnalyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
          {isAnalyzing ? 'Fingerprinting locally…' : 'Build mutation tree'}
        </button>
      </div>

      {candidates.length > 4 && (
        <div role="alert" className="rounded-lg border border-amber-900/70 bg-amber-950/30 p-3 text-xs text-amber-200">
          Only the first four candidate videos will be analyzed.
        </div>
      )}

      {isAnalyzing && (
        <div className="flex items-center gap-2 rounded-lg border border-violet-900/60 bg-violet-950/25 p-3 text-xs text-violet-200">
          <Loader2 className="h-4 w-4 animate-spin" />
          Building dense fingerprints. Longer videos and larger hashes need more processing time.
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-900/70 bg-rose-950/30 p-3 text-xs text-rose-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <div className="vl-surface flex flex-wrap items-start justify-between gap-3 p-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-violet-300">Local analysis saved</p>
              <p className="mt-1 text-xs text-slate-300">
                Analysis {result.analysis_id} · {result.hash_bits}-bit · {result.hash_backend}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                SQLite stores fingerprints, hashes, comparisons, and the audit record. Temporary uploads are removed after analysis.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-emerald-300">
              <ShieldCheck className="h-4 w-4" />
              All {result.files.length} file-copy hashes matched
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {result.files.map((file) => (
              <div key={file.id} className="vl-surface space-y-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="break-all text-xs font-semibold text-slate-200">{file.label}</p>
                  <span className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
                    {file.video.width}×{file.video.height}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">
                  {formatDuration(file.video.duration_seconds)} · {file.video.fps} fps · {file.video.sample_count} visual samples · {file.audio.sample_count} audio samples
                </p>
                <p className="break-all font-mono text-[10px] text-slate-500">SHA-256 {file.sha256}</p>
                <p className="text-[10px] text-slate-500">
                  Audio: {file.audio.status} — {file.audio.message}
                </p>
              </div>
            ))}
          </div>

          {result.local_database_matches.length > 0 && (
            <div className="vl-surface space-y-2 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300">
                Near-duplicates found in the local database ({result.local_database_matches.length})
              </p>
              {result.local_database_matches.map((match) => (
                <p key={match.id} className="break-all text-[11px] text-slate-400">
                  {match.label} · match strength {match.match_confidence}/100 · SHA-256 {match.sha256}
                </p>
              ))}
            </div>
          )}

          <div className="vl-surface space-y-3 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-200">
              <GitBranch className="h-4 w-4 text-violet-400" />
              Similarity tree (reference-rooted, not chronological)
            </div>
            {result.clusters.map((cluster) => (
              <div key={cluster.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-xs font-semibold text-slate-200">
                  {cluster.id}: {getFileLabel(result, cluster.anchor_id)}
                  {cluster.anchor_id === result.root_id ? ' (selected reference)' : ' (separate candidate group)'}
                </p>
                {cluster.tree_edges.length === 0 ? (
                  <p className="mt-2 text-[11px] text-slate-500">No pair in this group reached the 60/100 match threshold.</p>
                ) : (
                  <div className="mt-2 space-y-2">
                    {cluster.tree_edges.map((edge) => (
                      <div key={`${edge.source_id}-${edge.target_id}`} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="max-w-[35%] truncate text-slate-300" title={getFileLabel(result, edge.source_id)}>
                          {getFileLabel(result, edge.source_id)}
                        </span>
                        <span aria-hidden="true" className="text-violet-300">→</span>
                        <span className="max-w-[35%] truncate text-slate-300" title={getFileLabel(result, edge.target_id)}>
                          {getFileLabel(result, edge.target_id)}
                        </span>
                        <span className="rounded border border-violet-900/70 bg-violet-950/40 px-2 py-1 text-[10px] text-violet-200">
                          Match strength {edge.match_confidence}/100
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <p className="text-[11px] leading-relaxed text-amber-300/90">
              Edge scores describe measured similarity, not statistical probability. A perceptual match cannot prove that one file was edited from another or establish which came first.
            </p>
          </div>

          <div className="vl-surface space-y-3 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-200">
              <Activity className="h-4 w-4 text-cyan-400" />
              Pairwise measurements
            </div>
            {result.comparisons.length === 0 ? (
              <p className="text-xs text-slate-400">Add candidate videos to compare versions.</p>
            ) : result.comparisons.map((comparison) => (
              <div key={`${comparison.first_id}-${comparison.second_id}`} className="rounded border border-slate-800 p-3 text-[11px] text-slate-400">
                <p className="text-slate-200">
                  {getFileLabel(result, comparison.first_id)} ↔ {getFileLabel(result, comparison.second_id)}
                  <span className="ml-2 text-violet-300">Match strength {comparison.match_confidence}/100</span>
                </p>
                <p className="mt-1">
                  Visual {comparison.visual_similarity}/100 · Audio {comparison.audio_similarity === null ? 'not compared' : `${comparison.audio_similarity}/100`} · {comparison.matched_visual_samples} ordered visual matches
                </p>
                <p className="mt-1">{comparison.scoring_method}</p>
                <p className="mt-1">{comparison.quality_signals.interpretation}</p>
              </div>
            ))}
          </div>

          {result.search.status !== 'not_requested' && (
            <div className="vl-surface space-y-3 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-200">
                <Search className="h-4 w-4 text-cyan-400" />
                Link-only online discovery
              </div>
              {result.search.query && (
                <p className="text-[11px] leading-relaxed text-slate-400">
                  Search phrase: “{result.search.query}”. Text search cannot match a video perceptual hash; verify every result manually.
                </p>
              )}
              {result.search.youtube.status === 'failed' && (
                <p role="status" className="text-[11px] text-amber-300">
                  YouTube search: {result.search.youtube.message || 'No metadata results were returned.'}
                </p>
              )}
              {result.search.youtube.candidates.map((candidate) => (
                <a
                  key={candidate.url}
                  href={candidate.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded border border-slate-800 p-3 text-xs hover:border-cyan-700"
                >
                  <span className="text-cyan-200">{candidate.title}</span>
                  <span className="ml-2 text-slate-500">{candidate.channel}</span>
                  {candidate.duration_seconds !== null && (
                    <span className="ml-2 text-slate-500">{formatDuration(candidate.duration_seconds)}</span>
                  )}
                </a>
              ))}
              <div className="flex flex-wrap gap-2">
                {[...result.search.search_links, ...result.search.custom_links].map((link) => (
                  <a
                    key={`${link.provider}-${link.url}`}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300 hover:border-cyan-700"
                  >
                    <Search className="h-3 w-3" />
                    Open {link.provider} search
                  </a>
                ))}
              </div>
            </div>
          )}

          <ul className="list-disc space-y-1 pl-5 text-[10px] leading-relaxed text-slate-500">
            {result.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
