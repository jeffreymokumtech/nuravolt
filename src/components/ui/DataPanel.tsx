import { ReactNode } from 'react';
import { cn } from '@/helpers/utils';

interface DataPanelProps {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  headerLeft?: ReactNode;
  headerRight?: ReactNode;
  footer?: ReactNode;
  live?: boolean;
  scanline?: boolean;
}

/**
 * The single allowed dark instrument-frame on the marketing surface.
 * Use it wherever a data block is embedded inside a light section
 * (hero screenshot frame, methodology panel, ticker strip rows, case
 * studies panels).
 */
export function DataPanel({
  children,
  className,
  innerClassName,
  headerLeft,
  headerRight,
  footer,
  live = false,
  scanline = false,
}: DataPanelProps) {
  const hasHeader = Boolean(headerLeft || headerRight || live);

  return (
    <div
      className={cn(
        'relative rounded-sm bg-data-bg text-data-fg border border-data-rule overflow-hidden shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_2px_4px_rgba(0,0,0,0.2)]',
        className,
      )}
    >
      {scanline && (
        <div className='absolute inset-0 pointer-events-none z-10 overflow-hidden'>
          <div className='absolute inset-0 bg-[linear-gradient(to_bottom,transparent_50%,rgba(0,255,255,0.02)_50%)] bg-[length:100%_4px] animate-[scan_10s_linear_infinite]' />
        </div>
      )}

      {hasHeader ? (
        <div className='flex items-center justify-between gap-3 px-4 py-2 border-b border-data-rule bg-data-bg-2'>
          <div className='min-w-0 flex-1 font-mono text-meta uppercase tracking-[0.08em] text-data-fg-2 truncate'>
            {headerLeft}
          </div>
          <div className='flex items-center gap-3 flex-shrink-0 font-mono text-meta uppercase tracking-[0.08em] text-data-fg-2'>
            {live ? (
              <span className='inline-flex items-center gap-1.5 text-signal-warning font-semibold tracking-widest'>
                <span className='relative flex h-2 w-2'>
                  <span className='animate-ping absolute inline-flex h-full w-full rounded-full bg-signal-warning opacity-75'></span>
                  <span className='relative inline-flex rounded-full h-2 w-2 bg-signal-warning'></span>
                </span>
                LIVE
              </span>
            ) : null}
            {headerRight ? <span className='truncate max-w-[40vw] sm:max-w-none'>{headerRight}</span> : null}
          </div>
        </div>
      ) : null}
      <div className={cn('relative z-0', innerClassName)}>{children}</div>
      {footer ? (
        <div className='px-4 py-2 border-t border-data-rule bg-data-bg-2 font-mono text-meta uppercase tracking-[0.08em] text-data-fg-2'>
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export default DataPanel;
