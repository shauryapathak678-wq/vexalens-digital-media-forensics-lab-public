import React from 'react';

interface GlassButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'quiet';
}

export const GlassButton: React.FC<GlassButtonProps> = ({
  variant = 'quiet',
  className = '',
  type = 'button',
  ...props
}) => (
  <button
    type={type}
    className={`vl-glass-button vl-glass-button--${variant} ${className}`.trim()}
    {...props}
  />
);
