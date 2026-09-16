'use client';

import Image from 'next/image';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { DataPanel } from '@/components/ui/DataPanel';
import { KPIReadout } from '@/components/ui/KPIReadout';
import { HairlineRule } from '@/components/ui/HairlineRule';
import { goToLeadForm, type LeadIntent } from '@/components/landing/leadFormIntent';
import { cn } from '@/helpers/utils';

export type SolutionHeroAsset = 'solar' | 'wind' | 'bess' | 'hydrogen';

interface CtaSpec {
  label: string;
  intent: LeadIntent;
}

interface SolutionHeroProps {
  asset: SolutionHeroAsset;
  /** Short uppercase eyebrow (mono caps). */
  eyebrow: string;
  /** First sentence of the headline. */
  headline: string;
  /** Optional softer second sentence (rendered in ink-2). */
  highlight?: string;
  /** Lead paragraph in body weight. */
  sub: string;
  stats: ReadonlyArray<{ value: string; label: string }>;
  primaryCta: CtaSpec;
  secondaryCta?: CtaSpec;
  /** Path under /public for the right-hand product screenshot. */
  screenshot: { src: string; alt: string; panelHeader: string; panelMeta: string };
}

// One source of truth for the asset accent, used by the chip on the left
// AND the DataPanel header on the right. Everything else stays paper/ink
// so the page never reads as a single coloured slab the way the old
// gradient heroes did.
const ASSET_ACCENT: Record<SolutionHeroAsset, { chip: string; dot: string; label: string }> = {
  solar: {
    chip: 'bg-blue-50 text-asset-solar border-blue-200',
    dot: 'bg-asset-solar',
    label: 'PV intelligence',
  },
  wind: {
    chip: 'bg-cyan-50 text-asset-wind border-cyan-200',
    dot: 'bg-asset-wind',
    label: 'Wind intelligence',
  },
  bess: {
    chip: 'bg-violet-50 text-asset-bess border-violet-200',
    dot: 'bg-asset-bess',
    label: 'BESS intelligence',
  },
  hydrogen: {
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dot: 'bg-emerald-500',
    label: 'Hydrogen intelligence',
  },
};

export function SolutionHero({
  asset,
  eyebrow,
  headline,
  highlight,
  sub,
  stats,
  primaryCta,
  secondaryCta,
  screenshot,
}: SolutionHeroProps) {
  const accent = ASSET_ACCENT[asset];

  return (
    <>
      <MarketingSection size="hero" as="div">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
          <motion.div
            className="lg:col-span-7"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          >
            {/* Asset accent chip, the only place an accent colour lives in
                the hero text column. */}
            <div
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-3 py-1 mb-6 font-mono text-meta uppercase tracking-[0.08em]',
                accent.chip,
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', accent.dot)} />
              {accent.label}
            </div>

            <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
              {eyebrow}
            </div>

            <h1 className="text-h1 sm:text-display font-semibold text-ink mb-6 text-balance">
              {headline}
              {highlight ? (
                <>
                  {' '}
                  <span className="text-ink-2 font-normal">{highlight}</span>
                </>
              ) : null}
            </h1>

            <p className="text-body text-ink-2 mb-10 max-w-xl text-balance">{sub}</p>

            {stats.length > 0 && (
              <div className="grid grid-cols-3 gap-8 mb-10 border-t border-b border-divider py-6">
                {stats.map((stat, idx) => (
                  <KPIReadout
                    key={stat.label}
                    value={stat.value}
                    label={stat.label}
                    size="md"
                    delay={0.1 + idx * 0.1}
                  />
                ))}
              </div>
            )}

            <div className="flex flex-col sm:flex-row flex-wrap gap-3">
              <Button size="lg" onClick={() => goToLeadForm(primaryCta.intent)}>
                {primaryCta.label}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
              {secondaryCta ? (
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => goToLeadForm(secondaryCta.intent)}
                >
                  {secondaryCta.label}
                </Button>
              ) : null}
            </div>
          </motion.div>

          {/* Right: product screenshot framed as DataPanel, matches the
              landing hero's visual language exactly. */}
          <motion.div
            className="lg:col-span-5"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut', delay: 0.1 }}
          >
            <DataPanel
              headerLeft={screenshot.panelHeader}
              headerRight={screenshot.panelMeta}
              live
            >
              <div className="relative aspect-[16/11] bg-data-bg-2">
                <Image
                  src={screenshot.src}
                  alt={screenshot.alt}
                  fill
                  className="object-cover"
                  sizes="(min-width: 1024px) 40vw, 100vw"
                  priority
                />
              </div>
            </DataPanel>
          </motion.div>
        </div>
      </MarketingSection>

      <HairlineRule />
    </>
  );
}

export default SolutionHero;
