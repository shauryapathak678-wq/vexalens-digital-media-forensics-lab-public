import React, { useState } from 'react';
import { UserProfile, Investigation } from '@/types/forensics';
import type { ExperienceMode } from './Sidebar';
import {
  ShieldCheck,
  ChevronDown,
  Search,
  Sun,
  Moon,
  Menu,
  Check,
  House,
  ChevronLeft,
} from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';

interface HeaderProps {
  user: UserProfile;
  currentCase?: Investigation;
  cases: Investigation[];
  onSelectCase: (c: Investigation) => void;
  onOpenAuth: () => void;
  onHome: () => void;
  onInformation: () => void;
  onBackToWorkspaces: () => void;
  experienceMode: ExperienceMode;
  onExperienceModeChange: (mode: ExperienceMode) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenCommandPalette: () => void;
  onToggleMobileSidebar?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  user,
  currentCase,
  cases,
  onSelectCase,
  onOpenAuth,
  onHome,
  onInformation,
  onBackToWorkspaces,
  experienceMode,
  onExperienceModeChange,
  theme,
  onToggleTheme,
  onOpenCommandPalette,
  onToggleMobileSidebar,
}) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const statusColors: Record<string, string> = {
    open: 'text-emerald-400',
    in_progress: 'text-sky-400',
    review: 'text-amber-400',
    closed: 'text-slate-500',
  };

  return (
    <header
      className="sticky top-0 z-30 flex min-h-[58px] items-center justify-between gap-2 px-3 py-2 sm:gap-3 sm:px-5 select-none"
      style={{
        background: theme === 'dark'
          ? 'linear-gradient(180deg, rgba(8, 11, 18, 0.96), rgba(8, 11, 18, 0.88))'
          : 'linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(247, 249, 252, 0.9))',
        borderBottom: '1px solid var(--vl-border)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        transition: 'background 0.25s ease',
        boxShadow: '0 1px 0 rgba(255,255,255,0.04)',
      }}
    >
      {/* LEFT: Mobile toggle + Brand */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          onClick={onToggleMobileSidebar}
          className="lg:hidden p-1.5 rounded-md transition-colors"
          style={{ color: 'var(--vl-text-secondary)' }}
          aria-label="Toggle Navigation"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* VexaLens Identity */}
        <div
          className="flex items-center gap-2.5"
        >
          {/* Brand Icon */}
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-all duration-200"
            style={{
              background: 'linear-gradient(135deg, rgba(98,229,232,0.15) 0%, rgba(100,140,255,0.2) 100%)',
              border: '1px solid rgba(98,229,232,0.3)',
              boxShadow: '0 0 14px rgba(98,229,232,0.12)',
            }}
          >
            <BrandLogo className="h-full w-full rounded-lg object-cover" />
          </div>

          <div className="flex flex-col leading-none gap-0.5">
            <div className="flex items-center gap-1.5">
              <span
                className="text-[13px] font-bold tracking-[-0.02em] transition-colors duration-200"
                style={{ color: 'var(--vl-text-primary)' }}
              >
                VexaLens
              </span>
              <span
                className="hidden sm:inline text-[9px] font-mono font-semibold px-1 py-0.5 rounded"
                style={{
                  background: 'rgba(98,229,232,0.1)',
                  color: 'var(--vl-ice-cyan)',
                  border: '1px solid rgba(98,229,232,0.25)',
                  letterSpacing: '0.05em',
                }}
              >
                FORENSICS
              </span>
            </div>
            <span
              className="text-[10px] font-mono hidden sm:block"
              style={{ color: 'var(--vl-text-dim)' }}
            >
              Truth Behind Every Pixel.
            </span>
          </div>
        </div>
      </div>

      <nav aria-label="Workspace navigation" className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onHome}
          aria-label="Home"
          title="Home"
          className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition-all duration-200 hover:text-cyan-200 sm:px-2.5"
          style={{ background: 'linear-gradient(180deg, rgba(15,23,42,0.7), rgba(10,15,24,0.7))', borderColor: 'var(--vl-border)', color: 'var(--vl-text-secondary)' }}
        >
          <House className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Home</span>
        </button>
        <button
          type="button"
          onClick={onInformation}
          aria-label="About VexaLens"
          title="About VexaLens"
          className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition-all duration-200 hover:text-cyan-200 sm:px-2.5"
          style={{ background: 'linear-gradient(180deg, rgba(15,23,42,0.7), rgba(10,15,24,0.7))', borderColor: 'var(--vl-border)', color: 'var(--vl-text-secondary)' }}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">About</span>
        </button>
        <button
          type="button"
          onClick={onBackToWorkspaces}
          aria-label="Back to Workspaces"
          title="Back to Workspaces"
          className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition-all duration-200 hover:text-cyan-200 sm:px-2.5"
          style={{ background: 'linear-gradient(180deg, rgba(15,23,42,0.7), rgba(10,15,24,0.7))', borderColor: 'var(--vl-border)', color: 'var(--vl-text-secondary)' }}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Back to Workspaces</span>
        </button>
      </nav>

      {/* CENTER-RIGHT: Search + Case scope */}
      <div className="hidden md:flex items-center gap-2.5 max-w-sm mx-2">
        {/* Command palette trigger — styled as a search bar */}
        <button
          id="header-search-trigger"
          onClick={onOpenCommandPalette}
          className="flex-1 flex items-center justify-between px-3 py-1.5 rounded-lg text-xs transition-all group"
          style={{
            background: 'var(--vl-surface-elevated)',
            border: '1px solid var(--vl-border)',
            color: 'var(--vl-text-secondary)',
          }}
        >
          <div className="flex items-center gap-2 truncate">
            <Search
              className="w-3.5 h-3.5 shrink-0 transition-colors group-hover:opacity-100"
              style={{ color: 'var(--vl-text-dim)' }}
            />
            <span className="truncate">Search evidence, cases, tools…</span>
          </div>
          <kbd
            className="hidden lg:inline text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 ml-2"
            style={{
              background: 'var(--vl-surface)',
              border: '1px solid var(--vl-border)',
              color: 'var(--vl-text-dim)',
            }}
          >
            Ctrl K
          </kbd>
        </button>

        {/* Case scope dropdown */}
        <div className="relative shrink-0">
          <button
            id="header-case-selector"
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all"
            style={{
              background: 'var(--vl-surface-elevated)',
              border: '1px solid var(--vl-border)',
              color: 'var(--vl-text-secondary)',
            }}
            title="Switch Active Investigation"
          >
            <span className="font-mono" style={{ color: 'var(--vl-text-dim)', fontSize: '10px' }}>CASE</span>
            <span
              className="font-mono font-semibold text-[11px] max-w-[100px] truncate"
              style={{ color: 'var(--vl-ice-cyan)' }}
            >
              {currentCase ? currentCase.caseNumber : 'All'}
            </span>
            <ChevronDown
              className="w-3 h-3 transition-transform duration-200"
              style={{
                color: 'var(--vl-text-dim)',
                transform: dropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              }}
            />
          </button>

          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
              <div
                className="absolute right-0 top-full mt-2 w-80 z-50 rounded-xl overflow-hidden py-1"
                style={{
                  background: 'var(--vl-surface)',
                  border: '1px solid var(--vl-border)',
                  boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
                }}
              >
                <div
                  className="px-3 pt-2.5 pb-2 text-[10px] font-semibold uppercase tracking-[0.1em]"
                  style={{ color: 'var(--vl-text-dim)' }}
                >
                  Active Investigation
                </div>
                <div className="max-h-60 overflow-y-auto">
                  {cases.map((c) => {
                    const isSelected = currentCase?.id === c.id;
                    return (
                      <button
                        key={c.id}
                        onClick={() => { onSelectCase(c); setDropdownOpen(false); }}
                        className="w-full text-left px-3 py-2.5 flex items-center gap-3 text-xs transition-all"
                        style={{
                          background: isSelected ? 'var(--vl-surface-elevated)' : 'transparent',
                          borderLeft: isSelected ? '2px solid var(--vl-ice-cyan)' : '2px solid transparent',
                        }}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span
                              className="font-mono font-semibold text-[11px]"
                              style={{ color: isSelected ? 'var(--vl-ice-cyan)' : 'var(--vl-text-primary)' }}
                            >
                              {c.caseNumber}
                            </span>
                            <span
                              className="text-[9px] font-semibold uppercase"
                              style={{ color: statusColors[c.status] || 'var(--vl-text-dim)' }}
                            >
                              {c.status.replace('_', ' ')}
                            </span>
                          </div>
                          <p
                            className="text-[11px] truncate"
                            style={{ color: 'var(--vl-text-secondary)' }}
                          >
                            {c.title}
                          </p>
                        </div>
                        {isSelected && (
                          <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--vl-ice-cyan)' }} />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* RIGHT: Mode toggle, theme, intake, profile */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Experience Mode pill */}
        <div
          className="hidden lg:flex items-center rounded-lg overflow-hidden shrink-0"
          style={{ border: '1px solid var(--vl-border)', background: 'var(--vl-surface-elevated)' }}
        >
          {(['beginner', 'expert'] as ExperienceMode[]).map((m) => (
            <button
              key={m}
              onClick={() => onExperienceModeChange(m)}
              className="px-2.5 py-1.5 text-[10px] font-semibold capitalize transition-all duration-150"
              style={{
                background: experienceMode === m ? 'var(--vl-surface)' : 'transparent',
                color: experienceMode === m ? 'var(--vl-text-primary)' : 'var(--vl-text-dim)',
                boxShadow: experienceMode === m ? '0 1px 3px rgba(0,0,0,0.2)' : 'none',
              }}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Theme toggle */}
        <button
          id="header-theme-toggle"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          className="p-2 rounded-lg transition-all duration-200"
          style={{
            background: 'var(--vl-surface-elevated)',
            border: '1px solid var(--vl-border)',
            color: 'var(--vl-text-secondary)',
          }}
        >
          {theme === 'dark' ? (
            <Sun className="w-3.5 h-3.5" style={{ color: '#F3BA60' }} />
          ) : (
            <Moon className="w-3.5 h-3.5" style={{ color: 'var(--vl-electric-blue)' }} />
          )}
        </button>

        {/* Investigator Profile */}
        <button
          id="header-profile-menu"
          onClick={onOpenAuth}
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-all text-xs"
          style={{
            background: 'var(--vl-surface-elevated)',
            border: '1px solid var(--vl-border)',
          }}
          title="Investigator Profile"
        >
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
            style={{
              background: 'linear-gradient(135deg, rgba(100,140,255,0.25) 0%, rgba(98,229,232,0.2) 100%)',
              border: '1px solid rgba(98,229,232,0.35)',
              color: 'var(--vl-ice-cyan)',
            }}
          >
            {user.fullName.charAt(0)}
          </div>
          <span className="hidden lg:inline font-medium text-[11px]" style={{ color: 'var(--vl-text-primary)' }}>
            {user.fullName.split(' ')[0]}
          </span>
        </button>
      </div>
    </header>
  );
};
