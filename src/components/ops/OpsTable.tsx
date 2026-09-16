import { cn } from '@/helpers/utils';
import type { ReactNode } from 'react';
import Link from 'next/link';
import StatusLed, { type StatusTone } from './StatusLed';
import { friendlyLabel } from './friendlyLabel';

/**
 * Mono table built for telemetry, hairline rows, fixed-width status LED
 * column, optional grouping. Columns are declared once; rows render via the
 * column accessor. Numerics already pick up `font-variant-numeric:tabular`
 * via the global mono setup, but the table also right-aligns numeric cells
 * by convention (set `numeric: true` on the column).
 */

export interface OpsColumn<T> {
  key: string;
  /** Column header label (eyebrow caps). */
  label: ReactNode;
  /** Render a cell. */
  render: (row: T, rowIndex: number) => ReactNode;
  /** Optional flex weight for the row template. Defaults to 1. */
  weight?: number;
  /** Right-align cell contents, for numerics. */
  numeric?: boolean;
  /** Optional unit suffix shown as a muted mono pill in the header (e.g. "MW", "%"). */
  unit?: string;
  className?: string;
}

interface OpsTableProps<T> {
  columns: OpsColumn<T>[];
  rows: T[];
  /** Optional status LED keyed off each row. */
  status?: (row: T) => StatusTone | null;
  /** Optional group rows, yields {label, rows[]} groups instead of a flat list. */
  groupBy?: (row: T) => string;
  /** Optional row click handler. */
  onRowClick?: (row: T, index: number) => void;
  /** Optional href accessor, turns each row into a Next.js Link for prefetched navigation. */
  rowHref?: (row: T) => string | null | undefined;
  className?: string;
  /** Optional empty-state node when rows is empty. */
  empty?: ReactNode;
}

export default function OpsTable<T>({
  columns,
  rows,
  status,
  groupBy,
  onRowClick,
  rowHref,
  className,
  empty,
}: OpsTableProps<T>) {
  const gridTemplate = (status ? '14px ' : '') +
    columns.map((c) => `${c.weight ?? 1}fr`).join(' ');

  const renderRow = (row: T, i: number, rowIndex: number) => {
    const tone = status?.(row) ?? null;
    const href = rowHref?.(row) ?? null;
    const isClickable = Boolean(onRowClick) || Boolean(href);
    const rowClass = cn(
      'grid items-center gap-2 border-t px-3 py-2 text-[12px] transition-colors',
      isClickable && 'cursor-pointer hover:brightness-105'
    );
    const rowStyle: React.CSSProperties = {
      borderColor: 'var(--ops-row-hair)',
      gridTemplateColumns: gridTemplate,
      color: 'var(--ops-txt)',
    };
    const cells = (
      <>
        {status && (
          <div className="flex justify-center">
            {tone ? <StatusLed tone={tone} size={6} /> : <span />}
          </div>
        )}
        {columns.map((col) => (
          <div
            key={col.key}
            className={cn(
              'overflow-hidden text-ellipsis whitespace-nowrap',
              col.numeric && 'text-right ops-num',
              col.className
            )}
          >
            {col.render(row, rowIndex)}
          </div>
        ))}
      </>
    );

    if (href) {
      return (
        <Link
          key={`row-${rowIndex}-${i}`}
          href={href}
          className={rowClass}
          style={rowStyle}
          onClick={onRowClick ? () => onRowClick(row, rowIndex) : undefined}
        >
          {cells}
        </Link>
      );
    }
    return (
      <div
        key={`row-${rowIndex}-${i}`}
        role={onRowClick ? 'button' : undefined}
        onClick={onRowClick ? () => onRowClick(row, rowIndex) : undefined}
        className={rowClass}
        style={rowStyle}
      >
        {cells}
      </div>
    );
  };

  if (rows.length === 0 && empty !== undefined) {
    return (
      <div
        className={cn('px-3 py-6 text-center font-mono text-[11px]', className)}
        style={{ color: 'var(--ops-muted)' }}
      >
        {empty}
      </div>
    );
  }

  return (
    <div className={cn('w-full', className)}>
      {/* Header */}
      <div
        className="grid gap-2 px-3 py-2 text-[11px] font-medium"
        style={{
          gridTemplateColumns: gridTemplate,
          color: 'var(--ops-label)',
          borderBottom: '1px solid var(--ops-row-hair)',
        }}
      >
        {status && <span />}
        {columns.map((col) => (
          <div
            key={col.key}
            className={cn(col.numeric && 'text-right')}
          >
            {typeof col.label === 'string' ? friendlyLabel(col.label) : col.label}
            {col.unit && (
              <span
                className="ml-1 font-mono normal-case tracking-normal"
                style={{ color: 'var(--ops-label)', opacity: 0.6 }}
              >
                {col.unit}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Rows, flat or grouped */}
      {groupBy ? (
        Object.entries(
          rows.reduce<Record<string, { rows: T[]; firstIndex: number }>>(
            (acc, row, idx) => {
              const k = groupBy(row);
              if (!acc[k]) acc[k] = { rows: [], firstIndex: idx };
              acc[k].rows.push(row);
              return acc;
            },
            {}
          )
        ).map(([groupLabel, group]) => (
          <div key={groupLabel}>
            <div
              className="border-t px-3 py-1.5 font-mono text-[10px]"
              style={{
                borderColor: 'var(--ops-row-hair)',
                background: 'var(--ops-panel-2)',
                color: 'var(--ops-muted)',
              }}
            >
              {groupLabel}
            </div>
            {group.rows.map((row, i) => renderRow(row, i, group.firstIndex + i))}
          </div>
        ))
      ) : (
        rows.map((row, i) => renderRow(row, i, i))
      )}
    </div>
  );
}
