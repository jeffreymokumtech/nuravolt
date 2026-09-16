import Link from 'next/link';
import { cn } from '@/helpers/utils';
import type { ReactNode } from 'react';

/**
 * Hierarchical breadcrumb used on drilldown routes (group, inverter, MPPT,
 * string). Visually it matches the command bar's `PORTFOLIO / PLANT / SECTION`
 * strip but extends to deeper levels. Last crumb is in info tone; all
 * preceding crumbs with an `href` are rendered as Links with a visible
 * hover affordance (underline + bright text + pointer cursor).
 */

export interface OpsBreadcrumbItem {
  label: ReactNode;
  href?: string;
}

interface OpsBreadcrumbProps {
  items: OpsBreadcrumbItem[];
  className?: string;
}

export default function OpsBreadcrumb({ items, className }: OpsBreadcrumbProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 px-1 py-2 font-mono text-[11px] tracking-[0.04em]',
        className
      )}
      style={{ color: 'var(--ops-label)' }}
    >
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        const isClickable = !!item.href && !isLast;
        return (
          <span key={i} className="inline-flex items-center gap-1.5">
            {isClickable ? (
              <Link
                href={item.href!}
                className="transition-colors hover:underline hover:[color:var(--ops-bright)]"
                style={{ color: 'var(--ops-txt)' }}
              >
                {item.label}
              </Link>
            ) : (
              <span
                className=""
                style={{
                  color: isLast
                    ? 'var(--ops-info)'
                    : item.href
                      ? 'var(--ops-txt)'
                      : 'var(--ops-muted)',
                }}
              >
                {item.label}
              </span>
            )}
            {!isLast && <span style={{ color: 'var(--ops-dim)' }}>/</span>}
          </span>
        );
      })}
    </div>
  );
}
