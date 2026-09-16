'use client';

import type { CSSProperties, ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';

/**
 * Single source of truth for the shorthand the ops UI shows operators. Keys are
 * matched case-insensitively by <Abbr>; keep the definitions plain-language and
 * one sentence — they render in a hover tooltip, not a manual.
 */
export const GLOSSARY: Record<string, string> = {
  PDS: 'Peer Deviation Score — a robust z-score of this inverter’s loss% against its same-group peers (1.4826·MAD), so a high PDS means it is drifting from siblings that share weather and age.',
  DT: 'Digital Twin — the model’s expected value for a signal; a figure tagged “(DT)” comes from the twin, not a raw meter.',
  MAE: 'Mean Absolute Error — the average magnitude of the twin residual, |measured − expected|; smaller means the twin tracks reality more tightly.',
  RUL: 'Remaining Useful Life — the model’s estimate of how long a component can run before it needs intervention.',
  BOP: 'Balance of Plant — everything that is not the modules or inverter: wiring, connectors, combiner boxes and other system losses.',
  MPPT: 'Maximum Power Point Tracker — an inverter input that holds one group of strings at its optimal voltage; large inverters have several.',
  Vmpp: 'Voltage at maximum power point — the DC voltage a healthy string sits at while delivering peak power.',
  Voc: 'Open-circuit voltage — the DC voltage with no current drawn (e.g. at night or on a disconnect); voltage drifting toward Voc signals a string not delivering.',
  Isc: 'Short-circuit current — the maximum current a string can source into a short, its physical ceiling.',
  P10: '10th percentile across the fleet for that day — only 10% of inverters sit below this line.',
  P50: 'Median (50th percentile) across the fleet for that day.',
  P90: '90th percentile across the fleet for that day — only 10% of inverters sit above this line.',
  'z-score': 'Number of standard deviations from the peer mean; ±2σ is roughly the edge of normal.',
  σ: 'Sigma — standard deviations from the peer mean (a z-score).',
  // Battery storage (BESS)
  SoH: 'State of Health — remaining usable capacity as a fraction of nameplate; a battery is typically warrantied to stay above ~70%.',
  SoC: 'State of Charge — how full the battery is right now, 0–100%.',
  DoD: 'Depth of Discharge — how deep a cycle goes (the swing between high and low SoC); deeper cycles wear the cells faster.',
  RTE: 'Round-Trip Efficiency — energy out ÷ energy in over a charge/discharge cycle; the rest is lost as heat.',
  'C-rate': 'Charge/discharge rate relative to capacity: 1C empties a full battery in one hour, 0.5C in two.',
  EFC: 'Equivalent Full Cycles — partial cycles summed into whole-battery-equivalents; the standard way to count battery usage.',
  EOL: 'End of Life — the point where State of Health falls below the warranty/usable threshold (often 70%).',
  COD: 'Commercial Operation Date — when the asset entered service.',
  RUL: 'Remaining Useful Life — the model’s estimate of time (or cycles) before the battery reaches end of life.',
  'stress cycles': 'Cycles reweighted by how hard each one was (depth, temperature, C-rate) — a truer wear measure than a raw cycle count.',
  // Soiling intelligence
  SR: 'Soiling Ratio — actual output ÷ expected clean output; 0.95 means the array loses 5% of its energy to dust and dirt.',
  PR: 'Performance Ratio — actual energy ÷ the energy irradiance says a loss-free plant would produce; the standard plant health metric.',
  POA: 'Plane-of-Array irradiance — sunlight arriving on the tilted panel surface, the input the modules actually see.',
  GHI: 'Global Horizontal Irradiance — total sunlight on a horizontal surface; the standard weather-station measurement.',
  DNI: 'Direct Normal Irradiance — the beam component of sunlight, measured perpendicular to the sun.',
  DustIQ: 'Optical soiling reference sensor — plants typically carry one, so per-inverter soiling is inferred from each inverter’s power + irradiance and anchored to this sensor.',
  AOD: 'Aerosol Optical Depth (550 nm) — how much dust/haze the atmosphere carries; a leading indicator of soiling deposition.',
  CAMS: 'Copernicus Atmosphere Monitoring Service — the EU satellite/model service supplying the AOD dust forecasts.',
  'MERRA-2': 'NASA atmospheric reanalysis — a historical aerosol/weather dataset used to backfill dust exposure.',
  SRR: 'Soiling Ratio from Rate of change — the rdtools method that extracts soiling from performance-index decay between rains.',
  'climate prior': 'Cold-start soiling profile taken from the plant’s climate zone before enough of its own data has accumulated.',
  'meteo-prior': 'Baseline cleaning expectation derived from rain climatology (ERA5) — what nature would wash off with no manual cleaning.',
  'transfer-learning': 'A model trained on a donor plant with a soiling sensor, transferred to this plant until its own ground truth accumulates.',
  P25: '25th percentile — a quarter of values sit below this line.',
  P75: '75th percentile — a quarter of values sit above this line.',
  // Ancillary / grid services
  DC: 'Dynamic Containment — a fast frequency-response service (UK/EU ancillary market).',
  DM: 'Dynamic Moderation — a frequency-response service that acts pre-emptively around normal frequency.',
  DR: 'Dynamic Regulation — a slower, continuous frequency-regulation service.',
  BM: 'Balancing Mechanism — the grid operator’s real-time market for balancing supply and demand.',
  CM: 'Capacity Market — payments for being available to deliver power when the grid needs it.',
  WS: 'Wholesale arbitrage — buying energy when cheap and selling when expensive on the day-ahead/intraday market.',
};

interface AbbrProps {
  /** Term to look up in GLOSSARY (defaults to the string child). */
  term?: string;
  /** Explicit definition, overrides GLOSSARY. */
  def?: string;
  /** Visible label; defaults to `term`. */
  children?: ReactNode;
  className?: string;
}

/**
 * Wrap an abbreviation the operator might not know. Renders the term with a
 * dotted underline and a styled hover/focus tooltip carrying its definition.
 * Falls back to plain text when no definition is found, so it is always safe to
 * wrap. Self-contained (own TooltipProvider) — no app-root provider required.
 */
export function Abbr({ term, def, children, className }: AbbrProps) {
  const label = children ?? term;
  const key = (term ?? (typeof children === 'string' ? children : '') ?? '').trim();
  const definition =
    def ?? GLOSSARY[key] ?? GLOSSARY[key.toLowerCase()] ?? GLOSSARY[key.toUpperCase()] ?? '';

  if (!definition) return <>{label}</>;

  const contentStyle: CSSProperties = {
    background: 'var(--ops-panel, #fff)',
    borderColor: 'var(--ops-hair, #e5e7eb)',
    color: 'var(--ops-txt, #111827)',
  };

  return (
    <TooltipProvider delayDuration={120} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={`cursor-help underline decoration-dotted decoration-1 underline-offset-2 ${className ?? ''}`}
            style={{ textDecorationColor: 'var(--ops-label, #9ca3af)' }}
          >
            {label}
          </span>
        </TooltipTrigger>
        <TooltipPrimitive.Portal>
          <TooltipContent
            sideOffset={5}
            collisionPadding={8}
            className="z-50 max-w-[260px] border font-sans text-[11px] font-normal normal-case leading-snug tracking-normal shadow-md"
            style={contentStyle}
          >
            {definition}
          </TooltipContent>
        </TooltipPrimitive.Portal>
      </Tooltip>
    </TooltipProvider>
  );
}

export default Abbr;
