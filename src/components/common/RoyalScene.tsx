import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Sparkles } from '@react-three/drei';
import type { Mesh } from 'three';

type RoyalSceneVariant = 'evidence' | 'history' | 'lab' | 'admin';

const ACCENTS: Record<RoyalSceneVariant, string> = {
  evidence: '#d9b866',
  history: '#aa91dd',
  lab: '#79c9a4',
  admin: '#d9b866',
};

function FloatingCrest({ color }: { color: string }) {
  const crest = useRef<Mesh>(null);

  useFrame((_, delta) => {
    if (crest.current) crest.current.rotation.y += delta * 0.045;
  });

  return (
    <Float speed={0.35} floatIntensity={0.16} rotationIntensity={0.08}>
      <mesh ref={crest} position={[4.3, 0.3, -2.5]} scale={1.5}>
        <icosahedronGeometry args={[1, 1]} />
        <meshPhysicalMaterial
          color={color}
          metalness={0.72}
          roughness={0.28}
          transparent
          opacity={0.13}
          wireframe
        />
      </mesh>
      <mesh position={[4.3, 0.3, -2.5]} rotation={[0.6, 0.15, 0.35]}>
        <torusGeometry args={[2, 0.012, 6, 96]} />
        <meshBasicMaterial color={color} transparent opacity={0.38} />
      </mesh>
    </Float>
  );
}

export default function RoyalScene({ variant }: { variant: RoyalSceneVariant }) {
  const accent = ACCENTS[variant];

  return (
    <Canvas
      aria-hidden="true"
      camera={{ position: [0, 0, 10], fov: 42 }}
      dpr={[1, 1.25]}
      gl={{ alpha: true, antialias: false, powerPreference: 'low-power' }}
    >
      <fog attach="fog" args={['#080913', 9, 24]} />
      <ambientLight intensity={0.7} />
      <pointLight position={[-5, 3, 4]} color={accent} intensity={14} distance={20} decay={3} />
      <pointLight position={[5, -2, 1]} color="#7260a5" intensity={8} distance={18} decay={3} />
      <Sparkles
        count={34}
        scale={[16, 9, 8]}
        size={1.8}
        speed={0.12}
        opacity={0.42}
        color={accent}
      />
      <FloatingCrest color={accent} />
    </Canvas>
  );
}
