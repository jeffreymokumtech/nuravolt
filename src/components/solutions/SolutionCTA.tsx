'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarketingSection } from '@/components/ui/MarketingSection';
import { HairlineRule } from '@/components/ui/HairlineRule';
import { goToLeadForm, type LeadIntent } from '@/components/landing/leadFormIntent';

interface SolutionCTAProps {
  /** Short uppercase eyebrow above the heading. */
  eyebrow: string;
  heading: string;
  sub: string;
  primary: { label: string; intent: LeadIntent };
  /** Optional second link, usually points at a peer solution page. */
  secondary?: { label: string; href: string };
}

/**
 * Bottom-of-page CTA matching the landing system: paper background, single
 * h2 in ink, supporting copy in ink-2, brand-blue button + outline secondary.
 * Replaces the saturated `bg-primary` slabs and asset-coloured "Built for X"
 * cards the old solutions pages were closing with.
 */
export function SolutionCTA({ eyebrow, heading, sub, primary, secondary }: SolutionCTAProps) {
  return (
    <>
      <HairlineRule />

      <MarketingSection size="default">
        <div className="max-w-3xl">
          <div className="font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3">
            {eyebrow}
          </div>
          <h2 className="text-h1 font-semibold text-ink mb-4 text-balance">{heading}</h2>
          <p className="text-body text-ink-2 mb-8 max-w-2xl">{sub}</p>

          <div className="flex flex-col sm:flex-row flex-wrap gap-3">
            <Button size="lg" onClick={() => goToLeadForm(primary.intent)}>
              {primary.label}
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
            {secondary ? (
              <Button size="lg" variant="outline" asChild>
                <Link href={secondary.href}>{secondary.label}</Link>
              </Button>
            ) : null}
          </div>
        </div>
      </MarketingSection>
    </>
  );
}

export default SolutionCTA;
