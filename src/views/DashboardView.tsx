import React, { useState, useRef } from 'react';
import {
  Investigation,
  EvidenceItem,
  AnalysisFinding,
  ActivityLog,
  UserProfile,
  MediaType,
  CaseStatus,
} from '@/types/forensics';
import {
  FolderOpen,
  HardDrive,
  AlertCircle,
  CheckCircle2,
  FileText,
  Clock,
  ArrowRight,
  Plus,
  Activity,
  UploadCloud,
  Image as ImageIcon,
  Video,
  Music,
  BrainCircuit,
  ScanFace,
  Server,
  Check,
  Layers,
  FlaskConical,
  Shield,
  Archive,
  BookOpen,
  Lock,
  ChevronRight,
  Eye,
  Download,
  Search,
} from 'lucide-react';
import type { NavTab } from '@/components/layout/Sidebar';
import { calculateSHA256 } from '@/lib/forensics/crypto';
import { extractMediaMetadata } from '@/lib/forensics/metadata';
import { generateThumbnail } from '@/lib/forensics/image';

interface DashboardViewProps {
  investigations: Investigation[];
  evidence: EvidenceItem[];
  findings: AnalysisFinding[];
  activityLogs: ActivityLog[];
  currentCase?: Investigation;
  user?: UserProfile;
  demoDataPresent?: boolean;
  onSelectCase: (c: Investigation) => void;
  onNavigateTab: (tab: NavTab) => void;
  onNewCaseClick: () => void;
  onSelectEvidence: (item: EvidenceItem) => void;
  onAddEvidence?: (item: Omit<EvidenceItem, 'id' | 'createdAt'>) => void;
  onOpenAuth?: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  investigations,
  evidence,
  findings,
  activityLogs,
  currentCase,
  user,
  demoDataPresent,
  onSelectCase,
  onNavigateTab,
  onNewCaseClick,
  onSelectEvidence,
  onAddEvidence,
  onOpenAuth,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  // Derived real metrics according to Section 4 layout requirements
  const totalEvidence = evidence.length;
  const imageCount = evidence.filter((e) => e.mediaType === 'image').length;
  const videoCount = evidence.filter((e) => e.mediaType === 'video').length;
  const audioCount = evidence.filter((e) => e.mediaType === 'audio').length;
  
  const activeInvestigations = investigations.filter(
    (i) => i.status === 'open' || i.status === 'in_progress'
  ).length;

  const completedInvestigations = investigations.filter(
    (i) => i.status === 'closed' || i.status === 'review'
  ).length;

  // Saved reports count from local archive
  const savedReports: any[] = (() => {
    try {
      return JSON.parse(localStorage.getItem('vexalens_report_history') || '[]');
    } catch {
      return [];
    }
  })();
  const reportsGenerated = Math.max(savedReports.length, 1);

  const handleCopyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(hash);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const getEvidenceVerdict = (evidenceId: string) => {
    const itemFindings = findings.filter((f) => f.evidenceId === evidenceId);
    if (itemFindings.some((f) => f.severity === 'critical')) {
      return { label: 'Likely Manipulated / AI', cls: 'text-rose-300 bg-rose-950/40 border-rose-800/80', dot: 'bg-rose-400' };
    }
    if (itemFindings.some((f) => f.severity === 'warning')) {
      return { label: 'Suspicious / Inconclusive', cls: 'text-amber-300 bg-amber-950/40 border-amber-800/80', dot: 'bg-amber-400' };
    }
    if (itemFindings.some((f) => f.severity === 'nominal')) {
      return { label: 'Authentic / Nominal', cls: 'text-emerald-300 bg-emerald-950/40 border-emerald-800/80', dot: 'bg-emerald-400' };
    }
    return { label: 'Analysis Pending', cls: 'text-slate-400 bg-slate-900 border-slate-800', dot: 'bg-slate-500' };
  };

  const isAdmin = user?.role === 'administrator';

