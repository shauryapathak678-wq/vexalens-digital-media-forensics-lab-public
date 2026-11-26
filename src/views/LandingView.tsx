import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  Archive,
  BookOpen,
  FileCheck2,
  ScanSearch,
} from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { DestinationCard, type DestinationCardConfig } from '@/components/common/DestinationCard';
import type { PortalSection } from '@/views/MainPortalView';
import { getAuthUser, getSupabaseConnectionStatus, isSupabaseConfigured, onAuthStateChange, CONNECTION_STATUS_EVENT } from '@/lib/supabase';
import { GlassCard } from '@/components/common/GlassCard';
import { GlassButton } from '@/components/common/GlassButton';
import originalSample from '@/assets/images/evidence_sample_portrait_original_1792052939398.jpg';
import analyzedSample from '@/assets/images/evidence_sample_portrait_deepfake_1792052935476.jpg';

interface LandingViewProps {
  onStartAnalysis: () => void;
  onOpenInformation: () => void;
  onOpenDestination: (destination: PortalSection) => void;
  isAdministrator: boolean;
}

const stages = [
  { index: '01', title: 'Evidence in', detail: 'Register the original file and preserve its integrity.', icon: Archive },
  { index: '02', title: 'Analysis', detail: 'Examine media with focused forensic tools.', icon: ScanSearch },
  { index: '03', title: 'Findings', detail: 'Record observations, methods, and limitations.', icon: FileCheck2 },
  { index: '04', title: 'Report', detail: 'Prepare a traceable, investigator-reviewed report.', icon: BookOpen },
];

const destinations: (DestinationCardConfig & { id: PortalSection })[] = [
  { id: 'lab', title: 'Forensic Lab', description: 'Purpose-built tools for image, video, audio, and document examination.', accent: '#5CE1FF', route: 'upload', icon: 'flask', visual: 'lab' },
  { id: 'admin', title: 'Command Center', description: 'Manage investigations and review operational activity.', accent: '#9B8CFF', route: 'admin', icon: 'shield', visual: 'admin' },
  { id: 'evidence_room', title: 'Evidence Vault', description: 'Browse evidence, integrity details, and custody records.', accent: '#61D5A8', route: 'evidence_room', icon: 'folder', visual: 'evidence' },
  { id: 'history_room', title: 'Investigation Archives', description: 'Return to findings and generated forensic reports.', accent: '#E6B86A', route: 'history_room', icon: 'archive', visual: 'history' },
];

