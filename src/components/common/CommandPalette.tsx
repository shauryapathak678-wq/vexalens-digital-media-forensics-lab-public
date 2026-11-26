import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  LayoutDashboard,
  Image as ImageIcon,
  BrainCircuit,
  BookOpen,
  Video,
  Music,
  ScanFace,
  FileText,
  Sliders,
  UploadCloud,
  FolderGit2,
  Moon,
  Sun,
  X,
  ArrowRight,
} from 'lucide-react';
import { NavTab } from '../layout/Sidebar';
import { EvidenceItem, Investigation } from '@/types/forensics';
import { BrandLogo } from '@/components/BrandLogo';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateTab: (tab: NavTab) => void;
  evidenceList: EvidenceItem[];
  investigations: Investigation[];
  onSelectCase: (c: Investigation) => void;
  onSelectEvidence: (e: EvidenceItem) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onNavigateTab,
  evidenceList,
  investigations,
  onSelectCase,
  onSelectEvidence,
  theme,
  onToggleTheme,
}) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
    }
  }, [isOpen]);

  // Handle Ctrl+K / Cmd+K global shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (isOpen) onClose();
        else {
          // Open triggered by parent if wired, or handled here
        }
      }
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const quickNav: Array<{ label: string; tab: NavTab; icon: React.ComponentType<{ className?: string }>; category: string }> = [
    { label: 'Investigation Dashboard', tab: 'dashboard', icon: LayoutDashboard, category: 'Navigation' },
    { label: 'About VexaLens — The Story Behind the Lens', tab: 'information', icon: BookOpen, category: 'Navigation' },
    { label: 'Image Forensics (ELA & EXIF)', tab: 'image_forensics', icon: ImageIcon, category: 'Forensic Tools' },
    { label: 'AI Image Detection (Puter Vision)', tab: 'ai_origin', icon: BrainCircuit, category: 'Forensic Tools' },
    { label: 'Video Deepfake Analysis', tab: 'video_forensics', icon: Video, category: 'Forensic Tools' },
    { label: 'Photo-to-Video Match', tab: 'photo_video_match', icon: ScanFace, category: 'Forensic Tools' },
    { label: 'Audio Forensics', tab: 'audio_forensics', icon: Music, category: 'Forensic Tools' },
    { label: 'Evidence Intake & Upload', tab: 'upload', icon: UploadCloud, category: 'Operations' },
    { label: 'Case Management', tab: 'investigations', icon: FolderGit2, category: 'Operations' },
    { label: 'Forensic Reports & Findings', tab: 'reports', icon: FileText, category: 'Reports' },
    { label: 'Settings & Credentials', tab: 'settings', icon: Sliders, category: 'System' },
  ];

  const filteredNav = quickNav.filter((n) =>
    n.label.toLowerCase().includes(query.toLowerCase())
  );

  const filteredEvidence = evidenceList
    .filter((e) => e.fileName.toLowerCase().includes(query.toLowerCase()) || e.sha256Hash?.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 4);

  const filteredCases = investigations
    .filter((c) => c.title.toLowerCase().includes(query.toLowerCase()) || c.caseNumber.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 3);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-xl rounded-xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden z-10 animate-in fade-in zoom-in-95 duration-150">
        {/* Search Input Bar */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-800 bg-slate-950/60">
          <Search className="w-4 h-4 text-cyan-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools, cases, evidence, or commands... (Esc to close)"
            className="w-full bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-slate-500 hover:text-slate-300">
              <X className="w-4 h-4" />
            </button>
          )}
          <kbd className="hidden sm:inline px-1.5 py-0.5 text-[10px] font-mono text-slate-400 bg-slate-800 rounded border border-slate-700">
            ESC
          </kbd>
        </div>

        {/* Results List */}
        <div className="max-h-[380px] overflow-y-auto p-2 space-y-4">
          {/* Quick Actions / Theme */}
          {!query && (
            <div className="space-y-1">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-2">
                Quick Actions
              </span>
              <button
                onClick={() => {
                  onToggleTheme();
                  onClose();
                }}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-slate-300 hover:text-slate-100 hover:bg-slate-800/60 transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-cyan-400" />}
                  <span>Switch to {theme === 'dark' ? 'Light' : 'Dark'} Mode</span>
                </div>
                <span className="text-[10px] text-slate-500">Theme</span>
              </button>
            </div>
          )}

          {/* Navigation Tools */}
          {filteredNav.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-2">
                Forensic Tools & Navigation
              </span>
              {filteredNav.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.tab}
                    onClick={() => {
                      onNavigateTab(item.tab);
                      onClose();
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-slate-300 hover:text-slate-100 hover:bg-slate-800/60 transition-colors text-left"
                  >
                    <div className="flex items-center gap-2.5">
                      <Icon className="w-4 h-4 text-cyan-400 shrink-0" />
                      <span>{item.label}</span>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                  </button>
                );
              })}
            </div>
          )}

          {/* Matching Evidence */}
          {filteredEvidence.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-2">
                Evidence Files
              </span>
              {filteredEvidence.map((ev) => (
                <button
                  key={ev.id}
                  onClick={() => {
                    onSelectEvidence(ev);
                    onNavigateTab(ev.mediaType === 'image' ? 'image_forensics' : ev.mediaType === 'video' ? 'video_forensics' : 'audio_forensics');
                    onClose();
                  }}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-slate-300 hover:text-slate-100 hover:bg-slate-800/60 transition-colors text-left"
                >
                  <div className="flex items-center gap-2.5 truncate">
                    <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                      {ev.mediaType}
                    </span>
                    <span className="truncate">{ev.fileName}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 shrink-0">
                    {Math.round(ev.fileSize / 1024)} KB
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Matching Cases */}
          {filteredCases.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-2">
                Investigations
              </span>
              {filteredCases.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    onSelectCase(c);
                    onNavigateTab('investigations');
                    onClose();
                  }}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-slate-300 hover:text-slate-100 hover:bg-slate-800/60 transition-colors text-left"
                >
                  <div className="flex items-center gap-2 truncate">
                    <span className="font-mono text-cyan-400 text-[11px] shrink-0">{c.caseNumber}</span>
                    <span className="truncate">{c.title}</span>
                  </div>
                  <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                    {c.status}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="px-4 py-2 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-[11px] text-slate-500">
          <span>Tip: Press <kbd className="font-mono text-slate-400">Ctrl+K</kbd> anywhere to open</span>
          <span className="flex items-center gap-1 font-mono text-[10px]">
            <BrandLogo className="h-5 w-5 rounded-sm object-cover" /> VexaLens Lab
          </span>
        </div>
      </div>
    </div>
  );
};
