import React, { useState, useMemo, useEffect } from 'react';
import {
  Investigation,
  EvidenceItem,
  ActivityLog,
  UserProfile,
  CaseStatus,
} from '@/types/forensics';
import {
  Search,
  Filter,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Users,
  BarChart3,
  Cpu,
  FileText,
  RotateCcw,
  XCircle,
  Eye,
  FileSearch,
} from 'lucide-react';
import type { DocumentAnalysisResult } from '@/types/documentForensics';
import { syncFetchDocumentAnalyses } from '@/lib/supabase-sync';
import { ModelManagementPanel } from '@/components/admin/ModelManagementPanel';
import { RoyalPageFrame } from '@/components/common/RoyalPageFrame';

interface AdminViewProps {
  investigations: Investigation[];
  evidenceList: EvidenceItem[];
  activityLogs: ActivityLog[];
  user: UserProfile;
  onUpdateStatus: (id: string, status: CaseStatus) => Promise<void> | void;
  onDeleteCase: (id: string) => Promise<void> | void;
  onSelectCase: (inv: Investigation) => void;
  onNavigateTab: (tab: string) => void;
}

const STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'New',
  in_progress: 'In Progress',
  review: 'Analysis Complete',
  closed: 'Closed',
};

const STATUS_COLORS: Record<CaseStatus, { bg: string; text: string; border: string }> = {
  open: { bg: 'rgba(98,229,232,0.1)', text: '#62E5E8', border: 'rgba(98,229,232,0.3)' },
  in_progress: { bg: 'rgba(100,140,255,0.1)', text: '#648CFF', border: 'rgba(100,140,255,0.3)' },
  review: { bg: 'rgba(243,186,96,0.1)', text: '#F3BA60', border: 'rgba(243,186,96,0.3)' },
  closed: { bg: 'rgba(94,111,134,0.12)', text: '#5E6F86', border: 'rgba(94,111,134,0.2)' },
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#FF667A',
  high: '#F3BA60',
  medium: '#648CFF',
  low: '#48D597',
};

type AdminTab = 'overview' | 'cases' | 'audit' | 'analytics' | 'models';

