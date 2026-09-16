'use client';

import React from 'react';

interface NuraVoltLogoProps {
  className?: string;
  width?: number;
  height?: number;
  showTagline?: boolean;
  variant?: 'light' | 'dark';
}

const NuraVoltLogo: React.FC<NuraVoltLogoProps> = ({
  className = "",
  width = 240,
  height = 60,
  showTagline = true,
  variant = 'light'
}) => {
  const isDark = variant === 'dark';
  const handleLogoClick = () => {
    window.location.href = '/';
  };

  return (
    <svg
      viewBox="0 0 240 60"
      width={width}
      height={height}
      className={`${className} cursor-pointer`}
      xmlns="http://www.w3.org/2000/svg"
      onClick={handleLogoClick}
      role="button"
      aria-label="NuraVolt Home"
    >
      {/* Define gradients */}
      <defs>
        {/* Energy gradient (sun + electricity) */}
        <radialGradient id="energyGradient" cx="50%" cy="50%">
          <stop offset="0%" style={{stopColor:"#fbbf24", stopOpacity:1}} />
          <stop offset="70%" style={{stopColor:"#f59e0b", stopOpacity:1}} />
          <stop offset="100%" style={{stopColor:"#d97706", stopOpacity:1}} />
        </radialGradient>

        {/* Voltage gradient (electric blue/purple) */}
        <linearGradient id="voltageGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style={{stopColor:"#8b5cf6", stopOpacity:1}} />
          <stop offset="100%" style={{stopColor:"#6366f1", stopOpacity:1}} />
        </linearGradient>

        {/* Data visualization gradient */}
        <linearGradient id="dataGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style={{stopColor:"#3b82f6", stopOpacity:1}} />
          <stop offset="100%" style={{stopColor:"#1d4ed8", stopOpacity:1}} />
        </linearGradient>

        {/* Text gradient */}
        <linearGradient id="textGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style={{stopColor:"#1e40af", stopOpacity:1}} />
          <stop offset="100%" style={{stopColor:"#1e3a8a", stopOpacity:1}} />
        </linearGradient>

        {/* Neural network gradient */}
        <linearGradient id="neuralGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{stopColor:"#06b6d4", stopOpacity:0.8}} />
          <stop offset="100%" style={{stopColor:"#0891b2", stopOpacity:0.6}} />
        </linearGradient>
      </defs>

      {/* Background circle for energy */}
      <circle cx="30" cy="30" r="24" fill="url(#energyGradient)" opacity="0.1"/>

      {/* Main energy symbol (sun + battery) with subtle pulsing effect */}
      <circle cx="30" cy="30" r="12" fill="url(#energyGradient)">
        <animate attributeName="opacity" values="0.8;1;0.8" dur="3s" repeatCount="indefinite"/>
      </circle>

      {/* Energy rays (solar) */}
      <g stroke="url(#energyGradient)" strokeWidth="2.5" strokeLinecap="round">
        <line x1="30" y1="6" x2="30" y2="10"/>
        <line x1="43" y1="11" x2="41" y2="13"/>
        <line x1="48" y1="30" x2="44" y2="30"/>
        <line x1="43" y1="49" x2="41" y2="47"/>
        <line x1="30" y1="54" x2="30" y2="50"/>
        <line x1="17" y1="49" x2="19" y2="47"/>
        <line x1="12" y1="30" x2="16" y2="30"/>
        <line x1="17" y1="11" x2="19" y2="13"/>
      </g>

      {/* AI/Neural network overlay */}
      <g opacity="0.8">
        {/* Neural network nodes */}
        <circle cx="22" cy="22" r="2" fill="url(#neuralGradient)">
          <animate attributeName="r" values="1.5;2.5;1.5" dur="2s" repeatCount="indefinite"/>
        </circle>
        <circle cx="38" cy="22" r="2" fill="url(#neuralGradient)">
          <animate attributeName="r" values="2;1.5;2" dur="2s" repeatCount="indefinite"/>
        </circle>
        <circle cx="22" cy="38" r="2" fill="url(#neuralGradient)">
          <animate attributeName="r" values="1.5;2;1.5" dur="2s" repeatCount="indefinite"/>
        </circle>
        <circle cx="38" cy="38" r="2" fill="url(#neuralGradient)">
          <animate attributeName="r" values="2;1.5;2" dur="2s" repeatCount="indefinite"/>
        </circle>

        {/* Intelligence connecting lines */}
        <path
          d="M22 22 L30 30 L38 22 M30 30 L38 38 M30 30 L22 38"
          stroke="url(#neuralGradient)"
          strokeWidth="1.5"
          fill="none"
          opacity="0.6"
        >
          <animate attributeName="opacity" values="0.4;0.8;0.4" dur="2.5s" repeatCount="indefinite"/>
        </path>

        {/* Data flow particles */}
        <circle cx="26" cy="26" r="1" fill="url(#dataGradient)" opacity="0.7">
          <animateMotion dur="3s" repeatCount="indefinite">
            <path d="M0,0 Q4,0 8,4 Q4,8 0,8 Q-4,4 0,0"/>
          </animateMotion>
        </circle>
      </g>

      {/* Company name - Nura */}
      <text
        x="70"
        y="25"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        fontSize="24"
        fontWeight="700"
        fill={isDark ? "#ffffff" : "url(#textGradient)"}
      >
        Nura
      </text>

      {/* Volt with electric emphasis */}
      <text
        x="70"
        y="45"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        fontSize="20"
        fontWeight="600"
        fill="url(#voltageGradient)"
      >
        Volt
      </text>

      {/* Enhanced tagline - ENERGY INTELLIGENCE */}
      {showTagline && (
        <g>
          <text
            x="125"
            y="42"
            fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
            fontSize="11"
            fontWeight="400"
            fill={isDark ? "#9ca3af" : "#4b5563"}
            letterSpacing="0.5"
          >
            ENERGY
          </text>
          <text
            x="125"
            y="52"
            fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
            fontSize="11"
            fontWeight="600"
            fill="url(#dataGradient)"
            letterSpacing="0.8"
          >
            INTELLIGENCE
          </text>
        </g>
      )}

      {/* Performance indicator with animation */}
      <g opacity="0.7">
        {/* Dynamic chart bars representing performance optimization */}
        <rect x="200" y="35" width="3" height="8" fill="url(#dataGradient)" rx="1">
          <animate attributeName="height" values="8;12;8" dur="1.5s" repeatCount="indefinite"/>
          <animate attributeName="y" values="35;31;35" dur="1.5s" repeatCount="indefinite"/>
        </rect>
        <rect x="205" y="30" width="3" height="13" fill="url(#dataGradient)" rx="1">
          <animate attributeName="height" values="13;18;13" dur="1.8s" repeatCount="indefinite"/>
          <animate attributeName="y" values="30;25;30" dur="1.8s" repeatCount="indefinite"/>
        </rect>
        <rect x="210" y="25" width="3" height="18" fill="url(#dataGradient)" rx="1">
          <animate attributeName="height" values="18;22;18" dur="2.1s" repeatCount="indefinite"/>
          <animate attributeName="y" values="25;21;25" dur="2.1s" repeatCount="indefinite"/>
        </rect>
        <rect x="215" y="20" width="3" height="23" fill="url(#dataGradient)" rx="1">
          <animate attributeName="height" values="23;26;23" dur="1.7s" repeatCount="indefinite"/>
          <animate attributeName="y" values="20;17;20" dur="1.7s" repeatCount="indefinite"/>
        </rect>
        <rect x="220" y="32" width="3" height="11" fill="url(#dataGradient)" rx="1">
          <animate attributeName="height" values="11;15;11" dur="1.9s" repeatCount="indefinite"/>
          <animate attributeName="y" values="32;28;32" dur="1.9s" repeatCount="indefinite"/>
        </rect>
      </g>

      {/* Subtle energy waves emanating from center */}
      <g opacity="0.3">
        <circle cx="30" cy="30" r="16" fill="none" stroke="url(#energyGradient)" strokeWidth="0.5">
          <animate attributeName="r" values="16;20;16" dur="4s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.3;0.1;0.3" dur="4s" repeatCount="indefinite"/>
        </circle>
        <circle cx="30" cy="30" r="20" fill="none" stroke="url(#energyGradient)" strokeWidth="0.3">
          <animate attributeName="r" values="20;24;20" dur="5s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.2;0.05;0.2" dur="5s" repeatCount="indefinite"/>
        </circle>
      </g>
    </svg>
  );
};

export default NuraVoltLogo;
