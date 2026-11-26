import React, { useMemo, useState } from 'react';
import {
  Investigation,
  EvidenceItem,
  AnalysisFinding,
  ProvenanceEvent,
} from '@/types/forensics';
import { SeverityBadge } from '@/components/common/SeverityBadge';
import { formatShortHash } from '@/lib/forensics/crypto';
import {
  Share2,
  FileWarning,
  Link2,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Image as ImageIcon,
  Video,
  Music,
  FileText,
  ShieldCheck,
} from 'lucide-react';

interface CaseRelationshipViewProps {
  investigations: Investigation[];
  currentCase?: Investigation;
  evidenceList: EvidenceItem[];
  findings: AnalysisFinding[];
  provenanceEvents: ProvenanceEvent[];
  onSelectEvidence: (item: EvidenceItem) => void;
  onOpenEvidence: (item: EvidenceItem) => void;
}

const MEDIA_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
};

interface FileLink {
  evidence: EvidenceItem;
  findings: AnalysisFinding[];
  provenance: ProvenanceEvent[];
  hasValidHash: boolean;
  verifiedIntake: boolean;
  incompleteChecks: string[];
}

export const CaseRelationshipView: React.FC<CaseRelationshipViewProps> = ({
  investigations,
  currentCase,
  evidenceList,
  findings,
  provenanceEvents,
  onSelectEvidence,
  onOpenEvidence,
}) => {
  const [selectedCaseId, setSelectedCaseId] = useState(currentCase?.id || investigations[0]?.id || '');
  const activeCase = investigations.find((c) => c.id === selectedCaseId) || currentCase;

  const fileLinks: FileLink[] = useMemo(() => {
    if (!activeCase) return [];
    const caseEvidence = evidenceList.filter((item) => item.investigationId === activeCase.id);
    return caseEvidence.map((evidence) => {
      const evFindings = findings.filter((f) => f.evidenceId === evidence.id);
      const evProvenance = provenanceEvents.filter((p) => p.evidenceId === evidence.id);
      const hasValidHash = /^[a-f\d]{64}$/i.test(evidence.sha256Hash);
      const verifiedIntake = evProvenance.some((p) => p.verifiedMatch);
      const incompleteChecks: string[] = [];
      if (evFindings.length === 0) incompleteChecks.push('No findings recorded for this file yet.');
      if (!hasValidHash) incompleteChecks.push('No valid SHA-256 integrity digest is recorded.');
      if (!verifiedIntake) incompleteChecks.push('Not checked against a trusted reference digest.');
      return { evidence, findings: evFindings, provenance: evProvenance, hasValidHash, verifiedIntake, incompleteChecks };
    });
  }, [activeCase, evidenceList, findings, provenanceEvents]);

  // Derived, clearly-labelled review prompts. These are NOT conclusions and do
  // not assert that files depict the same event or that any file is manipulated.
  const tensionPrompts = useMemo(() => {
    const prompts: Array<{ evidence: EvidenceItem; note: string }> = [];
    for (const link of fileLinks) {
      const severities = new Set(link.findings.map((f) => f.severity));
      const hasElevated = link.findings.some((f) => f.severity === 'critical' || f.severity === 'warning');
      if (hasElevated && severities.has('nominal')) {
        prompts.push({
          evidence: link.evidence,
          note: 'This file has both elevated-severity and nominal findings recorded. Reconcile them before drawing a conclusion.',
        });
      }
    }
    return prompts;
  }, [fileLinks]);

  const totalFindings = fileLinks.reduce((sum, link) => sum + link.findings.length, 0);
  const filesWithIncompleteChecks = fileLinks.filter((link) => link.incompleteChecks.length > 0).length;

  if (investigations.length === 0) {
    return (
      <div className="p-12 max-w-3xl mx-auto text-center border border-slate-800 rounded-xl bg-slate-900/40">
        <Share2 className="w-10 h-10 text-slate-600 mx-auto mb-3" />
        <h2 className="text-lg font-semibold text-slate-200">No investigations to relate</h2>
        <p className="text-xs text-slate-400 mt-2">Create an investigation and add evidence to build a case relationship view.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="text-xs font-mono text-cyan-400">CROSS-MEDIA CASE RELATIONSHIPS</div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 mt-1">Case Relationship View</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Shows which files belong to a case and which findings and observations relate to each. Relationships come
            only from recorded associations — no causal links are inferred.
          </p>
        </div>
        <select
          value={selectedCaseId}
          onChange={(e) => setSelectedCaseId(e.target.value)}
          className="bg-slate-900 border border-slate-800 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
        >
          {investigations.map((inv) => (
            <option key={inv.id} value={inv.id}>
              {inv.caseNumber} · {inv.title}
            </option>
          ))}
        </select>
      </div>

      {activeCase && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
          <div className="p-3 rounded bg-slate-900/60 border border-slate-800">
            <div className="text-slate-400 font-sans text-[11px]">Associated files</div>
            <div className="text-lg font-bold text-slate-100">{fileLinks.length}</div>
          </div>
          <div className="p-3 rounded bg-slate-900/60 border border-slate-800">
            <div className="text-slate-400 font-sans text-[11px]">Recorded findings</div>
            <div className="text-lg font-bold text-slate-100">{totalFindings}</div>
          </div>
          <div className="p-3 rounded bg-slate-900/60 border border-slate-800">
            <div className="text-slate-400 font-sans text-[11px]">Files with incomplete checks</div>
            <div className="text-lg font-bold text-amber-300">{filesWithIncompleteChecks}</div>
          </div>
          <div className="p-3 rounded bg-slate-900/60 border border-slate-800">
            <div className="text-slate-400 font-sans text-[11px]">Review prompts</div>
            <div className="text-lg font-bold text-amber-200">{tensionPrompts.length}</div>
          </div>
        </div>
      )}

      {tensionPrompts.length > 0 && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-200">
            <AlertTriangle className="w-4 h-4" /> Review prompts (not conclusions)
          </div>
          {tensionPrompts.map((prompt) => (
            <div key={prompt.evidence.id} className="text-xs text-amber-100/90">
              <span className="font-medium">{prompt.evidence.fileName}:</span> {prompt.note}
            </div>
          ))}
        </div>
      )}

      {fileLinks.length === 0 ? (
        <div className="p-10 text-center border border-dashed border-slate-800 rounded-lg bg-slate-900/30 text-xs text-slate-400">
          No evidence is associated with this case yet. Upload files in Evidence Intake to populate this view.
        </div>
      ) : (
        <div className="space-y-4">
          {fileLinks.map((link) => {
            const Icon = MEDIA_ICON[link.evidence.mediaType] || FileText;
            return (
              <div key={link.evidence.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-9 h-9 rounded bg-slate-950 border border-slate-800 flex items-center justify-center text-cyan-400 shrink-0">
                      <Icon className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-100 truncate">{link.evidence.fileName}</div>
                      <div className="text-[11px] font-mono text-slate-500 truncate">
                        {link.evidence.mediaType.toUpperCase()} · {formatShortHash(link.evidence.sha256Hash, 8, 8)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-mono ${link.hasValidHash ? 'text-emerald-300 border-emerald-800/70 bg-emerald-950/30' : 'text-amber-300 border-amber-800/70 bg-amber-950/30'}`}>
                      <ShieldCheck className="w-3 h-3" /> {link.hasValidHash ? 'Hash recorded' : 'Hash missing'}
                    </span>
                    <button
                      onClick={() => {
                        onSelectEvidence(link.evidence);
                        onOpenEvidence(link.evidence);
                      }}
                      className="text-[11px] text-cyan-300 hover:text-cyan-200"
                    >
                      Open evidence →
                    </button>
                  </div>
                </div>

                {/* Findings for this file */}
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                    <Link2 className="w-3 h-3" /> Findings relating to this file
                  </div>
                  {link.findings.length === 0 ? (
                    <div className="text-xs text-slate-500 flex items-center gap-1.5">
                      <HelpCircle className="w-3.5 h-3.5" /> No findings recorded for this file.
                    </div>
                  ) : (
                    link.findings.map((finding) => (
                      <div key={finding.id} className="flex items-start gap-2 text-xs text-slate-300 bg-slate-950/60 rounded p-2.5">
                        <SeverityBadge severity={finding.severity} />
                        <div className="min-w-0">
                          <div className="text-slate-200">{finding.title}</div>
                          <div className="text-slate-500">
                            {finding.detectionMethod || 'Method not recorded'}
                            {finding.evidenceLocation?.label ? ` · ${finding.evidenceLocation.label}` : ''}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Provenance */}
                <div className="space-y-1">
                  <div className="text-[11px] uppercase tracking-wider text-slate-500">
                    Provenance events ({link.provenance.length})
                  </div>
                  {link.provenance.length === 0 ? (
                    <div className="text-xs text-slate-500">No provenance events recorded.</div>
                  ) : (
                    <ul className="space-y-1">
                      {link.provenance.slice(0, 5).map((event) => (
                        <li key={event.id} className="text-xs text-slate-400 flex items-center gap-2">
                          <span className="font-mono text-cyan-300/80">{event.actionType.replace(/_/g, ' ')}</span>
                          <span>·</span>
                          <span>{new Date(event.timestamp).toLocaleString()}</span>
                          {event.verifiedMatch ? (
                            <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="w-3 h-3" /> verified</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-slate-500">unverified</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {link.incompleteChecks.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-amber-200/90 bg-slate-950/60 rounded p-2.5">
                    <div className="sm:col-span-2 text-[11px] uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                      <FileWarning className="w-3 h-3" /> Checks remaining
                    </div>
                    {link.incompleteChecks.map((check) => (
                      <div key={check}>• {check}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="p-3.5 rounded bg-slate-950/60 border border-slate-800 text-[11px] text-slate-400 leading-relaxed">
        Two files are shown as related only when they are associated with the same investigation or when a recorded
        finding references them. VexaLens does not claim that two media files depict the same event, and a shared case
        association is not evidence of common origin.
      </div>
    </div>
  );
};
