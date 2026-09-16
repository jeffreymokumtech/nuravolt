#!/usr/bin/env node
/**
 * Read the marketing tokens straight out of globals.scss + tailwind.config.ts
 * and emit a paste-able design-tokens.json at repo root.
 *
 * The output is the single artifact the user drops into a Claude conversation
 * at claude.ai/claude.com so the assistant there knows our exact palette,
 * typography scale, spacing rhythm, and primitive prop signatures.
 *
 * Usage: node scripts/export-design-tokens.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const scss = readFileSync(join(ROOT, 'src/assets/styles/globals.scss'), 'utf8');

// Parse `  --token-name: H S% L%;   /* #HEX */` lines from globals.scss.
const TOKEN_RE = /--([a-z0-9-]+):\s*([^;]+);(?:\s*\/\*\s*(#[0-9a-fA-F]+)\s*\*\/)?/g;
const rawTokens = {};
for (const m of scss.matchAll(TOKEN_RE)) {
  rawTokens[m[1]] = { hsl: m[2].trim(), hex: m[3] ?? null };
}

const colorTokens = {
  paper: pickHex(rawTokens.paper, '#FBF9F5'),
  'paper-2': pickHex(rawTokens['paper-2'], '#F1EEE8'),
  ink: pickHex(rawTokens.ink, '#11141E'),
  'ink-2': pickHex(rawTokens['ink-2'], '#444A5C'),
  'ink-3': pickHex(rawTokens['ink-3'], '#7C8294'),
  divider: pickHex(rawTokens.divider, '#D8DBE2'),
  'data-bg': pickHex(rawTokens['data-bg'], '#0B0E18'),
  'data-bg-2': pickHex(rawTokens['data-bg-2'], '#141826'),
  'data-fg': pickHex(rawTokens['data-fg'], null),
  'data-fg-2': pickHex(rawTokens['data-fg-2'], null),
  'data-rule': pickHex(rawTokens['data-rule'], null),
  'signal-positive': pickHex(rawTokens['signal-positive'], '#2E8754'),
  'signal-warning': pickHex(rawTokens['signal-warning'], '#C8932B'),
  'signal-critical': pickHex(rawTokens['signal-critical'], '#D63A3A'),
  'asset-solar': '#2563eb',
  'asset-wind': '#0891b2',
  'asset-bess': '#7c3aed',
};

const typography = {
  display: { class: 'text-display', desc: 'page-heading on hero — used sparingly' },
  h1: { class: 'text-h1', desc: 'section heading; sm:text-display in hero' },
  h2: { class: 'text-h2', desc: 'sub-section heading inside a section' },
  body: { class: 'text-body', desc: 'paragraph copy in ink-2' },
  meta: { class: 'text-meta', desc: 'mono eyebrow / labels / KPI under-text' },
  'mono-eyebrow': {
    class: 'font-mono text-meta uppercase tracking-[0.08em] text-ink-3',
    desc: 'category label above every section heading — non-negotiable rhythm element',
  },
};

const spacing = {
  'section-hero': 'py-24 (MarketingSection size="hero")',
  'section-default': 'py-16 (MarketingSection size="default")',
  'section-compact': 'py-10 (MarketingSection size="compact")',
  'page-rhythm': 'space-y-6 between cards inside a section, space-y-8 between sections',
  'container': 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 (provided by MarketingSection wrapper)',
};

const primitives = [
  {
    name: 'Button',
    file: 'src/components/ui/button.tsx',
    props: 'size: "sm" | "default" | "lg"; variant: "default" | "outline" | "ghost"',
    rule: 'Primary CTA = default (brand blue). Secondary = outline. Never raw bg-blue-600.',
  },
  {
    name: 'KpiCard',
    file: 'src/components/ui/KpiCard.tsx',
    props: 'tone?: brand|positive|warning|critical|violet|cyan|slate; variant?: plain|gradient; animated?; assetType?: SOLAR|WIND|BESS (overrides tone)',
    rule: 'Plain default. Pass assetType inside plant context so the top border colour matches the asset. Never restyle the inner — use tone.',
  },
  {
    name: 'Pill',
    file: 'src/components/ui/Pill.tsx',
    props: 'tone, variant: soft|outline|solid, size: sm|md. Exports ASSET_TONE, TIER_TONE, CAUSE_TONE, TICKET_STATUS_TONE mappers.',
    rule: 'Pills carry status. Map domain → tone via the exported maps, never hardcode.',
  },
  {
    name: 'MarketingSection',
    file: 'src/components/ui/MarketingSection.tsx',
    props: 'size: hero|default|compact; surface: paper|paper-2|data',
    rule: 'Wraps every marketing page section. Provides paper background, container max-width, and vertical padding rhythm.',
  },
  {
    name: 'DataPanel',
    file: 'src/components/ui/DataPanel.tsx',
    props: 'headerLeft / headerRight slots, live?: boolean, scanline?: boolean, footer?',
    rule: 'The only allowed dark instrument-frame on the marketing surface. Used for product screenshots and embedded data blocks inside paper sections.',
  },
  {
    name: 'KPIReadout',
    file: 'src/components/ui/KPIReadout.tsx',
    props: 'value, label, delta?, signal?: positive|warning|critical|neutral, size: sm|md|lg, tone: paper|data',
    rule: 'The only on-system way to render a KPI on marketing pages. Mono numerics, meta-cased labels.',
  },
  {
    name: 'SectionCard',
    file: 'src/components/ui/SectionCard.tsx',
    props: 'title?, description?, actions?, flush?, id?',
    rule: 'Standard card wrapper inside product surfaces: rounded-xl border-divider p-5 shadow-sm. flush=true removes padding for full-bleed tables.',
  },
  {
    name: 'HairlineRule',
    file: 'src/components/ui/HairlineRule.tsx',
    props: 'orientation: horizontal|vertical',
    rule: '1px divider in token colour. Use between marketing sections to give the page rhythm.',
  },
];

const conventions = {
  assetAccent: {
    where: 'KpiCard top border + asset chip on plant chrome + FleetCard top border on portfolio',
    notWhere: 'Body text, page backgrounds, primary CTAs (those stay brand blue)',
    map: { SOLAR: '#2563eb (blue)', WIND: '#0891b2 (cyan)', BESS: '#7c3aed (violet)' },
  },
  pageRecipe: {
    marketing:
      '1) Hero MarketingSection with mono eyebrow + h1 + body + CTA buttons. 2) HairlineRule. 3) Content sections (paper or paper-2 alternating). 4) HairlineRule. 5) Final CTA section. 6) Footer.',
    product:
      'Chrome (header + sidebar nav) → PageHeader (h1 + actions slot) → SectionCard rows → KpiCard band when applicable.',
  },
  doNot: [
    'bg-gray-* / bg-slate-* — use paper / paper-2 / divider tokens.',
    'text-gray-* / text-slate-* — use ink / ink-2 / ink-3.',
    'border-gray-* / border-slate-* — use border-divider.',
    'Mixing emerald/amber/red Tailwind classes with signal-* tokens — always pick one.',
    'Restyling shadcn primitives — they are remapped via globals.scss already.',
    'Animating logo / accent colours in product chrome — accents stay calm.',
  ],
};

const out = {
  $version: '1.0.0',
  $description:
    "NuraVolt design tokens + primitive contract. Paste into a Claude conversation so the assistant knows the exact palette, typography, and component rules.",
  $source: 'Generated from src/assets/styles/globals.scss + tailwind.config.ts by scripts/export-design-tokens.mjs.',
  colors: colorTokens,
  typography,
  spacing,
  primitives,
  conventions,
};

writeFileSync(join(ROOT, 'design-tokens.json'), JSON.stringify(out, null, 2) + '\n');
console.log(
  `Wrote design-tokens.json (${Object.keys(colorTokens).length} colours, ${primitives.length} primitives)`,
);

function pickHex(raw, fallback) {
  if (raw?.hex) return raw.hex;
  if (raw?.hsl && raw.hsl.startsWith('#')) return raw.hsl;
  return fallback;
}