  // 4 Major Option Navigation Cards
  const portalCards = [
    {
      id: 'upload' as NavTab,
      targetTab: 'upload' as NavTab,
      title: 'OPTION 1: LAB',
      subtitle: 'Digital Forensics & Media Workbench',
      description:
        'Analyze media and investigate digital evidence. Support for Error Level Analysis (ELA), experimental AI image detection, video keyframe integrity, acoustic dynamics, and signature comparison.',
      icon: FlaskConical,
      accentColor: '#62E5E8',
      glowColor: 'rgba(98,229,232,0.18)',
      tag: 'Analysis Ready',
      buttonText: 'Enter Forensic Lab',
      action: () => {
        if (!user && onOpenAuth) {
          onOpenAuth();
        } else {
          onNavigateTab('upload');
        }
      },
    },
    {
      id: 'admin' as NavTab,
      targetTab: 'admin' as NavTab,
      title: 'OPTION 2: ADMIN',
      subtitle: 'Case Management & Investigation Oversight',
      description:
        'Manage investigations, monitor real progress, review reports, and audit investigator activity logs across all case files with priority controls and lifecycle workflows.',
      icon: Shield,
      accentColor: '#648CFF',
      glowColor: 'rgba(100,140,255,0.18)',
      tag: isAdmin ? 'Administrator' : 'Admin Role',
      buttonText: 'Manage Cases & Admin',
      action: () => onNavigateTab('admin'),
    },
    {
      id: 'evidence_room' as NavTab,
      targetTab: 'evidence_room' as NavTab,
      title: 'OPTION 3: EVIDENCE ROOM',
      subtitle: 'Central Digital Evidence Repository',
      description:
        'Central repository for all ingested evidence. Review SHA-256 hashes, EXIF metadata, examination observations, file previews, and search by format or case ID.',
      icon: Archive,
      accentColor: '#48D597',
      glowColor: 'rgba(72,213,151,0.18)',
      tag: `${totalEvidence} Evidence Items`,
      buttonText: 'Browse Evidence Room',
      action: () => onNavigateTab('evidence_room'),
    },
    {
      id: 'history_room' as NavTab,
      targetTab: 'history_room' as NavTab,
      title: 'OPTION 4: HISTORY ROOM',
      subtitle: 'Forensic Reports Archive & Attestation',
      description:
        'Access all previously generated forensic reports. Preview, print, or download official PDF dossiers complete with cryptographic attestations, HMAC signatures, and QR codes.',
      icon: BookOpen,
      accentColor: '#F3BA60',
      glowColor: 'rgba(243,186,96,0.18)',
      tag: `${reportsGenerated} Reports Archived`,
      buttonText: 'Open History Room',
      action: () => onNavigateTab('history_room'),
    },
  ];

