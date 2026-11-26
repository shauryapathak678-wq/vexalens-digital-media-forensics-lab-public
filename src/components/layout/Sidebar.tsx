import React, { useState } from 'react';
import {
  LayoutDashboard,
  FolderOpen,
  UploadCloud,
  Image as ImageIcon,
  Video,
  Music,
  Columns2,
  Clock,
  FileCheck2,
  FileText,
  Settings,
  ChevronRight,
  ShieldCheck,
  Activity,
  PenTool,
  ScanFace,
  Server,
  BrainCircuit,
  ChevronLeft,
  X,
  ScanEye,
  AlignLeft,
  BookOpen,
  Shield,
  Archive,
  FlaskConical,
  FileSearch,
  Mail,
  Binary,
  MapPin,
} from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';

export type NavTab =
  | 'landing'
  | 'information'
  | 'workspaces'
  | 'dashboard'
  | 'admin'
  | 'evidence_room'
  | 'ghost_recover'
  | 'investigations'
  | 'upload'
  | 'gps_image_tracker'
  | 'screenshot_detector'
  | 'email_verifier'
  | 'document_forensics'
  | 'image_forensics'
  | 'image_trace'
  | 'ai_origin'
  | 'video_forensics'
  | 'lip_sync'
  | 'deepfake'
  | 'photo_video_match'
  | 'signature_compare'
  | 'audio_forensics'
  | 'metadata_inspector'
  | 'origin_intelligence'
  | 'steganography_detector'
  | 'comparison'
  | 'backend_processing'
  | 'ai_model_status'
  | 'services'
  | 'chain_of_custody'
  | 'timeline'
  | 'batch'
  | 'case_relationships'
  | 'certificates'
  | 'findings'
  | 'reports'
  | 'history_room'
  | 'privacy'
  | 'settings';

export type ExperienceMode = 'beginner' | 'expert';

interface SidebarItem {
  id: NavTab;
  label: string;
  shortLabel?: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  badge?: string;
  alert?: boolean;
}

interface SidebarSection {
  label: string;
  items: SidebarItem[];
}

