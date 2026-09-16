import { cn } from '@/helpers/utils';
import type { ReactNode } from 'react';

/**
 * Bordered panel, the workhorse container for every ops surface element.
 * Provides the panel chrome (border, radius, padding) plus an optional
 * header row with a mono eyebrow label on the left and free-form meta on
 * the right.
 */

interface OpsPanelProps {
  /** Eyebrow label, e.g. `DIGITAL_TWIN.expected_vs_actual` */
  label?: ReactNode;
  /** Optional descriptive line rendered below the eyebrow label. */
  subtitle?: ReactNode;
  /** Right-side slot in the header, meta line, chip, or button. */
  meta?: ReactNode;
  /** Bottom-right corner content. */
  footerMeta?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Remove the body padding entirely (useful when wrapping a flush table). */
  flush?: boolean;
  children: ReactNode;
}

export default function OpsPanel({
  label,
  subtitle,
  meta,
  footerMeta,
  className,
  bodyClassName,
  flush,
  children,
}: OpsPanelProps) {
  const hasHeader = label !== undefined || meta !== undefined;
  return (
    <div
      className={cn('overflow-hidden border', className)}
      style={{
        background: 'var(--ops-panel)',
        borderColor: 'var(--ops-hair)',
        borderRadius: 'var(--ops-radius)',
        boxShadow: 'var(--ops-shadow)',
      }}
    >
      {hasHeader && (
        <div className="px-4 pt-3.5 pb-2.5">
          {/* flex-wrap: when the meta row is wide it drops below the label
              instead of squeezing the title into a one-word-per-line sliver. */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            {label !== undefined && <span className="ops-eyebrow">{label}</span>}
            {meta !== undefined && (
              <div className="font-mono text-[10.5px]" style={{ color: 'var(--ops-muted)' }}>
                {meta}
              </div>
            )}
          </div>
          {subtitle !== undefined && (
            <div
              style={{
                fontFamily: 'var(--ops-font-sans)',
                fontSize: '12.5px',
                fontWeight: 500,
                color: 'var(--ops-txt)',
                marginTop: '1px',
                textTransform: 'none',
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
      )}
      <div className={cn(flush ? '' : 'px-4 pb-3.5 pt-1', bodyClassName)}>
        {children}
      </div>
      {footerMeta !== undefined && (
        <div
          className="flex items-center justify-between border-t px-4 py-2 font-mono text-[10px]"
          style={{ borderColor: 'var(--ops-row-hair)', color: 'var(--ops-muted)' }}
        >
          {footerMeta}
        </div>
      )}
    </div>
  );
}
