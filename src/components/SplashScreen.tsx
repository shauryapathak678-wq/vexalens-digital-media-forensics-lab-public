import React, { useEffect, useState } from 'react';
import { BrandLogo } from '@/components/BrandLogo';

interface SplashScreenProps {
  onEnter: () => void;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ onEnter }) => {
  const [phase, setPhase] = useState<'hidden' | 'logo' | 'ready'>('hidden');

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('logo'), 100);
    const t2 = setTimeout(() => setPhase('ready'), 1200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div
      id="vexalens-splash"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#060A13',
        backgroundImage:
          'radial-gradient(ellipse 70% 60% at 50% 40%, rgba(98,229,232,0.06) 0%, rgba(100,140,255,0.04) 40%, transparent 70%)',
        overflow: 'hidden',
        fontFamily: "'Inter', 'Plus Jakarta Sans', system-ui, sans-serif",
      }}
    >
      {/* Subtle grid */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          backgroundImage:
            'linear-gradient(rgba(39,50,68,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(39,50,68,0.08) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      {/* Animated rings */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        {[280, 380, 490].map((size, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              width: size,
              height: size,
              borderRadius: '50%',
              border: '1px solid rgba(98,229,232,0.06)',
              animation: `splash-pulse ${2.5 + i * 0.8}s ease-in-out infinite`,
              animationDelay: `${i * 0.4}s`,
            }}
          />
        ))}
      </div>

      {/* Content */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 28,
        }}
      >
        {/* Logo mark + brand name */}
        <div
          style={{
            opacity: phase === 'hidden' ? 0 : 1,
            transform: phase === 'hidden' ? 'scale(0.88) translateY(12px)' : 'scale(1) translateY(0)',
            transition: 'opacity 0.8s cubic-bezier(0.22,1,0.36,1), transform 0.8s cubic-bezier(0.22,1,0.36,1)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 20,
          }}
        >
          {/* VexaLens brand logo */}
          <div
            style={{
              width: 132,
              height: 132,
              overflow: 'hidden',
              borderRadius: '50%',
              filter: 'drop-shadow(0 0 24px rgba(98,140,255,0.22))',
            }}
          >
            <BrandLogo className="h-full w-full object-cover" />
          </div>

          {/* Brand */}
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontSize: 42,
                fontWeight: 800,
                letterSpacing: '-0.04em',
                background: 'linear-gradient(135deg, #F4F7FC 30%, rgba(98,229,232,0.85) 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                lineHeight: 1.1,
              }}
            >
              VexaLens
            </div>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                color: 'rgba(98,229,232,0.65)',
                marginTop: 7,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              Digital Media Forensics Laboratory
            </div>
          </div>
        </div>

        {/* Tagline */}
        <div
          style={{
            opacity: phase === 'ready' ? 1 : 0,
            transform: phase === 'ready' ? 'translateY(0)' : 'translateY(10px)',
            transition: 'opacity 0.55s ease, transform 0.55s ease',
            fontSize: 15.5,
            color: 'rgba(154,168,188,0.8)',
            letterSpacing: '0.01em',
            textAlign: 'center',
            fontStyle: 'italic',
          }}
        >
          Truth Behind Every Pixel.
        </div>

        {/* Divider */}
        <div
          style={{
            opacity: phase === 'ready' ? 1 : 0,
            transition: 'opacity 0.5s ease 0.08s',
            width: 52,
            height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(98,229,232,0.38), transparent)',
          }}
        />

        {/* Buttons */}
        <div
          style={{
            opacity: phase === 'ready' ? 1 : 0,
            transform: phase === 'ready' ? 'translateY(0)' : 'translateY(18px)',
            transition: 'opacity 0.6s ease 0.12s, transform 0.6s ease 0.12s',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <button
            id="splash-begin-btn"
            onClick={onEnter}
            style={{
              padding: '13px 52px',
              background:
                'linear-gradient(135deg, rgba(98,229,232,0.15) 0%, rgba(100,140,255,0.12) 100%)',
              border: '1px solid rgba(98,229,232,0.4)',
              borderRadius: 10,
              color: '#62E5E8',
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              transition: 'all 0.2s',
              boxShadow: '0 0 20px rgba(98,229,232,0.1)',
              fontFamily: "'Inter', sans-serif",
            }}
            onMouseEnter={e => {
              Object.assign(e.currentTarget.style, {
                background:
                  'linear-gradient(135deg, rgba(98,229,232,0.22) 0%, rgba(100,140,255,0.18) 100%)',
                borderColor: 'rgba(98,229,232,0.7)',
                boxShadow: '0 0 32px rgba(98,229,232,0.22), 0 0 8px rgba(98,229,232,0.12)',
                transform: 'translateY(-1px)',
              });
            }}
            onMouseLeave={e => {
              Object.assign(e.currentTarget.style, {
                background:
                  'linear-gradient(135deg, rgba(98,229,232,0.15) 0%, rgba(100,140,255,0.12) 100%)',
                borderColor: 'rgba(98,229,232,0.4)',
                boxShadow: '0 0 20px rgba(98,229,232,0.1)',
                transform: 'translateY(0)',
              });
            }}
          >
            Begin Investigation
          </button>
          <button
            id="splash-skip-btn"
            onClick={onEnter}
            style={{
              background: 'none',
              border: 'none',
              color: 'rgba(94,111,134,0.7)',
              fontSize: 11,
              cursor: 'pointer',
              letterSpacing: '0.05em',
              fontFamily: "'JetBrains Mono', monospace",
              transition: 'color 0.2s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'rgba(154,168,188,0.9)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'rgba(94,111,134,0.7)')}
          >
            Skip →
          </button>
        </div>

        {/* ISO notice */}
        <div
          style={{
            opacity: phase === 'ready' ? 0.42 : 0,
            transition: 'opacity 0.7s ease 0.28s',
            fontSize: 9,
            color: 'rgba(94,111,134,0.9)',
            letterSpacing: '0.14em',
            fontFamily: "'JetBrains Mono', monospace",
            textTransform: 'uppercase',
            marginTop: 4,
          }}
        >
          ISO/IEC 27037 · SWGMAT · ASTM E2290 Aligned
        </div>
      </div>

      <style>{`
        @keyframes splash-pulse {
          0%, 100% { opacity: 0.35; transform: scale(1); }
          50% { opacity: 0.85; transform: scale(1.022); }
        }
      `}</style>
    </div>
  );
};
