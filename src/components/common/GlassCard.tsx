import React from 'react';

type GlassDepth = 'base' | 'raised' | 'floating';

interface GlassCardProps extends React.HTMLAttributes<HTMLElement> {
  depth?: GlassDepth;
  as?: 'article' | 'section' | 'div' | 'button';
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

export const GlassCard: React.FC<GlassCardProps> = ({
  as = 'div',
  depth = 'base',
  disabled,
  type,
  className = '',
  children,
  ...props
}) => {
  return React.createElement(
    as,
    {
      ...props,
      className: `vl-glass vl-glass--${depth} ${className}`.trim(),
      ...(as === 'button' ? { disabled, type: type ?? 'button' } : {}),
    },
    children
  );
};
