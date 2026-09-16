'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import GridLayout, { Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { X } from 'lucide-react';
import type { DashboardScope, DashboardWidget } from '@/types/dashboard';
import { WIDGET_TYPES } from './widgets/registry';

interface Props {
  scope: DashboardScope;
  widgets: DashboardWidget[];
  onLayoutChange?: (widgets: DashboardWidget[]) => void;
  onRemoveWidget?: (widgetId: string) => void;
  onEditWidget?: (widgetId: string) => void;
  readOnly?: boolean;
  width?: number;
}

const COLS = 12;
const ROW_HEIGHT = 60;

/**
 * Main canvas, renders widgets in a react-grid-layout. In edit mode the user
 * can drag, resize, delete. In read-only mode (public share, scheduled PDF)
 * we disable all interactions and render a static grid. The grid width tracks
 * the container (an explicit `width` prop overrides).
 */
export default function DashboardCanvas({
  scope,
  widgets,
  onLayoutChange,
  onRemoveWidget,
  onEditWidget,
  readOnly,
  width,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let last = 0;
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 0 && Math.abs(next - last) >= 2) {
        last = next;
        setMeasuredWidth(next);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const gridWidth = width ?? measuredWidth ?? 1100;
  const layout: Layout[] = useMemo(
    () =>
      widgets.map((w) => ({
        i: w.id,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        minW: 3,
        minH: 3,
      })),
    [widgets],
  );

  const handleLayoutChange = (next: Layout[]) => {
    if (!onLayoutChange) return;
    const byId = new Map(next.map((l) => [l.i, l]));
    onLayoutChange(
      widgets.map((w) => {
        const l = byId.get(w.id);
        return l ? { ...w, x: l.x, y: l.y, w: l.w, h: l.h } : w;
      }),
    );
  };

  if (widgets.length === 0) {
    return (
      <div className="flex items-center justify-center h-96 border-2 border-dashed border-gray-200 rounded-xl bg-white text-gray-400 text-sm">
        No widgets yet, pick one from the catalog to begin.
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      <GridLayout
      className="layout"
      layout={layout}
      cols={COLS}
      rowHeight={ROW_HEIGHT}
      width={gridWidth}
      isDraggable={!readOnly}
      isResizable={!readOnly}
      onLayoutChange={handleLayoutChange}
      draggableCancel=".widget-no-drag"
      margin={[12, 12]}
    >
      {widgets.map((w) => {
        const meta = WIDGET_TYPES[w.type];
        const Component = meta?.component;
        return (
          <div key={w.id} className="bg-white border border-gray-200 rounded-xl shadow-sm p-3 overflow-hidden flex flex-col">
            <div className="flex items-start justify-between mb-1.5 widget-no-drag">
              <div className="text-xs font-semibold text-gray-700 truncate">
                {w.config.title || meta?.label || w.type}
              </div>
              {!readOnly && (
                <div className="flex items-center gap-1">
                  {onEditWidget && (
                    <button
                      className="text-xs text-gray-400 hover:text-blue-600"
                      onClick={() => onEditWidget(w.id)}
                      title="Edit widget scope"
                    >
                      Edit
                    </button>
                  )}
                  {onRemoveWidget && (
                    <button
                      className="text-gray-400 hover:text-red-600"
                      onClick={() => onRemoveWidget(w.id)}
                      title="Remove widget"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 widget-no-drag">
              {Component ? (
                <Component scope={scope} widget={w} readOnly={readOnly} />
              ) : (
                <div className="text-sm text-red-500 p-4">
                  Unknown widget type: {w.type}
                </div>
              )}
            </div>
          </div>
        );
      })}
      </GridLayout>
    </div>
  );
}
