'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Measures the space the card gives a widget's chart and hands the height down
 * as a number, so fixed-height chart primitives (OpsLineChart, the ECharts
 * wrappers) fill the card instead of leaving whitespace below. Renders at a
 * fallback height until the first measurement; ignores sub-2px changes to
 * avoid re-render thrash while the grid item is being drag-resized.
 */
export default function ChartFill({
  fallback = 200,
  children,
}: {
  fallback?: number;
  children: (height: number) => React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let last = 0;
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().height);
      if (next > 0 && Math.abs(next - last) >= 2) {
        last = next;
        setHeight(next);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className="h-full min-h-0 overflow-hidden">
      {children(height ?? fallback)}
    </div>
  );
}