interface SidebarProps {
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  activeEvidenceCount: number;
  criticalFindingsCount: number;
  experienceMode: ExperienceMode;
  isMobileOpen?: boolean;
  onCloseMobile?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onTabChange,
  activeEvidenceCount,
  criticalFindingsCount,
  experienceMode,
  isMobileOpen,
  onCloseMobile,
}) => {
  const [collapsed, setCollapsed] = useState(false);

  const sections: SidebarSection[] = [
    {
      label: 'Operations',
      items: [
        {
          id: 'upload',
          label: 'Evidence Intake',
          shortLabel: 'Intake',
          icon: FlaskConical,
          badge: activeEvidenceCount ? `${activeEvidenceCount}` : undefined,
        },
        { id: 'batch', label: 'Batch Investigation', shortLabel: 'Batch', icon: AlignLeft },
        { id: 'admin', label: 'Administration', shortLabel: 'Admin', icon: Shield },
        { id: 'investigations', label: 'Case Management', shortLabel: 'Cases', icon: FolderOpen },
        { id: 'evidence_room', label: 'Evidence Files', shortLabel: 'Evidence', icon: Archive },
        { id: 'ghost_recover', label: 'GhostRecover', shortLabel: 'GhostRecover', icon: ShieldCheck },
        { id: 'history_room', label: 'Investigation History', shortLabel: 'History', icon: BookOpen },
      ],
    },
    {
      label: 'Forensic Labs',
      items: [
        { id: 'deepfake', label: 'AI Video & Deepfake Lab', shortLabel: 'Deepfake', icon: ScanEye, badge: 'PRO' },
        { id: 'image_forensics', label: 'Image Forensics', shortLabel: 'Image', icon: ImageIcon },
        { id: 'image_trace', label: 'Image Trace', shortLabel: 'Image Trace', icon: FileSearch },
        { id: 'gps_image_tracker', label: 'GPS Image Tracker', shortLabel: 'GPS Tracker', icon: MapPin },
        { id: 'ai_origin', label: 'AI Image Detection', shortLabel: 'AI Image', icon: BrainCircuit },
        { id: 'steganography_detector', label: 'Steganography Detector', shortLabel: 'Stego', icon: Binary, badge: 'NEW' },
        { id: 'video_forensics', label: 'Video Forensics', shortLabel: 'Video', icon: Video },
        { id: 'lip_sync', label: 'Audio–Video Timing', shortLabel: 'AV Timing', icon: Activity },
        { id: 'audio_forensics', label: 'Audio Forensics', shortLabel: 'Audio', icon: Music },
        { id: 'signature_compare', label: 'Signature Comparison', shortLabel: 'Signature', icon: PenTool },
        { id: 'comparison', label: 'Media Comparison', shortLabel: 'Compare', icon: Columns2 },
        { id: 'photo_video_match', label: 'Photo–Video Match', shortLabel: 'Ph/Vid', icon: ScanFace },
        { id: 'document_forensics', label: 'Document Revision Lab', shortLabel: 'Documents', icon: FileSearch },
        { id: 'screenshot_detector', label: 'Screenshot Forensics', shortLabel: 'Screenshots', icon: ScanEye, badge: 'NEW' },
        { id: 'email_verifier', label: 'Email Screenshot Verifier', shortLabel: 'Email Verify', icon: Mail, badge: 'NEW' },
      ],
    },
    {
      label: 'Intelligence',
      items: [
        {
          id: 'findings',
          label: 'Findings Register',
          shortLabel: 'Findings',
          icon: FileCheck2,
          alert: criticalFindingsCount > 0,
        },
        { id: 'reports', label: 'Forensic Reports', shortLabel: 'Reports', icon: FileText },
        { id: 'certificates', label: 'Certificates', shortLabel: 'Certs', icon: ShieldCheck },
        { id: 'timeline', label: 'Chain of Custody', shortLabel: 'CoC', icon: Clock },
      ],
    },
    {
      label: 'System',
      items: [
        { id: 'services', label: 'Forensic Services', shortLabel: 'Services', icon: Activity },
        { id: 'ai_model_status', label: 'AI Model Status', shortLabel: 'AI Status', icon: ScanEye },
        { id: 'backend_processing', label: 'Backend Processing', shortLabel: 'Backend', icon: Server },
        { id: 'settings', label: 'Settings', shortLabel: 'Settings', icon: Settings },
      ],
    },
  ];

  const handleItemClick = (id: NavTab) => {
    onTabChange(id);
    if (onCloseMobile) onCloseMobile();
  };

  const workspaceTabs: Record<string, NavTab[]> = {
    lab: ['upload', 'batch', 'screenshot_detector', 'email_verifier', 'deepfake', 'image_forensics', 'image_trace', 'gps_image_tracker', 'ai_origin', 'steganography_detector', 'video_forensics', 'lip_sync', 'audio_forensics', 'signature_compare', 'comparison', 'photo_video_match', 'document_forensics'],
    admin: ['admin', 'investigations', 'case_relationships', 'services', 'ai_model_status', 'backend_processing', 'settings', 'privacy'],
    evidence_room: ['evidence_room', 'ghost_recover', 'certificates', 'timeline', 'chain_of_custody'],
    history_room: ['history_room', 'reports', 'findings'],
  };
  const currentWorkspace = currentTab === 'admin' || currentTab === 'investigations' || currentTab === 'case_relationships' || currentTab === 'settings' || currentTab === 'privacy' || currentTab === 'services' || currentTab === 'ai_model_status' || currentTab === 'backend_processing'
    ? 'admin'
    : currentTab === 'evidence_room' || currentTab === 'ghost_recover' || currentTab === 'certificates' || currentTab === 'timeline' || currentTab === 'chain_of_custody'
    ? 'evidence_room'
    : currentTab === 'history_room' || currentTab === 'reports' || currentTab === 'findings'
    ? 'history_room'
    : 'lab';
  const visibleSections = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => workspaceTabs[currentWorkspace].includes(item.id)),
    }))
    .filter((section) => section.items.length > 0);

  const SidebarContent = () => (
    <div className="flex flex-col h-full select-none">
      {/* Scrollable nav list */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-3 space-y-5">
        {/* Mobile header */}
        <div
          className="lg:hidden flex items-center justify-between px-4 pb-3"
          style={{ borderBottom: '1px solid var(--vl-border)' }}
        >
          <div className="flex items-center gap-2">
            <BrandLogo className="h-6 w-6 rounded-md object-cover" />
            <span className="text-xs font-bold" style={{ color: 'var(--vl-text-primary)' }}>
              VexaLens
            </span>
          </div>
          <button
            onClick={onCloseMobile}
            className="p-1.5 rounded-md transition-colors"
            style={{ color: 'var(--vl-text-secondary)' }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {visibleSections.map((sec, sIdx) => (
          <div key={sIdx} className={collapsed ? '' : 'px-2'}>
            {/* Section label */}
            {!collapsed && (
              <div
                className="px-2 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em]"
                style={{ color: 'var(--vl-text-dim)' }}
              >
                {sec.label}
              </div>
            )}

            <div className="space-y-0.5">
              {sec.items.map((item) => {
                const Icon = item.icon;
                const active = currentTab === item.id;

                return (
                  <button
                    key={item.id}
                    id={`sidebar-nav-${item.id}`}
                    onClick={() => handleItemClick(item.id)}
                    title={collapsed ? item.label : undefined}
                    className={`
                      w-full flex items-center gap-2.5 rounded-xl text-xs font-medium transition-all duration-180 text-left
                      ${collapsed ? 'justify-center px-2 py-2.5' : 'px-2.5 py-2'}
                    `}
                    style={{
                      background: active
                        ? 'linear-gradient(90deg, rgba(98,229,232,0.12), rgba(100,140,255,0.04))'
                        : 'rgba(255,255,255,0.01)',
                      border: '1px solid',
                      borderColor: active
                        ? 'rgba(98,229,232,0.24)'
                        : 'rgba(148,163,184,0.06)',
                      color: active
                        ? 'var(--vl-ice-cyan)'
                        : 'var(--vl-text-secondary)',
                      boxShadow: active
                        ? 'inset 3px 0 0 0 var(--vl-ice-cyan), 0 8px 20px rgba(0,0,0,0.12)'
                        : 'inset 3px 0 0 0 transparent',
                    }}
                  >
                    <Icon
                      className="w-4 h-4 shrink-0"
                      style={{ color: active ? 'var(--vl-ice-cyan)' : 'var(--vl-text-dim)' }}
                    />

                    {!collapsed && (
                      <span className="truncate flex-1">
                        {item.label}
                      </span>
                    )}

                    {!collapsed && (
                      <div className="flex items-center gap-1 shrink-0">
                        {item.alert && (
                          <span
                            className="w-1.5 h-1.5 rounded-full animate-subtle-pulse shrink-0"
                            style={{ background: 'var(--vl-critical)' }}
                            title="Critical findings recorded"
                          />
                        )}
                        {item.badge && (
                          <span
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded-full font-semibold"
                            style={{
                              background: 'rgba(98,229,232,0.1)',
                              color: 'var(--vl-ice-cyan)',
                              border: '1px solid rgba(98,229,232,0.2)',
                            }}
                          >
                            {item.badge}
                          </span>
                        )}
                        {active && !item.badge && !item.alert && (
                          <ChevronRight className="w-3 h-3" style={{ color: 'var(--vl-ice-cyan)' }} />
                        )}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer — SHA-256 status strip + collapse */}
      <div
        className="shrink-0 p-3 space-y-2"
        style={{ borderTop: '1px solid var(--vl-border)' }}
      >
        {!collapsed && (
          <div
            className="px-2.5 py-2 rounded-lg space-y-1 text-[10px]"
            style={{
              background: 'var(--vl-surface-elevated)',
              border: '1px solid var(--vl-border)',
            }}
          >
            <div className="flex items-center justify-between">
              <span style={{ color: 'var(--vl-text-dim)' }}>Integrity Standard</span>
              <span className="font-mono font-semibold" style={{ color: 'var(--vl-ice-cyan)' }}>SHA-256</span>
            </div>
            <div className="flex items-center justify-between">
              <span style={{ color: 'var(--vl-text-dim)' }}>Chain Verified</span>
              <span className="font-mono" style={{ color: 'var(--vl-success)' }}>Active</span>
            </div>
          </div>
        )}

        {/* Desktop collapse toggle */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="hidden lg:flex w-full items-center justify-center gap-2 py-1.5 rounded-lg text-xs transition-all duration-200"
          style={{
            background: 'var(--vl-surface-elevated)',
            border: '1px solid var(--vl-border)',
            color: 'var(--vl-text-dim)',
          }}
          title={collapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
        >
          {collapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <>
              <ChevronLeft className="w-3.5 h-3.5" />
              <span className="text-[11px]">Collapse</span>
            </>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside
        className="hidden lg:flex flex-col shrink-0 transition-all duration-200"
        style={{
          width: collapsed ? '56px' : '220px',
          background: 'linear-gradient(180deg, rgba(16,22,33,0.96), rgba(9,13,20,0.92))',
          borderRight: '1px solid var(--vl-border)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          boxShadow: 'inset -1px 0 0 rgba(255,255,255,0.03)',
        }}
      >
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      {isMobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0"
            style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
            onClick={onCloseMobile}
          />
          <div
            className="relative w-64 max-w-[85vw] h-full shadow-2xl"
            style={{ background: 'var(--vl-surface)', borderRight: '1px solid var(--vl-border)' }}
          >
            <SidebarContent />
          </div>
        </div>
      )}
    </>
  );
};