export const LandingView: React.FC<LandingViewProps> = ({ onStartAnalysis, onOpenInformation, onOpenDestination, isAdministrator }) => {
  const [reveal, setReveal] = useState(52);
  const [transitionDestination, setTransitionDestination] = useState<string | null>(null);
  const destinationGridRef = useRef<HTMLDivElement>(null);
  const [authStatus, setAuthStatus] = useState<'checking' | 'signed_in' | 'signed_out'>('checking');
  const [serviceStatus, setServiceStatus] = useState(() => getSupabaseConnectionStatus().status);

  useEffect(() => {
    let active = true;
    const updateAuth = (signedIn: boolean) => {
      if (active) setAuthStatus(signedIn ? 'signed_in' : 'signed_out');
    };

    void getAuthUser()
      .then((user) => updateAuth(Boolean(user)))
      .catch((error: unknown) => {
        console.error('[Landing] Could not read authentication status:', error);
        updateAuth(false);
      });

    const unsubscribe = onAuthStateChange((_event, session) => updateAuth(Boolean(session?.user)));
    const updateService = () => setServiceStatus(getSupabaseConnectionStatus().status);
    window.addEventListener(CONNECTION_STATUS_EVENT, updateService);

    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener(CONNECTION_STATUS_EVENT, updateService);
    };
  }, []);

  useEffect(() => {
    const grid = destinationGridRef.current;
    if (!grid) return;
    const revealCards = () => {
      grid.classList.add('is-revealed');
      grid.closest('.lens-destinations')?.querySelector('.destination-heading')?.classList.add('is-revealed');
      grid.querySelectorAll<HTMLElement>('.destination-card').forEach((card, index) => {
        card.style.setProperty('--reveal-delay', `${index * 80}ms`);
      });
    };

    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealCards();
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        revealCards();
        observer.disconnect();
      }
    }, { threshold: 0.12 });
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const serviceLabel = serviceStatus === 'passed'
    ? 'Supabase verified'
    : serviceStatus === 'failed'
      ? 'Supabase check failed'
      : isSupabaseConfigured()
        ? 'Supabase not checked'
        : 'Local workspace';

  return (
    <main className="lens-landing">
      <div className="lens-landing-grid" aria-hidden="true" />
      <header className="lens-landing-header">
        <div className="lens-brand">
          <BrandLogo className="lens-brand-logo" />
          <div>
            <strong>VEXALENS</strong>
            <span>Digital Media Forensics</span>
          </div>
        </div>
        <nav aria-label="Landing navigation" className="lens-landing-nav">
          <a href="#method">Method</a>
          <a href="#destinations">Workspaces</a>
          <a href="#demo">Demo</a>
          <button type="button" onClick={onOpenInformation}>About</button>
        </nav>
        <button type="button" className="lens-nav-about" onClick={onStartAnalysis}>Enter Lab</button>
      </header>

      <section className="lens-hero">
        <div className="lens-hero-copy">
          <div className="lens-eyebrow"><span /> DIGITAL EVIDENCE / ANALYSIS WORKSPACE</div>
          <h1 className="lens-title">VEXALENS</h1>
          <p className="lens-tagline">Every Pixel. Every Signal. Every Clue.</p>
          <p className="lens-intro">
            A focused forensic workspace to examine digital evidence, document what you observe, and preserve the context behind every finding.
          </p>
          <div className="lens-hero-actions">
            <GlassButton variant="primary" className="lens-button lens-button-primary" onClick={onStartAnalysis}>
              Enter Forensic Laboratory <ArrowRight aria-hidden="true" />
            </GlassButton>
            <a className="lens-button lens-button-quiet" href="#destinations">
              Explore Investigation Tools <ArrowDown aria-hidden="true" />
            </a>
          </div>
          <div className="lens-status-strip" aria-label="Current application status">
            <span><i className={`lens-status-dot ${serviceStatus === 'passed' ? 'is-good' : ''}`} />{serviceLabel}</span>
            <span><i className="lens-status-dot" />Auth {authStatus === 'checking' ? 'checking' : authStatus === 'signed_in' ? 'signed in' : 'signed out'}</span>
            <span className="lens-build">{import.meta.env.MODE === 'production' ? 'Production build' : 'Development build'}</span>
          </div>
        </div>

        <div className="lens-scene" aria-label="Three-dimensional VexaLens logo">
          <div className="lens-orbit lens-orbit-outer" />
          <div className="lens-orbit lens-orbit-inner" />
          <div className="lens-logo-aura" aria-hidden="true" />
          <div className="lens-logo-3d">
            <BrandLogo className="lens-hero-logo" />
          </div>
        </div>
      </section>

      <section id="method" className="lens-method" aria-label="Forensic workflow">
        <div className="lens-section-heading">
          <span>THE INVESTIGATION FLOW</span>
          <h2>Bring evidence into focus.</h2>
        </div>
        <div className="lens-pipeline">
          {stages.map(({ index, title, detail, icon: Icon }) => (
            <GlassCard as="article" key={index} depth="base" className="lens-stage">
              <span className="lens-stage-index">{index}</span>
              <Icon aria-hidden="true" />
              <h3>{title}</h3>
              <p>{detail}</p>
            </GlassCard>
          ))}
        </div>
      </section>

      <section id="destinations" className="lens-destinations">
        <div className="lens-section-heading destination-heading">
          <span>FOUR INVESTIGATION SPACES</span>
          <h2>One clear path from intake to archive.</h2>
        </div>
        <div className="lens-destination-grid" ref={destinationGridRef}>
          {destinations.map((config, index) => (
            <DestinationCard
              key={config.id}
              config={config}
              index={index + 1}
              featured={index === 0}
              locked={config.id === 'admin' && !isAdministrator}
              lockedReason="Administrator role required to access case management and oversight controls."
              entering={transitionDestination === config.id}
              dimmed={transitionDestination !== null && transitionDestination !== config.id}
              onSelect={() => {
                if (transitionDestination) return;
                setTransitionDestination(config.id);
                window.setTimeout(() => onOpenDestination(config.id), 240);
              }}
            />
          ))}
        </div>
      </section>

      <section id="demo" className="lens-demo">
        <div className="lens-demo-copy">
          <span className="lens-demo-kicker">INTERACTIVE SAMPLE / NOT A CASE RESULT</span>
          <h2>See what a closer look can reveal.</h2>
          <p>Move the divider to compare bundled sample imagery. This demonstration is illustrative and is not an analysis result.</p>
          <label htmlFor="lens-compare-range">Image comparison position</label>
          <input
            id="lens-compare-range"
            type="range"
            min="5"
            max="95"
            value={reveal}
            onChange={(event) => setReveal(Number(event.target.value))}
            style={{ '--compare-position': `${reveal}%` } as React.CSSProperties}
          />
        </div>
        <div className="lens-compare" style={{ '--compare-position': `${reveal}%` } as React.CSSProperties}>
          <img src={originalSample} alt="Bundled original portrait sample" />
          <img className="lens-compare-overlay" src={analyzedSample} alt="Bundled altered portrait sample" />
          <span className="lens-compare-label before">SAMPLE A</span>
          <span className="lens-compare-label after">SAMPLE B</span>
          <span className="lens-compare-divider" aria-hidden="true" />
        </div>
      </section>

      <footer className="lens-footer">
        <span>PRIVATE BY DESIGN</span><span>SHA-256 EVIDENCE WORKFLOWS</span><span>INVESTIGATOR CONTROLLED</span>
        <button type="button" className="lens-footer-about" onClick={onOpenInformation}>About VexaLens</button>
      </footer>
    </main>
  );
};
