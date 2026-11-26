import React from 'react';
import teamLogo from '@/assets/images/vexalens-team-logo.png';

interface BrandLogoProps {
  className?: string;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({ className }) => (
  <img
    className={className}
    src={teamLogo}
    alt="VexaLens logo"
    decoding="async"
  />
);
