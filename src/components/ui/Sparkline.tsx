import { cn } from '@/helpers/utils';

type Signal = 'positive' | 'warning' | 'critical' | 'neutral';

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  signal?: Signal;
  strokeWidth?: number;
  className?: string;
  ariaLabel?: string;
}

const strokeBySignal: Record<Signal, string> = {
  positive: 'hsl(var(--signal-positive))',
  warning: 'hsl(var(--signal-warning))',
  critical: 'hsl(var(--signal-critical))',
  neutral: 'hsl(var(--ink-2))',
};

/**
 * Zero-dep inline SVG sparkline. Renders a single polyline normalised to the
 * width/height. Used inside KPIReadouts, ticker rows, and DataPanels.
 */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  signal = 'neutral',
  strokeWidth = 1.25,
  className,
  ariaLabel,
}: SparklineProps) {
  if (values.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={cn('block', className)}
        aria-hidden={ariaLabel ? undefined : true}
        aria-label={ariaLabel}
      />
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const padY = strokeWidth;
  const inner = height - padY * 2;

  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = padY + inner - ((v - min) / span) * inner;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('block', className)}
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
    >
      <polyline
        points={points}
        fill='none'
        stroke={strokeBySignal[signal]}
        strokeWidth={strokeWidth}
        strokeLinecap='round'
        strokeLinejoin='round'
        vectorEffect='non-scaling-stroke'
      />
    </svg>
  );
}

export default Sparkline;