function StatusBadge({ status }: { status: CaseStatus }) {
  const c = STATUS_COLORS[status];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: c.text,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 999,
        padding: '2px 10px',
        fontFamily: 'var(--font-mono)',
        whiteSpace: 'nowrap',
      }}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export const AdminView: React.FC<AdminViewProps> = ({
  investigations,
  evidenceList,
  activityLogs,
  user,
  onUpdateStatus,
  onDeleteCase,
  onSelectCase,
  onNavigateTab,
}) => {
  const [adminTab, setAdminTab] = useState<AdminTab>('overview');
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<CaseStatus | 'all'>('all');
  const [filterPriority, setFilterPriority] = useState<string>('all');
  const [expandedCase, setExpandedCase] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [documentAnalyses, setDocumentAnalyses] = useState<DocumentAnalysisResult[]>([]);
  const [documentAnalysisError, setDocumentAnalysisError] = useState('');

  const isAdmin = user.role === 'administrator';

  useEffect(() => {
    void syncFetchDocumentAnalyses().then((results) => {
      setDocumentAnalyses(results);
      setDocumentAnalysisError('');
    }).catch((error: unknown) => {
      setDocumentAnalysisError(error instanceof Error ? error.message : 'Document analysis progress could not be loaded.');
    });
  }, []);

  const filtered = useMemo(() => {
    return investigations.filter(inv => {
      const matchSearch =
        !search ||
        inv.title.toLowerCase().includes(search.toLowerCase()) ||
        inv.caseNumber.toLowerCase().includes(search.toLowerCase()) ||
        inv.leadInvestigator.toLowerCase().includes(search.toLowerCase());
      const matchStatus = filterStatus === 'all' || inv.status === filterStatus;
      const matchPriority = filterPriority === 'all' || inv.priority === filterPriority;
      return matchSearch && matchStatus && matchPriority;
    });
  }, [investigations, search, filterStatus, filterPriority]);

  const stats = useMemo(() => ({
    total: investigations.length,
    active: investigations.filter(i => i.status === 'open' || i.status === 'in_progress').length,
    review: investigations.filter(i => i.status === 'review').length,
    closed: investigations.filter(i => i.status === 'closed').length,
    totalEvidence: evidenceList.length,
    documentEvidence: evidenceList.filter(e => e.mediaType === 'document').length,
  }), [investigations, evidenceList]);

  const getCaseEvidence = (caseId: string) =>
    evidenceList.filter(e => e.investigationId === caseId);

  const recentLogs = activityLogs.slice(0, 15);

  const s = {
    container: {
      padding: '24px',
      maxWidth: 1200,
      margin: '0 auto',
      fontFamily: 'var(--font-sans)',
    } as React.CSSProperties,
    card: {
      background: 'var(--vl-surface)',
      border: '1px solid var(--vl-border)',
      borderRadius: 12,
      padding: '16px 20px',
      boxShadow: 'var(--vl-card-shadow)',
    } as React.CSSProperties,
    label: {
      fontSize: 10.5,
      fontWeight: 700,
      letterSpacing: '0.12em',
      textTransform: 'uppercase' as const,
      color: 'var(--vl-text-dim)',
      fontFamily: 'var(--font-mono)',
    } as React.CSSProperties,
  };

  return (
    <RoyalPageFrame variant="admin">
    <div className="royal-admin-layout" style={s.container}>
      {/* Page header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1
              style={{
                fontSize: 26,
                fontWeight: 800,
                letterSpacing: '-0.03em',
                color: 'var(--vl-text-primary)',
                lineHeight: 1.2,
              }}
            >
              Investigation Management
            </h1>
            <p style={{ fontSize: 13, color: 'var(--vl-text-secondary)', marginTop: 4 }}>
              {isAdmin ? 'Administrator access — all cases visible' : 'Your assigned cases and investigations'}
            </p>
          </div>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: '#648CFF',
              background: 'rgba(100,140,255,0.1)',
              border: '1px solid rgba(100,140,255,0.3)',
              borderRadius: 999,
              padding: '4px 14px',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {user.role.replace('_', ' ')}
          </span>
        </div>
      </div>

      {/* Stats */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: 12,
          marginBottom: 24,
        }}
      >
        {[
          { label: 'Total Cases', value: stats.total, icon: FolderOpen, color: 'var(--vl-ice-cyan)' },
          { label: 'Active', value: stats.active, icon: Clock, color: 'var(--vl-electric-blue)' },
          { label: 'For Review', value: stats.review, icon: AlertTriangle, color: 'var(--vl-warning)' },
          { label: 'Closed', value: stats.closed, icon: CheckCircle2, color: 'var(--vl-success)' },
          { label: 'Evidence Items', value: stats.totalEvidence, icon: BarChart3, color: '#A78BFA' },
          { label: 'Document Evidence', value: stats.documentEvidence, icon: FileSearch, color: 'var(--vl-ice-cyan)' },
          { label: 'Document Analyses', value: documentAnalyses.length, icon: FileSearch, color: 'var(--vl-electric-blue)' },
        ].map((stat, i) => {
          const Icon = stat.icon;
          return (
            <div key={i} data-royal-tilt style={{ ...s.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Icon style={{ width: 16, height: 16, color: stat.color }} />
              <div style={{ fontSize: 24, fontWeight: 700, color: stat.color, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>
                {stat.value}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--vl-text-dim)' }}>{stat.label}</div>
            </div>
          );
        })}
      </div>

      <div style={{ ...s.card, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 14, marginBottom: 24 }}>
        <div>
          <div style={s.label}>Document examination</div>
          <p style={{ color: 'var(--vl-text-secondary)', fontSize: 12, marginTop: 6 }}>
            {documentAnalyses.filter((analysis) => analysis.status === 'parsed').length} fully parsed ·{' '}
            {documentAnalyses.filter((analysis) => analysis.status === 'partially_parsed').length} partial ·{' '}
            {documentAnalyses.filter((analysis) => analysis.status === 'rejected').length} rejected. Review case-linked DOCX/PDF metadata, revision traces, findings, and reports.
          </p>
          {documentAnalysisError && <p role="status" style={{ color: 'var(--vl-warning)', fontSize: 10, marginTop: 5 }}>{documentAnalysisError}</p>}
        </div>
        <button
          type="button"
          onClick={() => onNavigateTab('document_forensics')}
          style={{
            border: '1px solid rgba(98,229,232,0.3)',
            background: 'rgba(98,229,232,0.08)',
            color: 'var(--vl-ice-cyan)',
            borderRadius: 9,
            padding: '9px 13px',
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Open Document Revision Lab
        </button>
      </div>

      {/* Sub-Tabs Navigation Strip */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid var(--vl-border)', paddingBottom: 12, overflowX: 'auto' }}>
        {[
          { id: 'overview', label: 'Admin Overview', count: undefined, icon: FolderOpen },
          { id: 'cases', label: 'Dossiers & Cases', count: investigations.length, icon: FileText },
          { id: 'audit', label: 'Activity Audit Log', count: activityLogs.length, icon: Clock },
          { id: 'analytics', label: 'Case Metrics & Analytics', count: undefined, icon: BarChart3 },
          ...(isAdmin ? [{ id: 'models' as const, label: 'Model Management', count: undefined, icon: Cpu }] : []),
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setAdminTab(t.id as AdminTab)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 14px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              border: adminTab === t.id ? '1px solid rgba(98,229,232,0.5)' : '1px solid var(--vl-border)',
              background: adminTab === t.id ? 'rgba(98,229,232,0.12)' : 'var(--vl-surface)',
              color: adminTab === t.id ? 'var(--vl-ice-cyan)' : 'var(--vl-text-secondary)',
              transition: 'all 0.15s ease',
              whiteSpace: 'nowrap',
            }}
          >
            <t.icon style={{ width: 14, height: 14 }} />
            <span>{t.label}</span>
            {t.count !== undefined && (
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: 'rgba(255,255,255,0.08)' }}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: adminTab === 'cases' || adminTab === 'audit' || adminTab === 'analytics' || adminTab === 'models' ? '1fr' : '1fr 340px', gap: 20 }}>
        {/* Left: investigations list (shown in overview or cases) */}
        {(adminTab === 'overview' || adminTab === 'cases') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Search + filters */}
            <div style={{ ...s.card, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
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
                  id="admin-search-input"
                  type="text"
                  placeholder="Search cases, IDs, investigators…"
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
              <select
                id="admin-filter-status"
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value as CaseStatus | 'all')}
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
                <option value="all">All Statuses</option>
                <option value="open">New</option>
                <option value="in_progress">In Progress</option>
                <option value="review">Analysis Complete</option>
                <option value="closed">Closed</option>
              </select>
              <select
                id="admin-filter-priority"
                value={filterPriority}
                onChange={e => setFilterPriority(e.target.value)}
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
                <option value="all">All Priorities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>

            {/* Case list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {filtered.length === 0 && (
                <div
                  style={{
                    ...s.card,
                    textAlign: 'center',
                    padding: '40px 20px',
                    color: 'var(--vl-text-dim)',
                    fontSize: 13,
                  }}
                >
                  No investigations found.
                </div>
              )}
              {filtered.map(inv => {
                const caseEvidence = getCaseEvidence(inv.id);
                const isExpanded = expandedCase === inv.id;
                const priorityColor = PRIORITY_COLORS[inv.priority] || '#62E5E8';

                return (
                  <div
                    key={inv.id}
                    style={{
                      ...s.card,
                      padding: 0,
                      overflow: 'hidden',
                      border: `1px solid ${isExpanded ? 'rgba(98,229,232,0.25)' : 'var(--vl-border)'}`,
                      transition: 'border-color 0.2s',
                    }}
                  >
                    {/* Case header */}
                    <div
                      style={{
                        padding: '16px 20px',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 14,
                        cursor: 'pointer',
                      }}
                      onClick={() => setExpandedCase(isExpanded ? null : inv.id)}
                    >
                      {/* Priority dot */}
                      <div
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: priorityColor,
                          boxShadow: `0 0 6px ${priorityColor}80`,
                          marginTop: 6,
                          flexShrink: 0,
                        }}
                      />

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                          <span
                            style={{
                              fontSize: 10.5,
                              fontWeight: 700,
                              color: 'var(--vl-ice-cyan)',
                              fontFamily: 'var(--font-mono)',
                              letterSpacing: '0.06em',
                            }}
                          >
                            {inv.caseNumber}
                          </span>
                          <StatusBadge status={inv.status} />
                          <span
                            style={{
                              fontSize: 9.5,
                              fontWeight: 600,
                              textTransform: 'uppercase',
                              letterSpacing: '0.1em',
                              color: priorityColor,
                              background: `${priorityColor}15`,
                              border: `1px solid ${priorityColor}30`,
                              borderRadius: 999,
                              padding: '1px 8px',
                            }}
                          >
                            {inv.priority}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: 'var(--vl-text-primary)',
                            lineHeight: 1.35,
                            marginBottom: 4,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {inv.title}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--vl-text-secondary)' }}>
                          <Users style={{ width: 11, height: 11, display: 'inline', marginRight: 4 }} />
                          {inv.leadInvestigator} ·{' '}
                          {caseEvidence.length} evidence item{caseEvidence.length !== 1 ? 's' : ''} ·{' '}
                          {new Date(inv.createdAt).toLocaleDateString()}
                        </div>
                      </div>

                      <ChevronDown
                        style={{
                          width: 16,
                          height: 16,
                          color: 'var(--vl-text-dim)',
                          transform: isExpanded ? 'rotate(180deg)' : 'none',
                          transition: 'transform 0.2s',
                          flexShrink: 0,
                          marginTop: 2,
                        }}
                      />
                    </div>

                    {/* Expanded */}
                    {isExpanded && (
                      <div
                        style={{
                          padding: '0 20px 20px',
                          borderTop: '1px solid var(--vl-border)',
                          paddingTop: 16,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 14,
                        }}
                      >
                        {/* Description */}
                        <p style={{ fontSize: 12.5, color: 'var(--vl-text-secondary)', lineHeight: 1.6 }}>
                          {inv.description}
                        </p>

                        {/* Evidence items */}
                        {caseEvidence.length > 0 && (
                          <div>
                            <div style={{ ...s.label, marginBottom: 8 }}>Evidence ({caseEvidence.length})</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {caseEvidence.slice(0, 3).map(ev => (
                                <div
                                  key={ev.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 10,
                                    background: 'var(--vl-surface-elevated)',
                                    borderRadius: 7,
                                    padding: '8px 12px',
                                    fontSize: 12,
                                    color: 'var(--vl-text-secondary)',
                                  }}
                                >
                                  <FileText style={{ width: 12, height: 12, flexShrink: 0 }} />
                                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {ev.fileName}
                                  </span>
                                  <span
                                    style={{
                                      fontSize: 9.5,
                                      textTransform: 'uppercase',
                                      color: 'var(--vl-text-dim)',
                                      fontFamily: 'var(--font-mono)',
                                      letterSpacing: '0.1em',
                                    }}
                                  >
                                    {ev.mediaType}
                                  </span>
                                </div>
                              ))}
                              {caseEvidence.length > 3 && (
                                <div style={{ fontSize: 11, color: 'var(--vl-text-dim)', paddingLeft: 4 }}>
                                  +{caseEvidence.length - 3} more items
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Actions */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                          {/* Status change */}
                          <select
                            id={`admin-status-select-${inv.id}`}
                            value={inv.status}
                            onChange={async e => {
                              try {
                                await onUpdateStatus(inv.id, e.target.value as CaseStatus);
                              } catch (error) {
                                window.alert(error instanceof Error ? error.message : 'The case status could not be updated.');
                              }
                            }}
                            style={{
                              background: 'var(--vl-surface-elevated)',
                              border: '1px solid var(--vl-border)',
                              borderRadius: 7,
                              color: 'var(--vl-text-secondary)',
                              fontSize: 12,
                              padding: '6px 10px',
                              cursor: 'pointer',
                              fontFamily: 'var(--font-sans)',
                            }}
                          >
                            <option value="open">Set: New</option>
                            <option value="in_progress">Set: In Progress</option>
                            <option value="review">Set: Analysis Complete</option>
                            <option value="closed">Set: Closed</option>
                          </select>

                          <button
                            id={`admin-view-case-${inv.id}`}
                            onClick={() => {
                              onSelectCase(inv);
                              onNavigateTab('investigations');
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              background: 'rgba(98,229,232,0.1)',
                              border: '1px solid rgba(98,229,232,0.3)',
                              borderRadius: 7,
                              color: 'var(--vl-ice-cyan)',
                              fontSize: 12,
                              fontWeight: 600,
                              padding: '6px 14px',
                              cursor: 'pointer',
                              transition: 'background 0.15s',
                            }}
                          >
                            <Eye style={{ width: 12, height: 12 }} />
                            Open Case
                          </button>

                          <button
                            id={`admin-report-case-${inv.id}`}
                            onClick={() => {
                              onSelectCase(inv);
                              onNavigateTab('reports');
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              background: 'rgba(243,186,96,0.1)',
                              border: '1px solid rgba(243,186,96,0.3)',
                              borderRadius: 7,
                              color: '#F3BA60',
                              fontSize: 12,
                              fontWeight: 600,
                              padding: '6px 14px',
                              cursor: 'pointer',
                              transition: 'background 0.15s',
                            }}
                          >
                            <FileText style={{ width: 12, height: 12 }} />
                            Reports
                          </button>

                          {inv.status === 'closed' && (
                            <button
                              id={`admin-reopen-case-${inv.id}`}
                              onClick={() => onUpdateStatus(inv.id, 'open')}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                background: 'none',
                                border: '1px solid var(--vl-border)',
                                borderRadius: 7,
                                color: 'var(--vl-text-secondary)',
                                fontSize: 12,
                                fontWeight: 600,
                                padding: '6px 14px',
                                cursor: 'pointer',
                                transition: 'all 0.15s',
                              }}
                            >
                              <RotateCcw style={{ width: 12, height: 12 }} />
                              Reopen
                            </button>
                          )}

                          {isAdmin && confirmDelete === inv.id ? (
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <span style={{ fontSize: 11, color: 'var(--vl-critical)', fontWeight: 600 }}>
                                Confirm delete?
                              </span>
                              <button
                                onClick={async () => {
                                  try {
                                    await onDeleteCase(inv.id);
                                    setConfirmDelete(null);
                                    setExpandedCase(null);
                                  } catch (error) {
                                    window.alert(error instanceof Error ? error.message : 'The case could not be deleted.');
                                  }
                                }}
                                style={{
                                  background: 'rgba(255,102,122,0.15)',
                                  border: '1px solid rgba(255,102,122,0.4)',
                                  borderRadius: 7,
                                  color: '#FF667A',
                                  fontSize: 11,
                                  fontWeight: 700,
                                  padding: '5px 10px',
                                  cursor: 'pointer',
                                }}
                              >
                                Delete
                              </button>
                              <button
                                onClick={() => setConfirmDelete(null)}
                                style={{
                                  background: 'none',
                                  border: '1px solid var(--vl-border)',
                                  borderRadius: 7,
                                  color: 'var(--vl-text-secondary)',
                                  fontSize: 11,
                                  padding: '5px 10px',
                                  cursor: 'pointer',
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : isAdmin ? (
                            <button
                              id={`admin-delete-case-${inv.id}`}
                              onClick={() => setConfirmDelete(inv.id)}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                background: 'none',
                                border: '1px solid rgba(255,102,122,0.25)',
                                borderRadius: 7,
                                color: 'rgba(255,102,122,0.7)',
                                fontSize: 12,
                                padding: '6px 14px',
                                cursor: 'pointer',
                                transition: 'all 0.15s',
                              }}
                            >
                              <XCircle style={{ width: 12, height: 12 }} />
                              Delete
                            </button>
                          ) : null}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Right: activity log and stats (shown in overview, audit, or analytics) */}
        {(adminTab === 'overview' || adminTab === 'audit' || adminTab === 'analytics') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {(adminTab === 'overview' || adminTab === 'audit') && (
              <div style={s.card}>
                <div style={{ ...s.label, marginBottom: 14 }}>
                  {adminTab === 'audit' ? 'Comprehensive Activity Audit Trail' : 'Activity Log'}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {recentLogs.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--vl-text-dim)', textAlign: 'center', padding: '20px 0' }}>
                      No activity recorded.
                    </div>
                  ) : (
                    recentLogs.map((log, i) => (
                      <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <div
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: 'var(--vl-ice-cyan)',
                            marginTop: 5,
                            flexShrink: 0,
                            opacity: 0.6,
                          }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 11.5,
                              color: 'var(--vl-text-secondary)',
                              lineHeight: 1.45,
                              wordBreak: 'break-word',
                            }}
                          >
                            {log.description}
                          </div>
                          <div
                            style={{
                              fontSize: 10,
                              color: 'var(--vl-text-dim)',
                              fontFamily: 'var(--font-mono)',
                              marginTop: 2,
                            }}
                          >
                            {new Date(log.timestamp).toLocaleString()}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Quick stats (shown in overview or analytics) */}
            {(adminTab === 'overview' || adminTab === 'analytics') && (
              <div style={s.card}>
                <div style={{ ...s.label, marginBottom: 14 }}>Case Distribution & Telemetry</div>
                {(['open', 'in_progress', 'review', 'closed'] as CaseStatus[]).map(status => {
                  const count = investigations.filter(i => i.status === status).length;
                  const pct = investigations.length ? Math.round((count / investigations.length) * 100) : 0;
                  const c = STATUS_COLORS[status];
                  return (
                    <div key={status} style={{ marginBottom: 10 }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: 11.5,
                          marginBottom: 4,
                          color: 'var(--vl-text-secondary)',
                        }}
                      >
                        <span>{STATUS_LABELS[status]}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', color: c.text }}>{count}</span>
                      </div>
                      <div
                        style={{
                          height: 4,
                          borderRadius: 2,
                          background: 'var(--vl-surface-elevated)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${pct}%`,
                            height: '100%',
                            background: c.text,
                            borderRadius: 2,
                            transition: 'width 0.4s',
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {adminTab === 'models' && isAdmin && (
        <div style={{ marginTop: 16 }}>
          <ModelManagementPanel />
        </div>
      )}
    </div>
    </RoyalPageFrame>
  );
};
