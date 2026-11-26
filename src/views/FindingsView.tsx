import React, { useState } from 'react';
import { AnalysisFinding, FindingSeverity, FindingCategory, EvidenceItem } from '@/types/forensics';
import { SeverityBadge } from '@/components/common/SeverityBadge';
import {
  FileCheck2,
  Filter,
  Plus,
  Trash2,
  AlertCircle,
  HelpCircle,
  Clock,
  Layers,
  Search,
} from 'lucide-react';

interface FindingsViewProps {
  findings: AnalysisFinding[];
  evidenceList: EvidenceItem[];
  onOpenEvidence: (item: EvidenceItem) => void;
  onAddFinding: (finding: Omit<AnalysisFinding, 'id' | 'createdAt'>) => void;
  onDeleteFinding: (id: string) => void;
}

export const FindingsView: React.FC<FindingsViewProps> = ({
  findings,
  evidenceList,
  onOpenEvidence,
  onAddFinding,
  onDeleteFinding,
}) => {
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Form state
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<FindingSeverity>('warning');
  const [category, setCategory] = useState<FindingCategory>('visual_anomaly');
  const [targetEvidenceId, setTargetEvidenceId] = useState(evidenceList[0]?.id || '');
  const [observedEvidence, setObservedEvidence] = useState('');
  const [plainSummary, setPlainSummary] = useState('');
  const [detectionMethod, setDetectionMethod] = useState('Manual Forensic Visual Examination');
  const [limitations, setLimitations] = useState('Subject to display resolution and analyst calibration.');

  const filtered = findings.filter((f) => {
    const matchSev = severityFilter === 'all' || f.severity === severityFilter;
    const matchCat = categoryFilter === 'all' || f.category === categoryFilter;
    const matchSearch =
      f.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (f.plainEnglishSummary || f.simpleExplanation || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.observedEvidence.toLowerCase().includes(searchQuery.toLowerCase());
    return matchSev && matchCat && matchSearch;
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !targetEvidenceId) return;

    const evidence = evidenceList.find((e) => e.id === targetEvidenceId);

    onAddFinding({
      investigationId: evidence?.investigationId || 'inv_01_synthetic_ceo',
      evidenceId: targetEvidenceId,
      title: title.trim(),
      severity,
      category,
      observedEvidence: observedEvidence.trim(),
      plainEnglishSummary: plainSummary.trim(),
      detectionMethod: detectionMethod.trim(),
      limitations: limitations.trim(),
      detectorVersion: 'VexaLens-Analyst-Manual-v1.0',
    });

    setIsModalOpen(false);
    setTitle('');
    setObservedEvidence('');
    setPlainSummary('');
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="text-xs font-mono text-cyan-400">
            WORKSPACE FINDINGS
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 mt-1">
            Evidence Storyboard
          </h1>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-semibold transition-colors shadow-sm self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>Record New Finding</span>
        </button>
      </div>

      {/* Filters and Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 rounded-lg bg-slate-900/60 border border-slate-800">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search findings, observations, or evidence..."
            className="w-full bg-slate-950 border border-slate-800 rounded pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Severity selector */}
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 capitalize"
          >
            <option value="all">All Severities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="nominal">Nominal</option>
            <option value="inconclusive">Inconclusive</option>
          </select>

          {/* Category selector */}
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 capitalize"
          >
            <option value="all">All Categories</option>
            <option value="synthetic_deepfake">Synthetic Deepfake</option>
            <option value="compression">Compression / ELA</option>
            <option value="metadata">Metadata & Software</option>
            <option value="visual_anomaly">Visual Optics</option>
            <option value="audio_signal">Audio Signal</option>
            <option value="provenance">Provenance</option>
          </select>
        </div>
      </div>

      {/* Findings List */}
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="p-12 text-center rounded-lg border border-slate-800 bg-slate-900/40 text-slate-400 text-xs">
            No findings match the selected severity and category filters.
          </div>
        ) : (
          filtered.map((finding) => {
            const ev = evidenceList.find((e) => e.id === finding.evidenceId);
            return (
              <div
                key={finding.id}
                className="p-4 rounded-lg bg-slate-900/50 border border-slate-800 space-y-2 hover:border-slate-700 transition-colors"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <SeverityBadge severity={finding.severity} />
                    <span className="text-slate-600">·</span>
                    <h3 className="text-sm font-semibold text-slate-100">{finding.title}</h3>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span className="font-mono text-cyan-400 text-[11px] uppercase">
                      {finding.category.replace('_', ' ')}
                    </span>
                    <span className="text-slate-600">·</span>
                    <span className="font-mono text-[11px] text-slate-400">
                      {new Date(finding.createdAt).toLocaleDateString()}
                    </span>
                    <button
                      onClick={() => onDeleteFinding(finding.id)}
                      className="text-slate-400 hover:text-rose-400 transition-colors p-1"
                      title="Delete Finding"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="text-xs text-slate-300 leading-relaxed bg-slate-950/60 p-3 rounded space-y-1">
                  <div>
                    <span className="text-slate-400 font-medium">Observed Evidence: </span>
                    <span>{finding.observedEvidence}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 font-medium">Summary: </span>
                    <span>{finding.plainEnglishSummary}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs text-slate-400">
                  <div><span className="text-slate-300 font-medium">What was checked: </span>{finding.detectionMethod || 'Not recorded'}</div>
                  <div><span className="text-slate-300 font-medium">Evidence: </span>{ev ? `${ev.fileName} · ${ev.id}` : 'Linked evidence is unavailable'}</div>
                  {finding.evidenceLocation?.label && <div><span className="text-slate-300 font-medium">Location: </span>{finding.evidenceLocation.label}{finding.evidenceLocation.timestampStart ? ` · ${finding.evidenceLocation.timestampStart}${finding.evidenceLocation.timestampEnd ? `–${finding.evidenceLocation.timestampEnd}` : ''}` : ''}</div>}
                  {finding.methodReliability && <div><span className="text-slate-300 font-medium">Reliability: </span>{finding.methodReliability}</div>}
                  {finding.potentialFalsePositives && <div><span className="text-slate-300 font-medium">Alternative explanations: </span>{finding.potentialFalsePositives}</div>}
                  {(finding.limitations || finding.unresolvedQuestions) && <div><span className="text-slate-300 font-medium">Limitations: </span>{finding.limitations || finding.unresolvedQuestions}</div>}
                  {finding.recommendedNextSteps && <div><span className="text-slate-300 font-medium">Next check: </span>{finding.recommendedNextSteps}</div>}
                  {typeof finding.confidenceScore === 'number' && <div><span className="text-slate-300 font-medium">Recorded confidence score: </span>{finding.confidenceScore}{finding.scoreInterpretation ? ` · ${finding.scoreInterpretation}` : ''}</div>}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-slate-400 font-mono">
                  <div className="flex items-center gap-2 truncate">
                    <span>Target: {ev?.fileName || 'Evidence Artifact'}</span>
                    <span>·</span>
                    <span>Method: {finding.detectionMethod}</span>
                  </div>
                  <div className="text-slate-400">
                    Limitations: {finding.limitations}
                  </div>
                </div>
                {ev && <button type="button" onClick={() => onOpenEvidence(ev)} className="text-cyan-300 underline underline-offset-4">Open linked evidence</button>}
              </div>
            );
          })
        )}
      </div>

      {/* Record Finding Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-lg bg-slate-900 border border-slate-800 shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-100">Record Forensic Finding</h2>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-200">
                ✕
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-3.5 text-xs">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                  Target Evidence File
                </label>
                <select
                  value={targetEvidenceId}
                  onChange={(e) => setTargetEvidenceId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                >
                  {evidenceList.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.fileName} ({e.isOriginal ? 'Baseline' : 'Suspect'})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                    Severity Rating
                  </label>
                  <select
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value as any)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                  >
                    <option value="critical">Critical Indicator</option>
                    <option value="warning">Warning / Anomaly</option>
                    <option value="nominal">Nominal (Clean)</option>
                    <option value="inconclusive">Inconclusive</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                    Category
                  </label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as any)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                  >
                    <option value="synthetic_deepfake">Synthetic Deepfake</option>
                    <option value="compression">Compression / ELA</option>
                    <option value="metadata">Metadata & Software</option>
                    <option value="visual_anomaly">Visual Optics</option>
                    <option value="audio_signal">Audio Signal</option>
                    <option value="provenance">Provenance</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                  Finding Title
                </label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Asymmetric Ocular Corneal Specular Highlights"
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                  Observed Evidence (Technical Measurements)
                </label>
                <textarea
                  rows={2}
                  required
                  value={observedEvidence}
                  onChange={(e) => setObservedEvidence(e.target.value)}
                  placeholder="Describe specific pixels, coordinates, compression block values, or acoustic parameters..."
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                  Plain-English Summary (Court/Juror Comprehension)
                </label>
                <textarea
                  rows={2}
                  required
                  value={plainSummary}
                  onChange={(e) => setPlainSummary(e.target.value)}
                  placeholder="Provide an objective, non-jargon statement explaining what this means..."
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3.5 py-1.5 rounded text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 transition-colors"
                >
                  Commit Finding
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
