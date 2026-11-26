import React, { useEffect, useRef, useState } from 'react';
import { DestinationCard, type DestinationCardConfig } from '@/components/common/DestinationCard';

export type PortalSection = 'lab' | 'admin' | 'evidence_room' | 'history_room';

interface MainPortalViewProps {
  isAdministrator: boolean;
  onRefreshProfile: () => Promise<string>;
  onSignInToSupabase: () => void;
  onSelectSection: (section: PortalSection) => void;
}

const cards: (Omit<DestinationCardConfig, 'id'> & { id: PortalSection; restricted?: boolean })[] = [
  {
    id: 'lab',
    title: 'LAB',
    eyebrow: 'Forensic Intelligence',
    description: 'Investigate digital evidence using specialized forensic tools and AI-assisted analysis workflows.',
    tags: ['AI-generated image detection', 'Deepfake analysis', 'Metadata & integrity checks'],
    accent: '#62E5E8',
    route: 'lab',
    icon: 'flask',
    visual: 'lab',
  },
  {
    id: 'admin',
    title: 'ADMIN',
    eyebrow: 'Investigation Command',
    description: 'Manage investigations, monitor progress, review evidence, and access generated reports from one command layer.',
    tags: ['Case oversight', 'Evidence handling', 'Report review'],
    accent: '#9B8CFF',
    route: 'admin',
    icon: 'shield',
    visual: 'admin',
    restricted: true,
  },
  {
    id: 'evidence_room',
    title: 'EVIDENCE ROOM',
    eyebrow: 'Digital Evidence Vault',
    description: 'Browse, organize, and inspect evidence associated with each investigation case in a secure evidence vault.',
    tags: ['Case file metadata', 'Processing status', 'Chain-of-custody records'],
    accent: '#61D5A8',
    route: 'evidence_room',
    icon: 'folder',
    visual: 'evidence',
  },
  {
    id: 'history_room',
    title: 'HISTORY ROOM',
    eyebrow: 'Investigation Archive',
    description: 'Access previous investigations, saved reports, and downloaded forensic findings from the archive.',
    tags: ['Saved reports', 'Prior analyses', 'Evidence references'],
    accent: '#E6B86A',
    route: 'history_room',
    icon: 'archive',
    visual: 'history',
  },
];

export const MainPortalView: React.FC<MainPortalViewProps> = ({
  isAdministrator,
  onRefreshProfile,
  onSignInToSupabase,
  onSelectSection,
}) => {
  const [refreshingProfile, setRefreshingProfile] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');
  const [enteringDestination, setEnteringDestination] = useState<PortalSection | null>(null);
  const destinationGridRef = useRef<HTMLDivElement>(null);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const grid = destinationGridRef.current;
    if (!grid) return;
    const cardsToReveal = grid.querySelectorAll<HTMLElement>('.destination-card');
    const reveal = () => {
      grid.classList.add('is-revealed');
      grid.closest('.portal-content')?.querySelector('.destination-section-heading')?.classList.add('is-revealed');
      cardsToReveal.forEach((card, index) => {
        card.style.setProperty('--reveal-delay', `${index * 80}ms`);
      });
    };

    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      reveal();
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        reveal();
        observer.disconnect();
      }
    }, { threshold: 0.12 });
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current);
  }, []);

  const handleRefreshProfile = async () => {
    setRefreshingProfile(true);
    setProfileMessage('');
    try {
      setProfileMessage(await onRefreshProfile());
    } finally {
      setRefreshingProfile(false);
    }
  };

  return (
    <main className="portal-shell min-h-screen px-5 py-12 text-[var(--vl-text-primary)] sm:px-8 sm:py-16">
      <div className="portal-content">
        <div className="destination-section-heading mb-10 max-w-2xl sm:mb-12">
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[.24em] text-[var(--vl-ice-cyan)]">Investigation workspace</p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Select your investigative destination</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--vl-text-secondary)] sm:text-base">
            Every workspace keeps the tools and records structured for a specific stage of your forensic workflow.
          </p>
          {!isAdministrator && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleRefreshProfile}
                disabled={refreshingProfile}
                className="rounded-lg border border-[var(--vl-border)] px-3 py-2 text-xs font-semibold text-[var(--vl-text-secondary)] hover:text-[var(--vl-text-primary)] disabled:opacity-50"
              >
                {refreshingProfile ? 'Checking Supabase role…' : 'Refresh Supabase access'}
              </button>
              <button
                type="button"
                onClick={onSignInToSupabase}
                className="rounded-lg border border-cyan-700/50 px-3 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-950/30"
              >
                Sign in to Supabase
              </button>
              {profileMessage && (
                <p role="status" className="mt-2 w-full text-xs text-[var(--vl-text-secondary)]">
                  {profileMessage}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="portal-grid" ref={destinationGridRef} aria-label="Investigative destinations">
          {cards.map((config, index) => {
            const { id, title, restricted } = config;
            const locked = Boolean(restricted && !isAdministrator);
            return (
              <DestinationCard
                key={id}
                config={config}
                index={index + 1}
                featured={id === 'lab'}
                locked={locked}
                lockedReason="Administrator role required to access case management and oversight controls."
                entering={enteringDestination === id}
                dimmed={enteringDestination !== null && enteringDestination !== id}
                onSelect={() => {
                  if (enteringDestination) return;
                  setEnteringDestination(id);
                  transitionTimeoutRef.current = setTimeout(() => onSelectSection(id), 240);
                }}
              />
            );
          })}
        </div>
      </div>
    </main>
  );
};