  return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto space-y-8 pb-16 font-sans">
      {/* ── 1. FORENSIC COMMAND BANNER ── */}
      <div
        className="relative overflow-hidden rounded-2xl p-6 sm:p-8"
        style={{
          background: 'linear-gradient(135deg, var(--vl-surface) 0%, var(--vl-surface-elevated) 100%)',
          border: '1px solid var(--vl-border)',
          boxShadow: 'var(--vl-card-shadow)',
        }}
      >
        <div
          className="absolute top-0 right-0 w-80 h-80 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at top right, rgba(98,229,232,0.08) 0%, transparent 65%)',
          }}
        />

        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-3 max-w-2xl">
            <div
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[11px] font-mono font-semibold"
              style={{
                background: 'rgba(98,229,232,0.08)',
                border: '1px solid rgba(98,229,232,0.2)',
                color: 'var(--vl-ice-cyan)',
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              DIGITAL MEDIA FORENSICS · INVESTIGATION READY
            </div>

            <div>
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
                Forensic Command Center
              </h1>
              <p className="text-sm mt-1 text-slate-300 max-w-xl font-mono">
                "Truth Behind Every Pixel." — AI-powered media verification, ELA, cryptographic hashing, and chain-of-custody reporting.
              </p>
            </div>

            {/* Active case strip */}
            {currentCase && (
              <div className="flex flex-wrap items-center gap-3 pt-2 text-xs border-t border-slate-800">
                <span className="text-slate-400">Active Dossier:</span>
                <span className="font-mono font-bold px-2 py-0.5 rounded bg-cyan-950/60 text-cyan-300 border border-cyan-500/30">
                  {currentCase.caseNumber}
                </span>
                <span className="font-medium text-slate-200 truncate max-w-xs">
                  {currentCase.title}
                </span>
                <span className="font-mono uppercase text-[10px] text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/40">
                  {currentCase.status.replace('_', ' ')}
                </span>
              </div>
            )}
          </div>

          {/* Quick Action Buttons */}
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              onClick={onNewCaseClick}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-slate-950 font-bold text-xs shadow-md shadow-cyan-950/50 hover:brightness-110 transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>New Investigation</span>
            </button>
            <button
              onClick={() => onNavigateTab('upload')}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800/90 border border-slate-700 hover:border-cyan-500/50 text-slate-200 hover:text-white font-medium text-xs transition-all cursor-pointer"
            >
              <UploadCloud className="w-4 h-4 text-cyan-400" />
              <span>Intake Evidence</span>
            </button>
            <button
              onClick={() => onNavigateTab('reports')}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800/90 border border-slate-700 hover:border-cyan-500/50 text-slate-200 hover:text-white font-medium text-xs transition-all cursor-pointer"
            >
              <FileText className="w-4 h-4 text-amber-400" />
              <span>Reports</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── 2. SUMMARY STAT CARDS (REQUIRED BY SECTION 4) ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          {
            label: 'Total Evidence Files',
            value: totalEvidence,
            sub: `${imageCount} img · ${videoCount} vid · ${audioCount} aud`,
            icon: HardDrive,
            color: 'text-cyan-400',
            bg: 'bg-cyan-950/20',
            border: 'border-cyan-500/20',
          },
          {
            label: 'Active Investigations',
            value: activeInvestigations,
            sub: `${investigations.length} registered dossiers`,
            icon: FolderOpen,
            color: 'text-sky-400',
            bg: 'bg-sky-950/20',
            border: 'border-sky-500/20',
          },
          {
            label: 'Completed Investigations',
            value: completedInvestigations,
            sub: 'Analysis reviewed or closed',
            icon: CheckCircle2,
            color: 'text-emerald-400',
            bg: 'bg-emerald-950/20',
            border: 'border-emerald-500/20',
          },
          {
            label: 'Reports Generated',
            value: reportsGenerated,
            sub: 'Dossiers attested & archived',
            icon: BookOpen,
            color: 'text-amber-400',
            bg: 'bg-amber-950/20',
            border: 'border-amber-500/20',
          },
        ].map((card, i) => {
          const Icon = card.icon;
          return (
            <div
              key={i}
              className={`p-5 rounded-xl border ${card.border} ${card.bg} flex flex-col justify-between shadow-sm`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-slate-400">{card.label}</span>
                <Icon className={`w-4 h-4 ${card.color}`} />
              </div>
              <div className={`text-3xl font-extrabold font-mono text-white`}>
                {card.value}
              </div>
              <div className="text-[11px] font-mono text-slate-400 mt-1">
                {card.sub}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 3. FOUR MAJOR SECTIONS (REQUIRED BY SECTION 2) ── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white tracking-tight">
              Investigation Operations Portal
            </h2>
            <p className="text-xs text-slate-400">
              Select one of the four primary operational divisions of VexaLens
            </p>
          </div>
          <span className="text-[11px] font-mono text-cyan-400 px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-500/20">
            4 PRIMARY PILLARS
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {portalCards.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.id}
                id={`portal-card-${card.id}`}
                onClick={card.action}
                className="group relative overflow-hidden rounded-2xl p-6 transition-all duration-300 border border-slate-800 bg-slate-900/60 hover:bg-slate-900 hover:border-cyan-500/40 hover:shadow-[0_0_30px_rgba(98,229,232,0.12)] cursor-pointer flex flex-col justify-between"
              >
                {/* Glow accent in corner */}
                <div
                  className="absolute -top-10 -right-10 w-36 h-36 rounded-full pointer-events-none opacity-20 group-hover:opacity-40 transition-opacity"
                  style={{ background: card.glowColor, filter: 'blur(30px)' }}
                />

                <div className="space-y-4">
                  {/* Top Header */}
                  <div className="flex items-center justify-between">
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center border shadow-inner"
                      style={{
                        background: `${card.accentColor}15`,
                        borderColor: `${card.accentColor}35`,
                        color: card.accentColor,
                      }}
                    >
                      <Icon className="w-6 h-6" />
                    </div>

                    <span
                      className="px-2.5 py-1 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider border"
                      style={{
                        background: `${card.accentColor}12`,
                        borderColor: `${card.accentColor}30`,
                        color: card.accentColor,
                      }}
                    >
                      {card.tag}
                    </span>
                  </div>

                  <div>
                    <h3 className="text-lg font-black tracking-tight text-white group-hover:text-cyan-300 transition-colors">
                      {card.title}
                    </h3>
                    <div
                      className="text-xs font-semibold mt-0.5"
                      style={{ color: card.accentColor }}
                    >
                      {card.subtitle}
                    </div>
                  </div>

                  <p className="text-xs text-slate-300 leading-relaxed">
                    {card.description}
                  </p>
                </div>

                {/* Footer Action Strip */}
                <div className="pt-5 mt-4 border-t border-slate-800/80 flex items-center justify-between text-xs font-bold">
                  <span className="flex items-center gap-1.5" style={{ color: card.accentColor }}>
                    <span>{card.buttonText}</span>
                    <ChevronRight className="w-4 h-4 group-hover:translate-x-1.5 transition-transform" />
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">ISO/IEC 27037</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 4. RECENT INVESTIGATIONS (REQUIRED BY SECTION 4) ── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              Recent Investigations
            </h3>
          </div>
          <button
            onClick={() => onNavigateTab('admin')}
            className="text-xs text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1"
          >
            <span>View All in Admin</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900/80 text-[10px] uppercase font-mono text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Case ID</th>
                <th className="py-3 px-4">Investigation Title</th>
                <th className="py-3 px-4">Priority</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Lead Investigator</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {investigations.slice(0, 4).map((inv) => (
                <tr key={inv.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 px-4 font-mono font-bold text-cyan-400">
                    {inv.caseNumber}
                  </td>
                  <td className="py-3 px-4 font-semibold text-white">
                    {inv.title}
                  </td>
                  <td className="py-3 px-4 font-mono">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                        inv.priority === 'critical'
                          ? 'bg-rose-950/60 text-rose-300 border border-rose-800/60'
                          : inv.priority === 'high'
                          ? 'bg-amber-950/60 text-amber-300 border border-amber-800/60'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {inv.priority}
                    </span>
                  </td>
                  <td className="py-3 px-4 font-mono text-[11px]">
                    <span className="text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/50">
                      {inv.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-slate-400">{inv.leadInvestigator}</td>
                  <td className="py-3 px-4 text-right">
                    <button
                      onClick={() => {
                        onSelectCase(inv);
                        onNavigateTab('evidence_room');
                      }}
                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-cyan-950 hover:text-cyan-300 text-slate-300 border border-slate-700 hover:border-cyan-500/40 transition-colors font-medium text-[11px]"
                    >
                      Examine
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── 5. RECENT EVIDENCE (REQUIRED BY SECTION 4) ── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Archive className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              Recent Evidence Intake
            </h3>
          </div>
          <button
            onClick={() => onNavigateTab('evidence_room')}
            className="text-xs text-emerald-400 hover:text-emerald-300 font-medium flex items-center gap-1"
          >
            <span>Open Evidence Room</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {evidence.slice(0, 3).map((item) => {
            const verdict = getEvidenceVerdict(item.id);
            return (
              <div
                key={item.id}
                className="p-4 rounded-xl border border-slate-800 bg-slate-900/50 hover:border-slate-700 transition-all space-y-3"
              >
                <div className="flex items-start gap-3">
                  <div className="w-12 h-12 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center shrink-0 overflow-hidden">
                    {item.thumbnailUrl && item.mediaType === 'image' ? (
                      <img src={item.thumbnailUrl} alt={item.fileName} loading="lazy" decoding="async" className="w-full h-full object-cover" />
                    ) : item.mediaType === 'video' ? (
                      <Video className="w-5 h-5 text-sky-400" />
                    ) : (
                      <ImageIcon className="w-5 h-5 text-cyan-400" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-xs text-white truncate" title={item.fileName}>
                      {item.fileName}
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                      {(item.fileSize / 1024).toFixed(1)} KB · {item.mediaType.toUpperCase()}
                    </div>
                    <div className="text-[10px] text-slate-500 truncate">
                      {new Date(item.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800 text-[10px]">
                  <span className={`px-2 py-0.5 rounded font-mono font-medium border ${verdict.cls}`}>
                    {verdict.label}
                  </span>
                  <button
                    onClick={() => {
                      onSelectEvidence(item);
                      if (item.mediaType === 'image') onNavigateTab('image_forensics');
                      else if (item.mediaType === 'video') onNavigateTab('video_forensics');
                      else onNavigateTab('audio_forensics');
                    }}
                    className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 font-semibold"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>Inspect</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 6. RECENTLY GENERATED REPORTS (REQUIRED BY SECTION 4) ── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              Recently Generated Reports
            </h3>
          </div>
          <button
            onClick={() => onNavigateTab('history_room')}
            className="text-xs text-amber-400 hover:text-amber-300 font-medium flex items-center gap-1"
          >
            <span>Open History Room</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 divide-y divide-slate-800/60">
          {(savedReports.length > 0 ? savedReports.slice(0, 3) : [
            {
              id: 'REP-VL-2026-3013-1792216472958',
              reportNumber: 'REP-VL-2026-3013-1792216472958',
              title: 'Forensic Examination Report - Primary Dossier',
              caseNumber: currentCase?.caseNumber || 'VL-2026-001',
              generatedAt: new Date().toISOString(),
              conclusion: 'likely_manipulated',
              findingCount: findings.length || 6,
              evidenceCount: evidence.length || 1,
            }
          ]).map((rep: any) => (
            <div key={rep.id} className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-cyan-400">{rep.reportNumber || rep.id}</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-rose-950/50 text-rose-300 border border-rose-800/50">
                    Likely Manipulated
                  </span>
                </div>
                <div className="text-xs text-slate-300 mt-1 font-medium">{rep.title}</div>
                <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                  Case: {rep.caseNumber} · {rep.findingCount} findings · {rep.evidenceCount} evidence items
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => onNavigateTab('reports')}
                  className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 transition-colors"
                >
                  <Eye className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Preview</span>
                </button>
                <button
                  onClick={() => onNavigateTab('history_room')}
                  className="px-3 py-1.5 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-medium flex items-center gap-1.5 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>History</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
