'use client';

import { cn } from '@/helpers/utils';

/**
 * Standard page header: title + optional subtitle on the left, actions slot
 * on the right. Every demo/showcase page-level surface uses this so the
 * heading scale stays consistent (h1 = text-2xl bold).
 */
export interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right-aligned slot for buttons, pills, selectors. */
  actions?: React.ReactNode;
  /** Optional leading icon or breadcrumb row rendered above the title. */
  eyebrow?: React.ReactNode;
  className?: string;
}

export default function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-1">{eyebrow}</div>}
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
