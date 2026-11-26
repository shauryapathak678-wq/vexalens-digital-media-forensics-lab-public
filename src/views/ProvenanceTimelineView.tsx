import React, { useState } from 'react';
import { ProvenanceEvent, EvidenceItem } from '@/types/forensics';
import {
  Clock,
  CheckCircle2,
  AlertCircle,
  Plus,
  ShieldCheck,
  FileCheck2,
  User,
  Hash,
} from 'lucide-react';
import { formatShortHash } from '@/lib/forensics/crypto';

interface ProvenanceTimelineViewProps {
  evidenceList: EvidenceItem[];
  provenanceEvents: ProvenanceEvent[];
  onAddEvent: (event: Omit<ProvenanceEvent, 'id' | 'timestamp'>) => void;
}

export const ProvenanceTimelineView: React.FC<ProvenanceTimelineViewProps> = ({
  evidenceList,
  provenanceEvents,
  onAddEvent,
}) => {
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>(
    evidenceList[0]?.id || ''
  );
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Modal form state
  const [actionType, setActionType] = useState<ProvenanceEvent['actionType']>('custody_transfer');
  const [actorName, setActorName] = useState('Local analyst');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceUrlError, setSourceUrlError] = useState('');
  const [notes, setNotes] = useState('Operator-entered event; external supporting records were not independently validated.');

  const currentEvidence = evidenceList.find((e) => e.id === selectedEvidenceId) || evidenceList[0];
  const filteredEvents = provenanceEvents.filter(
    (e) => !selectedEvidenceId || e.evidenceId === selectedEvidenceId
  );

  const handleCreateEvent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentEvidence) return;
    const trimmedSourceUrl = sourceUrl.trim();
    if (trimmedSourceUrl) {
      try {
        const parsed = new URL(trimmedSourceUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported URL scheme');
      } catch {
        setSourceUrlError('Enter a valid http or https URL.');
        return;
      }
    }

    onAddEvent({
      evidenceId: currentEvidence.id,
      investigationId: currentEvidence.investigationId,
      actionType,
      actor: actorName.trim(),
      recordedSha256: currentEvidence.sha256Hash,
      verifiedMatch: false,
      sourceUrl: trimmedSourceUrl || undefined,
      sourceStatus: trimmedSourceUrl ? 'unverified' : 'not_applicable',
      notes: notes.trim(),
    });

    setIsModalOpen(false);
    setSourceUrl('');
    setSourceUrlError('');
    setNotes('Operator-entered event; external supporting records were not independently validated.');
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="text-xs font-mono text-cyan-400">
            CHAIN OF CUSTODY & EVIDENCE CHRONOLOGY
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 mt-1">
            Provenance Timeline & Cryptographic Custody Ledger
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={selectedEvidenceId}
            onChange={(e) => setSelectedEvidenceId(e.target.value)}
            className="bg-slate-900 border border-slate-800 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
          >
            {evidenceList.map((item) => (
              <option key={item.id} value={item.id}>
                {item.fileName} ({item.isOriginal ? 'Baseline' : 'Suspect'})
              </option>
            ))}
          </select>

          <button
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-semibold transition-colors whitespace-nowrap shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Log Custody Event</span>
          </button>
        </div>
      </div>

      {/* Target Evidence Summary Card */}
      {currentEvidence && (
        <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-xs font-mono">
          <div className="space-y-1">
            <div className="text-[11px] font-sans text-slate-400 font-medium">Selected Evidence Artifact:</div>
            <div className="text-sm font-semibold text-slate-200 font-sans">{currentEvidence.fileName}</div>
            <div className="text-slate-400">
              SHA-256 Digest: <span className="text-cyan-400">{currentEvidence.sha256Hash}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto bg-slate-950 px-3 py-1.5 rounded border border-slate-800 font-sans text-amber-300">
            <ShieldCheck className="w-4 h-4 text-amber-300" />
            <span>Local log · not independently verified</span>
          </div>
        </div>
      )}

      {/* Source verification capability status */}
      <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 space-y-2">
        <div className="text-xs font-semibold text-slate-200 flex items-center gap-2">
          <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" /> Source &amp; provenance checks
        </div>
        <ul className="space-y-1 text-[11px] text-slate-400">
          <li>
            <span className="text-amber-300">Unavailable in this build:</span> reverse-image search is not configured, so
            no internet search has been performed. Do not treat a missing web match as evidence of forgery.
          </li>
          <li>
            <span className="text-amber-300">Unavailable in this build:</span> Content Credentials (C2PA) and digital
            signature verification are not configured. An absent credential is not proof of manipulation.
          </li>
          <li>
            <span className="text-emerald-300">Available locally:</span> file metadata inspection, SHA-256 computation, and
            original-versus-suspect comparison of the recorded digests.
          </li>
        </ul>
      </div>

      {/* Timeline Events List */}
      <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-3 before:bottom-3 before:w-0.5 before:bg-slate-800">
        {filteredEvents.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-xs">
            No custody events recorded for this artifact yet.
          </div>
        ) : (
          filteredEvents.map((evt) => (
            <div key={evt.id} className="relative group">
              {/* Dot marker */}
              <div className="absolute -left-[19px] top-1.5 w-3.5 h-3.5 rounded-full bg-slate-950 border-2 border-cyan-400 flex items-center justify-center" />

              <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 space-y-2 hover:border-slate-700 transition-colors">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-cyan-300 uppercase">
                      {evt.actionType.replace(/_/g, ' ')}
                    </span>
                    <span className="text-slate-500">·</span>
                    <span className="text-slate-300 flex items-center gap-1">
                      <User className="w-3 h-3 text-slate-400" />
                      {evt.actor}
                    </span>
                  </div>

                  <span className="text-slate-400 font-mono text-[11px] flex items-center gap-1">
                    <Clock className="w-3 h-3 text-slate-400" />
                    {new Date(evt.timestamp).toLocaleString()}
                  </span>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed">{evt.notes}</p>
                {evt.sourceUrl && <p className="text-xs"><span className="text-slate-400">Source lead (unverified): </span><a href={evt.sourceUrl} target="_blank" rel="noreferrer" className="text-cyan-300 underline break-all">{evt.sourceUrl}</a></p>}

                <div className="flex items-center justify-between pt-1 border-t border-slate-800/80 text-[11px] font-mono text-slate-400">
                  <div className="flex items-center gap-1 truncate max-w-md">
                    <Hash className="w-3 h-3 text-slate-400 shrink-0" />
                    <span className="truncate">{evt.recordedSha256}</span>
                  </div>

                  <div className={`flex items-center gap-1 shrink-0 ${evt.verifiedMatch ? 'text-emerald-400' : 'text-amber-300'}`}>
                    {evt.verifiedMatch ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                    <span>{evt.verifiedMatch ? 'Trusted reference matched' : 'Not checked against trusted reference'}</span>
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Log Custody Event Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg bg-slate-900 border border-slate-800 shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-100">Log Chain of Custody Event</h2>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-200">
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateEvent} className="space-y-4">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                  Action Type
                </label>
                <select
                  value={actionType}
                  onChange={(e) => setActionType(e.target.value as any)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 capitalize"
                >
                  <option value="custody_transfer">Custody Transfer</option>
                  <option value="hashing">Record file hash</option>
                  <option value="metadata_check">Metadata Header Audit</option>
                  <option value="ela_scan">ELA Forensic Scan</option>
                  <option value="ai_deepfake_audit">AI detector status check</option>
                  <option value="report_generated">Report export</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                  Source URL (unverified lead)
                </label>
                <input type="url" value={sourceUrl} onChange={(event) => { setSourceUrl(event.target.value); setSourceUrlError(''); }} placeholder="https://example.org/source" className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500" />
                {sourceUrlError && <p role="alert" className="text-xs text-rose-300">{sourceUrlError}</p>}
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                  Actor / Examiner Name & Agency
                </label>
                <input
                  type="text"
                  required
                  value={actorName}
                  onChange={(e) => setActorName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                  Custody Notes & Disposition
                </label>
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Record physical or digital handling details, transfer receipt number, or storage vault location..."
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3.5 py-1.5 rounded text-xs text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 transition-colors"
                >
                  Commit Event
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
