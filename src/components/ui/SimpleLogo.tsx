'use client';

import React from 'react';

interface SimpleLogoProps {
  className?: string;
  width?: number;
  height?: number;
}

const SimpleLogo: React.FC<SimpleLogoProps> = ({
  className = "",
  width = 160,
  height = 40,
}) => {
  return (
    <svg
      viewBox="0 0 180 40"
      width={width}
      height={height}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="logoTextGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style={{stopColor: "#1e40af"}} />
          <stop offset="100%" style={{stopColor: "#1e3a8a"}} />
        </linearGradient>
        <linearGradient id="logoIconGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{stopColor: "#3b82f6"}} />
          <stop offset="100%" style={{stopColor: "#6366f1"}} />
        </linearGradient>
      </defs>

      {/* Icon */}
      <g>
        <rect width="40" height="40" rx="8" fill="url(#logoIconGradient)" />
        <path
          d="M12 12 L20 28 L28 12"
          stroke="white"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
         <path
          d="M20 28 L20 20"
          stroke="white"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>

      {/* Text */}
      <text
        x="50"
        y="28"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        fontSize="24"
        fontWeight="700"
        fill="url(#logoTextGradient)"
      >
        NuraVolt
      </text>
    </svg>
  );
};

export default SimpleLogo;
