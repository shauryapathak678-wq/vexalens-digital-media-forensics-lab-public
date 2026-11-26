import React from 'react';
import { ArrowUpRight, LockKeyhole } from 'lucide-react';

export type DestinationVisual = 'lab' | 'admin' | 'evidence' | 'history';
export type DestinationIcon = 'flask' | 'shield' | 'folder' | 'archive';

export interface DestinationCardConfig {
  id: string;
  title: string;
  eyebrow?: string;
  description: string;
  tags?: string[];
  accent: string;
  route: string;
  icon: DestinationIcon;
  visual: DestinationVisual;
}

interface DestinationCardProps {
  config: DestinationCardConfig;
  index: number;
  featured?: boolean;
  locked?: boolean;
  lockedReason?: string;
  entering?: boolean;
  dimmed?: boolean;
  onSelect: () => void;
  onActivate?: (id: string | null) => void;
}

const DestinationVisualLayer: React.FC<{ visual: DestinationVisual }> = ({ visual }) => (
  <span className={`destination-visual destination-visual--${visual}`} aria-hidden="true">
    {visual === 'lab' && (
      <>
        <span className="destination-image-frame">
          <i className="destination-detection-box detection-box--one" />
          <i className="destination-detection-box detection-box--two" />
          <i className="destination-scan-beam" />
        </span>
        <span className="destination-visual-caption">FRAME / 001</span>
      </>
    )}
    {visual === 'admin' && (
      <span className="destination-admin-stack">
        <i /><i /><i />
        <span className="destination-status-chip"><b /> ACTIVE</span>
      </span>
    )}
    {visual === 'evidence' && (
      <>
        <span className="destination-vault-grid">{Array.from({ length: 6 }, (_, index) => <i className={index === 4 ? 'is-highlighted' : ''} key={index} />)}</span>
        <span className="destination-hashline">EVIDENCE / SEALED</span>
      </>
    )}
    {visual === 'history' && (
      <span className="destination-document-stack">
        <i /><i /><i />
        <span>REPORT / ARCHIVE</span>
      </span>
    )}
  </span>
);

export const DestinationCard: React.FC<DestinationCardProps> = ({
  config,
  index,
  featured = false,
  locked = false,
  lockedReason,
  entering = false,
  dimmed = false,
  onSelect,
  onActivate,
}) => {
  const { title, eyebrow, description, tags = [], accent, icon, visual } = config;

  const updatePointerLighting = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'touch' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 100;
    const y = ((event.clientY - bounds.top) / bounds.height) * 100;
    event.currentTarget.style.setProperty('--mx', `${x}%`);
    event.currentTarget.style.setProperty('--my', `${y}%`);
    event.currentTarget.style.setProperty('--tilt-x', `${(50 - y) * 0.06}deg`);
    event.currentTarget.style.setProperty('--tilt-y', `${(x - 50) * 0.08}deg`);
  };

  const resetPointerLighting = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.style.setProperty('--tilt-x', '0deg');
    event.currentTarget.style.setProperty('--tilt-y', '0deg');
  };

  return (
    <button
      type="button"
      className={`destination-card destination-card--${visual}${featured ? ' is-featured' : ''}${locked ? ' is-locked' : ''}${entering ? ' is-entering' : ''}${dimmed ? ' is-dimmed' : ''}`}
      style={{ '--destination-accent': accent } as React.CSSProperties}
      aria-label={locked ? `${title}, ${lockedReason ?? 'access restricted'}` : `Open ${title}`}
      aria-disabled={locked}
      title={locked ? lockedReason : undefined}
      onClick={locked ? undefined : onSelect}
      onPointerEnter={() => !locked && onActivate?.(config.id)}
      onPointerMove={updatePointerLighting}
      onPointerLeave={(event) => {
        resetPointerLighting(event);
        onActivate?.(null);
      }}
      onFocus={() => onActivate?.(config.id)}
      onBlur={() => onActivate?.(null)}
    >
      <span className="destination-card-noise" aria-hidden="true" />
      <span className="destination-card-glow" aria-hidden="true" />
      <DestinationVisualLayer visual={visual} />
      <span className="destination-card-head">
        <span className="destination-icon-tile">
          {locked ? <LockKeyhole aria-hidden="true" /> : <DestinationIconView icon={icon} />}
        </span>
        <span className="destination-index">{String(index).padStart(2, '0')}</span>
      </span>
      <span className="destination-card-copy">
        {eyebrow && <span className="destination-eyebrow">{eyebrow}</span>}
        <span className="destination-title">{title}</span>
        <span className="destination-description">{locked ? lockedReason : description}</span>
      </span>
      {tags.length > 0 && (
        <span className="destination-tags" aria-label="Workspace features">
          {tags.map((tag) => <span key={tag}>{tag}</span>)}
        </span>
      )}
      <span className="destination-card-footer">
        <span>{locked ? 'ACCESS RESTRICTED' : 'OPEN WORKSPACE'}</span>
        {!locked && <ArrowUpRight aria-hidden="true" />}
      </span>
    </button>
  );
};

const DestinationIconView: React.FC<{ icon: DestinationIcon }> = ({ icon }) => {
  const className = 'destination-main-icon';
  switch (icon) {
    case 'flask': return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6M10 3v6l-5.3 9.2A2 2 0 0 0 6.4 21h11.2a2 2 0 0 0 1.7-2.8L14 9V3M8 15h8" /><path d="M9 18h6" /></svg>;
    case 'shield': return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 20 6v5c0 5-3.4 8.3-8 10-4.6-1.7-8-5-8-10V6l8-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
    case 'folder': return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2h6.5A1.5 1.5 0 0 1 20 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Z" /><path d="M8 11h8M8 14h5" /></svg>;
    case 'archive': return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5.5A1.5 1.5 0 0 1 4 18.5v-13Z" /><path d="M8 9h8M8 12h8M8 15h5" /><path d="M7 4v3" /></svg>;
  }
};
