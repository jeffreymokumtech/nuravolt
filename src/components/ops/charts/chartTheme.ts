'use client';

import { createElement, type CSSProperties, type ReactElement } from 'react';
import { useOpsThemeNameSafe } from '@/contexts/OpsThemeContext';
import type { StatusTone } from '../StatusLed';

/**
 * Shared styling for every hand-rolled ops chart (line, bar, sparkline, ring,
 * heatmap, waterfall). Single source for the tone→CSS-var map, axis
 * typography, the gradient area fill under solid data lines, and the heat
 * ramps. Import from here — never copy these maps into chart files.
 */

export const TONE_VAR: Record<StatusTone, string> = {
  ok: 'var(--ops-ok)',
  warn: 'var(--ops-warn)',
  alarm: 'var(--ops-alarm)',
  info: 'var(--ops-info)',
  bess: 'var(--ops-bess)',
  muted: 'var(--ops-muted)',
};

/**
 * Axis/tick/legend typography. Sans per the ops convention (mono is reserved
 * for data numerals); tabular figures keep tick numbers column-aligned
 * without falling back to the mono face.
 */
export const AXIS_TEXT_CLASS = 'text-[10.5px]';
export const AXIS_TEXT_STYLE: CSSProperties = {
  fontFamily: 'var(--ops-font-sans)',
  color: 'var(--ops-label)',
  fontVariantNumeric: 'tabular-nums',
};

/**
 * Vertical fade gradient used for the area fill under a solid series line.
 * Opacities come from theme tokens (--ops-chart-fill-a/b) so light and dark
 * tune independently. Callers MUST pass a per-instance unique id (derive from
 * useId() + series key) — a static id collides when the same chart type
 * renders twice on one page and the second fill silently paints with the
 * first chart's tone.
 *
 * createElement instead of JSX keeps this file a .ts module.
 */
export function areaGradient(id: string, tone: StatusTone): ReactElement {
  return createElement(
    'linearGradient',
    { id, x1: '0', y1: '0', x2: '0', y2: '1', key: id },
    createElement('stop', {
      offset: '0%',
      style: { stopColor: TONE_VAR[tone], stopOpacity: 'var(--ops-chart-fill-a)' } as CSSProperties,
    }),
    createElement('stop', {
      offset: '100%',
      style: { stopColor: TONE_VAR[tone], stopOpacity: 'var(--ops-chart-fill-b)' } as CSSProperties,
    })
  );
}

/* ── Heat ramps (5 stops, valueMin → valueMax) ──────────────────────────────
 * Soiling: warm/soiled at the low end (low SR = dirty) → green/clean high.
 * Thermal: cool at the low end → warm high.
 * The dark variants keep the same hue story at panel-appropriate lightness so
 * the bright cell text stays readable (the old single light ramp rendered
 * pastel cells inside dark panels).
 */
export const SOILING_RAMP_LIGHT = ['#ecc9be', '#f2dabc', '#f2ead2', '#dfeae5', '#bcd6c6'];
export const SOILING_RAMP_DARK = ['#4a2a23', '#453a1e', '#3a3a2c', '#26372f', '#1d4030'];

export const THERMAL_RAMP_LIGHT = ['#dfeae5', '#e8eccd', '#f2ead2', '#f0d9c5', '#ecc9be'];
export const THERMAL_RAMP_DARK = ['#26372f', '#333a24', '#3a3a2c', '#45301f', '#4a2a23'];

/** Theme-aware ramp resolver (safe outside an OpsThemeProvider → light). */
export function useHeatRamp(kind: 'soiling' | 'thermal'): string[] {
  const theme = useOpsThemeNameSafe();
  if (kind === 'thermal') return theme === 'dark' ? THERMAL_RAMP_DARK : THERMAL_RAMP_LIGHT;
  return theme === 'dark' ? SOILING_RAMP_DARK : SOILING_RAMP_LIGHT;
}
