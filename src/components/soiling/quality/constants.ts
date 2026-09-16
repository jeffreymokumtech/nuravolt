// Data Quality Hub - Constants and Configuration
import {
  LayoutDashboard,
  Map,
  Sun,
  Link2,
  Lightbulb,
  AlertTriangle,
  CheckCircle,
  XCircle,
  TrendingUp,
  TrendingDown,
  Minus,
  Activity,
  Radio,
  Satellite,
  type LucideIcon,
} from 'lucide-react';

// ============================================================
// Color Palette - Professional muted theme
// ============================================================

export const QUALITY_COLORS = {
  // Primary accent (interactive elements)
  primary: {
    DEFAULT: '#3B82F6',      // Blue-500
    light: '#DBEAFE',        // Blue-100
    dark: '#1D4ED8',         // Blue-700
  },

  // Status colors (subtle, not jarring)
  status: {
    excellent: '#10B981',    // Emerald-500
    good: '#3B82F6',         // Blue-500
    fair: '#F59E0B',         // Amber-500
    poor: '#EF4444',         // Red-500
  },

  // Background/card colors
  background: {
    card: '#FFFFFF',
    section: '#F9FAFB',      // Gray-50
    hover: '#F3F4F6',        // Gray-100
  },

  // Text hierarchy
  text: {
    primary: '#111827',      // Gray-900
    secondary: '#6B7280',    // Gray-500
    muted: '#9CA3AF',        // Gray-400
  },

  // Border colors
  border: {
    DEFAULT: '#E5E7EB',      // Gray-200
    light: '#F3F4F6',        // Gray-100
  },
} as const;

// ============================================================
// Semantic tones — the light-system equivalent of the ops
// ok/warn/alarm/info tokens. Every DQ-hub component draws its
// severity styling from this one map so the hub reads as a
// single design system.
// ============================================================

export type QualityTone = 'ok' | 'warn' | 'alarm' | 'info' | 'muted';

export interface QualityToneTokens {
  fg: string;
  bg: string;
  border: string;
}

export const QUALITY_TONES: Record<QualityTone, QualityToneTokens> = {
  ok: { fg: '#047857', bg: '#ECFDF5', border: '#A7F3D0' },      // Emerald 700/50/200
  warn: { fg: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },    // Amber 700/50/200
  alarm: { fg: '#B91C1C', bg: '#FEF2F2', border: '#FECACA' },   // Red 700/50/200
  info: { fg: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },    // Blue 700/50/200
  muted: { fg: '#6B7280', bg: '#F9FAFB', border: '#E5E7EB' },   // Gray 500/50/200
} as const;

/** Solid dot/LED colors per tone (stronger than fg for tiny elements). */
export const QUALITY_TONE_DOT: Record<QualityTone, string> = {
  ok: '#10B981',
  warn: '#F59E0B',
  alarm: '#EF4444',
  info: '#3B82F6',
  muted: '#9CA3AF',
} as const;

// ============================================================
// Chart palette — hex values for recharts SVG stroke/fill
// attributes (SVG attributes can't consume CSS vars reliably).
// ============================================================

export const QUALITY_CHART = {
  primary: '#3B82F6',
  primarySoft: '#3B82F680',
  reference: '#10B981',
  threshold: '#F59E0B',
  grid: '#E5E7EB',
  axisTick: '#9CA3AF',
  axisLabel: '#6B7280',
  series: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6'],
} as const;

/** Mono stack for numerals/ids in the light system (tabular figures). */
export const QUALITY_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

// ============================================================
// Quality Thresholds
// ============================================================

export const QUALITY_THRESHOLDS = {
  excellent: 80,
  good: 60,
  fair: 40,
  poor: 0,
} as const;

export const CORRELATION_THRESHOLDS = {
  excellent: 0.95,
  good: 0.90,
  fair: 0.80,
  poor: 0.70,
} as const;

export const BIAS_THRESHOLDS = {
  excellent: 3,   // |bias%| < 3%
  good: 5,        // |bias%| < 5%
  fair: 10,       // |bias%| < 10%
  poor: 15,       // |bias%| < 15%
} as const;

// ============================================================
// Quality Score Weights
// ============================================================

export const QUALITY_WEIGHTS = {
  correlation: 0.30,      // 30%
  bias: 0.25,             // 25%
  consistency: 0.20,      // 20%
  completeness: 0.15,     // 15%
  powerCorrelation: 0.10, // 10%
} as const;

// ============================================================
// Type Definitions
// ============================================================

