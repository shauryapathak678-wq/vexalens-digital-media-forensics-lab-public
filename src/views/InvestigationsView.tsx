import React, { useState } from 'react';
import { Investigation, CasePriority, CaseStatus } from '@/types/forensics';
import { Plus, Search, FolderOpen, Trash2, Check, X, AlertCircle } from 'lucide-react';
import { PriorityBadge, StatusBadge } from '@/components/common/SeverityBadge';

interface InvestigationsViewProps {
  investigations: Investigation[];
  currentCase?: Investigation;
  onSelectCase: (c: Investigation) => void;
  onCreateCase: (data: Omit<Investigation, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  onDeleteCase: (id: string, options?: { retainEvidenceFiles?: boolean }) => Promise<void> | void;
  onUpdateStatus: (id: string, status: CaseStatus) => void;
}

export const InvestigationsView: React.FC<InvestigationsViewProps> = ({
  investigations,
  currentCase,
  onSelectCase,
  onCreateCase,
  onDeleteCase,
  onUpdateStatus,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [retainEvidenceFiles, setRetainEvidenceFiles] = useState(true);

  const [newTitle, setNewTitle] = useState('');
  const [newCaseNumber, setNewCaseNumber] = useState(
    `VL-2026-${Math.floor(1000 + Math.random() * 9000)}`
  );
  const [newDesc, setNewDesc] = useState('');
  const [newPriority, setNewPriority] = useState<CasePriority>('high');
  const [newInvestigator, setNewInvestigator] = useState('Dr. Evelyn Vance');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const filtered = investigations.filter((item) => {
    const matchesSearch =
      item.caseNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || item.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newCaseNumber.trim() || isCreating) return;
    setCreateError('');
    setIsCreating(true);
    try {
      await onCreateCase({
        caseNumber: newCaseNumber.trim(),
        title: newTitle.trim(),
        description: newDesc.trim(),
        userId: 'usr_forensic_01',
        status: 'open',
        priority: newPriority,
        leadInvestigator: newInvestigator.trim(),
        evidenceCount: 0,
        tags: ['New Intake', 'SHA-256 Registered'],
      });
      setIsModalOpen(false);
      setNewTitle('');
      setNewDesc('');
      setNewCaseNumber(`VL-2026-${Math.floor(1000 + Math.random() * 9000)}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not save the investigation.');
    } finally {
      setIsCreating(false);
    }
  };

  const statusColors: Record<string, string> = {
    open: 'var(--vl-ice-cyan)',
    in_progress: 'var(--vl-electric-blue)',
    review: 'var(--vl-warning)',
    closed: 'var(--vl-text-dim)',
  };

  const inputClass = "w-full rounded-lg px-3 py-2 text-xs focus:outline-none transition-colors";
  const inputStyle = {
    background: 'var(--vl-surface-elevated)',
    border: '1px solid var(--vl-border)',
    color: 'var(--vl-text-primary)',
  };
  const labelStyle = {
    color: 'var(--vl-text-dim)',
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    display: 'block',
    marginBottom: '6px',
  };

  return (
    <div
      className="p-5 sm:p-8 max-w-7xl mx-auto space-y-6 pb-16"
      style={{ fontFamily: 'var(--font-sans)' }}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div
            className="text-[11px] font-mono font-semibold uppercase tracking-[0.1em] mb-1"
            style={{ color: 'var(--vl-ice-cyan)' }}
          >
            Case Management
          </div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ color: 'var(--vl-text-primary)', letterSpacing: '-0.02em' }}
          >
            Investigation Dossiers
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--vl-text-secondary)' }}>
            Manage authorized digital evidence dossiers and chain-of-custody case tracking.
          </p>
        </div>
        <button
          id="investigations-new-case"
          onClick={() => setIsModalOpen(true)}
          className="vl-btn-primary self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          New Investigation
        </button>
      </div>

      {/* Search + Filter bar */}
      <div
        className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 rounded-xl"
        style={{
          background: 'var(--vl-surface)',
          border: '1px solid var(--vl-border)',
        }}
      >
        <div className="relative flex-1 max-w-md">
          <Search
            className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--vl-text-dim)' }}
          />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by case number, title, or keyword…"
            className="w-full rounded-lg pl-9 pr-3 py-2 text-xs focus:outline-none"
            style={{
              background: 'var(--vl-surface-elevated)',
              border: '1px solid var(--vl-border)',
              color: 'var(--vl-text-primary)',
            }}
            id="investigations-search-input"
          />
        </div>

        {/* Status pill group */}
        <div
          className="flex items-center rounded-lg overflow-hidden shrink-0"
          style={{
            background: 'var(--vl-surface-elevated)',
            border: '1px solid var(--vl-border)',
          }}
        >
          {['all', 'open', 'in_progress', 'review', 'closed'].map((st) => (
            <button
              key={st}
              id={`investigations-filter-${st}`}
              onClick={() => setStatusFilter(st)}
              className="px-3 py-1.5 text-[11px] font-medium capitalize whitespace-nowrap transition-all duration-150"
              style={{
                background: statusFilter === st ? 'var(--vl-surface)' : 'transparent',
                color: statusFilter === st ? 'var(--vl-text-primary)' : 'var(--vl-text-dim)',
                boxShadow: statusFilter === st ? '0 1px 3px rgba(0,0,0,0.15)' : 'none',
              }}
            >
              {st.replace('_', ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div
        className="overflow-hidden rounded-xl"
        style={{ border: '1px solid var(--vl-border)', background: 'var(--vl-surface)' }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr
                style={{
                  background: 'var(--vl-surface-elevated)',
                  borderBottom: '1px solid var(--vl-border)',
                }}
              >
                {['Case Identifier', 'Status', 'Priority', 'Lead Examiner', 'Evidence', 'Created', 'Actions'].map((h, hi) => (
                  <th
                    key={h}
                    className={`py-3 px-4 text-[10px] font-semibold uppercase tracking-[0.08em] ${hi === 6 ? 'text-right' : ''}`}
                    style={{ color: 'var(--vl-text-dim)' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-14 text-center"
                    style={{ color: 'var(--vl-text-dim)' }}
                  >
                    <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p>No investigations match the current search or filter.</p>
                  </td>
                </tr>
              ) : (
                filtered.map((inv) => {
                  const isCurrent = currentCase?.id === inv.id;
                  return (
                    <tr
                      key={inv.id}
                      style={{ borderBottom: '1px solid var(--vl-border-subtle)' }}
                      onMouseEnter={(e) =>
                        ((e.currentTarget as HTMLElement).style.background = 'var(--vl-surface-elevated)')
                      }
                      onMouseLeave={(e) =>
                        ((e.currentTarget as HTMLElement).style.background = isCurrent ? 'rgba(98,229,232,0.04)' : 'transparent')
                      }
                    >
                      {/* Case Identifier */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2.5">
                          <FolderOpen
                            className="w-4 h-4 shrink-0"
                            style={{ color: isCurrent ? 'var(--vl-ice-cyan)' : 'var(--vl-text-dim)' }}
                          />
                          <div>
                            <div className="flex items-center gap-2">
                              <span
                                className="font-mono font-semibold text-[12px]"
                                style={{ color: isCurrent ? 'var(--vl-ice-cyan)' : 'var(--vl-text-primary)' }}
                              >
                                {inv.caseNumber}
                              </span>
                              {isCurrent && (
                                <span
                                  className="text-[9px] font-semibold px-1.5 py-0.5 rounded font-mono"
                                  style={{
                                    background: 'rgba(98,229,232,0.1)',
                                    color: 'var(--vl-ice-cyan)',
                                    border: '1px solid rgba(98,229,232,0.25)',
                                  }}
                                >
                                  ACTIVE
                                </span>
                              )}
                            </div>
                            <div
                              className="truncate max-w-[200px] text-[11px] mt-0.5"
                              style={{ color: 'var(--vl-text-secondary)' }}
                            >
                              {inv.title}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4">
                        <select
                          value={inv.status}
                          onChange={(e) => onUpdateStatus(inv.id, e.target.value as CaseStatus)}
                          className="rounded-md px-2 py-1 text-[11px] focus:outline-none"
                          style={{
                            background: 'var(--vl-surface-elevated)',
                            border: '1px solid var(--vl-border)',
                            color: statusColors[inv.status] || 'var(--vl-text-secondary)',
                          }}
                        >
                          <option value="open">Open</option>
                          <option value="in_progress">In Progress</option>
                          <option value="review">Review</option>
                          <option value="closed">Closed</option>
                        </select>
                      </td>

                      {/* Priority */}
                      <td className="py-3 px-4">
                        <PriorityBadge priority={inv.priority} />
                      </td>

                      {/* Lead Examiner */}
                      <td className="py-3 px-4 text-[12px]" style={{ color: 'var(--vl-text-secondary)' }}>
                        {inv.leadInvestigator}
                      </td>

                      {/* Evidence Count */}
                      <td className="py-3 px-4 font-mono text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
                        {inv.evidenceCount || 0} items
                      </td>

                      {/* Created */}
                      <td className="py-3 px-4 font-mono text-[11px]" style={{ color: 'var(--vl-text-dim)' }}>
                        {new Date(inv.createdAt).toLocaleDateString()}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => onSelectCase(inv)}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-150"
                            style={{
                              background: isCurrent ? 'rgba(98,229,232,0.1)' : 'var(--vl-surface-elevated)',
                              border: '1px solid',
                              borderColor: isCurrent ? 'rgba(98,229,232,0.3)' : 'var(--vl-border)',
                              color: isCurrent ? 'var(--vl-ice-cyan)' : 'var(--vl-text-secondary)',
                            }}
                          >
                            {isCurrent ? (
                              <span className="flex items-center gap-1">
                                <Check className="w-3 h-3" /> Active
                              </span>
                            ) : 'Set Active'}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(inv.id)}
                            className="p-1.5 rounded-lg transition-colors"
                            style={{ color: 'var(--vl-text-dim)' }}
                            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--vl-critical)')}
                            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--vl-text-dim)')}
                            title="Delete investigation"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDeleteId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-6 space-y-4"
            style={{ background: 'var(--vl-surface)', border: '1px solid var(--vl-border)', boxShadow: '0 24px 48px rgba(0,0,0,0.4)' }}
          >
            <div className="flex items-center gap-2.5">
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
                style={{ background: 'rgba(255,102,122,0.12)', border: '1px solid rgba(255,102,122,0.25)' }}
              >
                <AlertCircle className="w-4 h-4" style={{ color: 'var(--vl-critical)' }} />
              </div>
              <div>
                <h3 className="text-sm font-semibold" style={{ color: 'var(--vl-text-primary)' }}>Delete Investigation</h3>
                <p className="text-xs" style={{ color: 'var(--vl-text-secondary)' }}>This action cannot be undone.</p>
              </div>
            </div>
            <p className="text-xs" style={{ color: 'var(--vl-text-secondary)' }}>
              Are you sure you want to delete case{' '}
              <strong style={{ color: 'var(--vl-text-primary)' }}>
                {investigations.find(i => i.id === confirmDeleteId)?.caseNumber}
              </strong>?
            </p>

            {/* Statutory Reports Survival Notice */}
            <div className="p-3 rounded-lg border border-cyan-800/60 bg-cyan-950/30 text-[11px] text-cyan-200 space-y-1">
              <div className="font-bold text-cyan-100 flex items-center gap-1.5">
                Statutory Audit Retention:
              </div>
              <p className="leading-relaxed">
                All generated reports for this case will remain permanently archived in the <b>Reports Repository</b> and independently verifiable under ISO/IEC 27037 standards.
              </p>
            </div>

            {/* Evidence File Retention Option */}
            <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={retainEvidenceFiles}
                onChange={(e) => setRetainEvidenceFiles(e.target.checked)}
                className="rounded border-slate-700 text-cyan-500 focus:ring-0 mt-0.5"
              />
              <span>
                Retain original evidence files in secure storage vault (uncheck to purge original media according to retention schedule).
              </span>
            </label>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="flex-1 vl-btn-secondary justify-center"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!confirmDeleteId) return;
                  try {
                    await onDeleteCase(confirmDeleteId, { retainEvidenceFiles });
                    setConfirmDeleteId(null);
                  } catch (error) {
                    window.alert(error instanceof Error ? error.message : 'The case could not be deleted.');
                  }
                }}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all"
                style={{
                  background: 'rgba(255,102,122,0.15)',
                  border: '1px solid rgba(255,102,122,0.35)',
                  color: 'var(--vl-critical)',
                }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Investigation Modal */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
        >
          <div
            className="w-full max-w-lg rounded-2xl shadow-2xl"
            style={{ background: 'var(--vl-surface)', border: '1px solid var(--vl-border)' }}
          >
            {/* Modal header */}
            <div
              className="flex items-center justify-between px-6 py-4"
              style={{ borderBottom: '1px solid var(--vl-border)' }}
            >
              <div>
                <h2 className="text-base font-bold" style={{ color: 'var(--vl-text-primary)' }}>
                  Open New Forensic Investigation
                </h2>
                <p className="text-[11px]" style={{ color: 'var(--vl-text-secondary)' }}>
                  Initialize a chain-of-custody evidence dossier.
                </p>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--vl-text-dim)' }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="p-6 space-y-4">
              {createError && (
                <p role="alert" className="rounded-lg border border-red-700/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">
                  {createError}
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label style={labelStyle}>Case Number</label>
                  <input
                    type="text"
                    required
                    value={newCaseNumber}
                    onChange={(e) => setNewCaseNumber(e.target.value)}
                    className={`${inputClass} font-mono`}
                    style={inputStyle}
                    id="modal-case-number"
                  />
                </div>
                <div>
                  <label style={labelStyle}>Priority</label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value as CasePriority)}
                    className={inputClass}
                    style={inputStyle}
                    id="modal-priority"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
              </div>

              <div>
                <label style={labelStyle}>Case Title</label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Altered Financial Ledger Scan Examination"
                  className={inputClass}
                  style={inputStyle}
                  id="modal-case-title"
                />
              </div>

              <div>
                <label style={labelStyle}>Case Description & Forensic Scope</label>
                <textarea
                  rows={3}
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="State the objective, chain-of-custody origin, and suspect artifacts…"
                  className={`${inputClass} resize-none`}
                  style={inputStyle}
                  id="modal-case-desc"
                />
              </div>

              <div>
                <label style={labelStyle}>Lead Examiner</label>
                <input
                  type="text"
                  value={newInvestigator}
                  onChange={(e) => setNewInvestigator(e.target.value)}
                  className={inputClass}
                  style={inputStyle}
                  id="modal-lead-examiner"
                />
              </div>

              <div
                className="flex items-center justify-end gap-3 pt-2"
                style={{ borderTop: '1px solid var(--vl-border)' }}
              >
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="vl-btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="vl-btn-primary disabled:opacity-50"
                  id="modal-submit-investigation"
                >
                  <Plus className="w-4 h-4" />
                  {isCreating ? 'Saving to database…' : 'Initialize Investigation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
