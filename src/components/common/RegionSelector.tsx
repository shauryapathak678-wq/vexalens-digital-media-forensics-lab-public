import React, { useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';

/** Region rectangle expressed as fractions (0..1) of the source image. */
export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_REGION: RegionRect = { x: 0, y: 0, width: 1, height: 1 };

interface RegionSelectorProps {
  imageSrc: string;
  alt: string;
  region: RegionRect;
  onChange: (region: RegionRect) => void;
  accent?: 'cyan' | 'rose';
  label?: string;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Lets the user drag a rectangle over an image to define the signature/stamp
 * region of interest. Coordinates are stored as fractions so they map exactly
 * onto the underlying source pixels used by the analysis pipeline.
 */
export const RegionSelector: React.FC<RegionSelectorProps> = ({
  imageSrc,
  alt,
  region,
  onChange,
  accent = 'cyan',
  label,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<RegionRect | null>(null);
  const [aspect, setAspect] = useState<string>('2 / 1');

  const accentBorder = accent === 'rose' ? 'border-rose-400' : 'border-cyan-400';
  const active = draft ?? region;

  const toFraction = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: clamp01((clientX - rect.left) / rect.width),
      y: clamp01((clientY - rect.top) / rect.height),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    containerRef.current?.setPointerCapture(e.pointerId);
    const p = toFraction(e.clientX, e.clientY);
    setDragStart(p);
    setDraft({ x: p.x, y: p.y, width: 0, height: 0 });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart) return;
    const p = toFraction(e.clientX, e.clientY);
    setDraft({
      x: Math.min(dragStart.x, p.x),
      y: Math.min(dragStart.y, p.y),
      width: Math.abs(p.x - dragStart.x),
      height: Math.abs(p.y - dragStart.y),
    });
  };

  const handlePointerUp = () => {
    if (draft && draft.width > 0.02 && draft.height > 0.02) {
      onChange(draft);
    }
    setDragStart(null);
    setDraft(null);
  };

  return (
    <div className="space-y-2">
      {label && (
        <span className={`text-[11px] font-semibold uppercase tracking-wider block ${accent === 'rose' ? 'text-rose-400' : 'text-cyan-400'}`}>
          {label}
        </span>
      )}
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ aspectRatio: aspect }}
        className="relative w-full bg-slate-900 rounded-lg border border-slate-800 overflow-hidden cursor-crosshair select-none touch-none"
      >
        <img
          src={imageSrc}
          alt={alt}
          draggable={false}
          onLoad={(e) => {
            const el = e.currentTarget;
            if (el.naturalWidth && el.naturalHeight) {
              setAspect(`${el.naturalWidth} / ${el.naturalHeight}`);
            }
          }}
          className="w-full h-full object-contain pointer-events-none"
        />
        <div
          style={{
            left: `${active.x * 100}%`,
            top: `${active.y * 100}%`,
            width: `${active.width * 100}%`,
            height: `${active.height * 100}%`,
          }}
          className={`absolute ${accentBorder} border-2 rounded-sm shadow-[0_0_0_9999px_rgba(2,6,23,0.6)] pointer-events-none`}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
        <span>
          x {Math.round(active.x * 100)}% · y {Math.round(active.y * 100)}% · w {Math.round(active.width * 100)}% · h {Math.round(active.height * 100)}%
        </span>
        <button
          type="button"
          onClick={() => onChange(FULL_REGION)}
          className="flex items-center gap-1 text-slate-400 hover:text-slate-200 transition-colors"
        >
          <RotateCcw className="w-3 h-3" /> Full frame
        </button>
      </div>
    </div>
  );
};
