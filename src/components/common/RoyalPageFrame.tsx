import React, { lazy, Suspense, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

const RoyalScene = lazy(() => import('./RoyalScene'));

type RoyalPageVariant = 'evidence' | 'history' | 'lab' | 'admin';

interface RoyalPageFrameProps {
  variant: RoyalPageVariant;
  children: React.ReactNode;
}

interface NavigatorWithPerformanceHints extends Navigator {
  connection?: { saveData?: boolean };
  deviceMemory?: number;
}

interface SceneBoundaryProps {
  children: React.ReactNode;
}

interface SceneBoundaryState {
  failed: boolean;
}

class SceneBoundary extends React.Component<SceneBoundaryProps, SceneBoundaryState> {
  state: SceneBoundaryState = { failed: false };

  static getDerivedStateFromError(): SceneBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.warn('[RoyalPageFrame] Decorative 3D backdrop unavailable:', error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function findTiltCard(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target.closest<HTMLElement>('[data-royal-tilt]') : null;
}

export function RoyalPageFrame({ variant, children }: RoyalPageFrameProps) {
  const prefersReducedMotion = useReducedMotion();
  const [renderScene, setRenderScene] = useState(false);

  useEffect(() => {
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateScenePreference = () => {
      const hints = navigator as NavigatorWithPerformanceHints;
      const lowEndDevice =
        (hints.hardwareConcurrency > 0 && hints.hardwareConcurrency <= 4) ||
        (typeof hints.deviceMemory === 'number' && hints.deviceMemory <= 4) ||
        hints.connection?.saveData === true;

      setRenderScene(!motionPreference.matches && !lowEndDevice);
    };

    updateScenePreference();
    motionPreference.addEventListener('change', updateScenePreference);
    return () => motionPreference.removeEventListener('change', updateScenePreference);
  }, []);

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;

    const card = findTiltCard(event.target);
    if (!card) return;

    const bounds = card.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;

    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    card.style.setProperty('--royal-tilt-x', `${((0.5 - y) * 5).toFixed(2)}deg`);
    card.style.setProperty('--royal-tilt-y', `${((x - 0.5) * 5).toFixed(2)}deg`);
  };

  const handlePointerOut = (event: React.PointerEvent<HTMLDivElement>) => {
    const card = findTiltCard(event.target);
    if (!card || (event.relatedTarget instanceof Node && card.contains(event.relatedTarget))) return;
    card.style.removeProperty('--royal-tilt-x');
    card.style.removeProperty('--royal-tilt-y');
  };

  const handlePointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.querySelectorAll<HTMLElement>('[data-royal-tilt]').forEach((card) => {
      card.style.removeProperty('--royal-tilt-x');
      card.style.removeProperty('--royal-tilt-y');
    });
  };

  return (
    <motion.div
      className={`royal-page royal-page--${variant}`}
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
      onPointerLeave={handlePointerLeave}
      initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: prefersReducedMotion ? 0 : 0.36, ease: 'easeOut' }}
    >
      {renderScene && (
        <div className="royal-page__scene" aria-hidden="true">
          <SceneBoundary>
            <Suspense fallback={null}>
              <RoyalScene variant={variant} />
            </Suspense>
          </SceneBoundary>
        </div>
      )}
      <div className="royal-page__content">{children}</div>
    </motion.div>
  );
}
