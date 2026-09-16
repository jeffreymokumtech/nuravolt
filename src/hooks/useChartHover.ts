'use client';

import { useCallback, useRef, useState } from 'react';

export interface ChartHoverState {
  hoverIdx: number | null;
  hoverX: number;
  hoverY: number;
  isHovering: boolean;
}

export interface ChartHoverApi extends ChartHoverState {
  containerRef: React.RefObject<HTMLDivElement>;
  onPointerMove: (e: React.PointerEvent<Element>) => void;
  onPointerLeave: () => void;
  reset: () => void;
}

/**
 * Shared pointer/hover state for chart primitives. Tracks the nearest x-index
 * under the cursor + pointer coords in container space. Every interactive
 * chart wires its outer SVG to onPointerMove/onPointerLeave; OpsTooltip
 * reads `hoverX` + `containerWidth` for auto-flip positioning.
 */
export function useChartHover(dataLength: number): ChartHoverApi {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ChartHoverState>({
    hoverIdx: null,
    hoverX: 0,
    hoverY: 0,
    isHovering: false,
  });

  const onPointerMove = useCallback(
    (e: React.PointerEvent<Element>) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || dataLength === 0) return;
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const ratio = Math.max(0, Math.min(1, localX / rect.width));
      const idx = Math.round(ratio * (dataLength - 1));
      setState({ hoverIdx: idx, hoverX: localX, hoverY: localY, isHovering: true });
    },
    [dataLength]
  );

  const onPointerLeave = useCallback(() => {
    setState({ hoverIdx: null, hoverX: 0, hoverY: 0, isHovering: false });
  }, []);

  return {
    ...state,
    containerRef,
    onPointerMove,
    onPointerLeave,
    reset: onPointerLeave,
  };
}