export type QualityClass = 'excellent' | 'good' | 'fair' | 'poor';
export type QualityRecommendation = 'primary' | 'backup' | 'monitor' | 'investigate';
export type TrendDirection = 'improving' | 'stable' | 'degrading';

// ============================================================
// Helper Functions
// ============================================================

export function getQualityClass(score: number): QualityClass {
  if (score >= QUALITY_THRESHOLDS.excellent) return 'excellent';
  if (score >= QUALITY_THRESHOLDS.good) return 'good';
  if (score >= QUALITY_THRESHOLDS.fair) return 'fair';
  return 'poor';
}

export function getQualityColor(score: number): string {
  return QUALITY_COLORS.status[getQualityClass(score)];
}

export function getQualityLabel(qualityClass: QualityClass): string {
  const labels: Record<QualityClass, string> = {
    excellent: 'Excellent',
    good: 'Good',
    fair: 'Fair',
    poor: 'Poor',
  };
  return labels[qualityClass];
}

export function getRecommendationFromScore(score: number): QualityRecommendation {
  if (score >= 80) return 'primary';
  if (score >= 60) return 'backup';
  if (score >= 40) return 'monitor';
  return 'investigate';
}

export function getRecommendationLabel(rec: QualityRecommendation): string {
  const labels: Record<QualityRecommendation, string> = {
    primary: 'Primary Source',
    backup: 'Backup Source',
    monitor: 'Monitor Only',
    investigate: 'Investigate Issues',
  };
  return labels[rec];
}

export function getCorrelationQuality(r: number): QualityClass {
  if (r >= CORRELATION_THRESHOLDS.excellent) return 'excellent';
  if (r >= CORRELATION_THRESHOLDS.good) return 'good';
  if (r >= CORRELATION_THRESHOLDS.fair) return 'fair';
  return 'poor';
}

export function getBiasQuality(biasPct: number): QualityClass {
  const absBias = Math.abs(biasPct);
  if (absBias < BIAS_THRESHOLDS.excellent) return 'excellent';
  if (absBias < BIAS_THRESHOLDS.good) return 'good';
  if (absBias < BIAS_THRESHOLDS.fair) return 'fair';
  return 'poor';
}

// ============================================================
// Icon Mappings
// ============================================================

export const QUALITY_ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  spatial: Map,
  irradiance: Sun,
  correlation: Link2,
  recommendation: Lightbulb,
  alert: AlertTriangle,
  success: CheckCircle,
  error: XCircle,
  trendUp: TrendingUp,
  trendDown: TrendingDown,
  trendStable: Minus,
  activity: Activity,
  sensor: Radio,
  satellite: Satellite,
};

export function getTrendIcon(trend: TrendDirection): LucideIcon {
  switch (trend) {
    case 'improving': return TrendingUp;
    case 'degrading': return TrendingDown;
    default: return Minus;
  }
}

export function getTrendColor(trend: TrendDirection): string {
  switch (trend) {
    case 'improving': return QUALITY_COLORS.status.excellent;
    case 'degrading': return QUALITY_COLORS.status.poor;
    default: return QUALITY_COLORS.text.secondary;
  }
}

// ============================================================
// Score Calculation Helpers
// ============================================================

export function calculateCorrelationScore(r: number): number {
  // Max 30 points
  if (r >= 0.95) return 30;
  if (r >= 0.90) return 25;
  if (r >= 0.80) return 18;
  if (r >= 0.70) return 10;
  return 0;
}

export function calculateBiasScore(biasPct: number): number {
  // Max 25 points
  const absBias = Math.abs(biasPct);
  if (absBias < 3) return 25;
  if (absBias < 5) return 20;
  if (absBias < 10) return 12;
  if (absBias < 15) return 5;
  return 0;
}

export function calculateConsistencyScore(stdDev: number): number {
  // Max 20 points - based on monthly correlation stability
  if (stdDev < 0.02) return 20;
  if (stdDev < 0.05) return 15;
  if (stdDev < 0.10) return 8;
  return 0;
}

export function calculateCompletenessScore(completeness: number): number {
  // Max 15 points - completeness is 0-100
  return Math.round((completeness / 100) * 15);
}

export function calculatePowerCorrelationScore(avgPowerCorr: number): number {
  // Max 10 points
  if (avgPowerCorr >= 0.90) return 10;
  if (avgPowerCorr >= 0.80) return 7;
  if (avgPowerCorr >= 0.70) return 4;
  return 0;
}
