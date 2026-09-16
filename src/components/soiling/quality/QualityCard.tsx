'use client';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { QUALITY_COLORS } from './constants';
import { cn } from '@/helpers/utils';

/**
 * QualityCard — the standard white card of the Data Quality hub's light
 * design system. Every section of the hub composes this so surfaces share
 * one radius / border / padding / heading language.
 */

interface QualityCardProps {
  /** Small uppercase section heading, e.g. "Streams needing attention". */
  title?: string;
  icon?: LucideIcon;
  /** Right-aligned slot in the heading row (badges, actions). */
  headerRight?: ReactNode;
  /** Muted single-line footer, e.g. window / methodology notes. */
  footer?: ReactNode;
  padded?: boolean;
  className?: string;
  children: ReactNode;
}

export default function QualityCard({
  title,
  icon: Icon,
  headerRight,
  footer,
  padded = true,
  className,
  children,
}: QualityCardProps) {
  return (
    <section
      className={cn('rounded-xl border bg-white', padded && 'p-5', className)}
      style={{ borderColor: QUALITY_COLORS.border.DEFAULT }}
    >
      {(title || headerRight) && (
        <div className={cn('mb-3 flex items-center justify-between gap-3', !padded && 'px-5 pt-5')}>
          <h3
            className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: QUALITY_COLORS.text.secondary }}
          >
            {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
            {title}
          </h3>
          {headerRight && <div className="flex items-center gap-2">{headerRight}</div>}
        </div>
      )}
      {children}
      {footer && (
        <div
          className={cn('mt-3 border-t pt-2.5 text-[11px]', !padded && 'mx-5 mb-5')}
          style={{
            borderColor: QUALITY_COLORS.border.light,
            color: QUALITY_COLORS.text.muted,
          }}
        >
          {footer}
        </div>
      )}
    </section>
  );
}
