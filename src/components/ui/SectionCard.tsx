'use client';

import { cn } from '@/helpers/utils';

/**
 * Standard content card: white, rounded-xl, gray-200 border, shadow-sm,
 * p-5. Optional header row (title + description + actions). Every section
 * body on the demo/showcase surfaces wraps in this so card chrome stops
 * drifting between pages.
 */
export interface SectionCardProps {
  children: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Right side of the header row. */
  actions?: React.ReactNode;
  /** Remove the default padding (e.g. for full-bleed tables). */
  flush?: boolean;
  className?: string;
  id?: string;
}

export default function SectionCard({
  children,
  title,
  description,
  actions,
  flush = false,
  className,
  id,
}: SectionCardProps) {
  const hasHeader = title || description || actions;
  return (
    <div
      id={id}
      className={cn(
        'overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm',
        !flush && 'p-5',
        className,
      )}
    >
      {hasHeader && (
        <div
          className={cn(
            'flex flex-wrap items-start justify-between gap-2',
            flush && 'px-5 pt-5',
            'mb-4',
          )}
        >
          <div className="min-w-0">
            {title && <h2 className="text-lg font-semibold text-gray-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-gray-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
