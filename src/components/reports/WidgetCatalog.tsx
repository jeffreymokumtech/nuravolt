'use client';

import { Plus, LayoutGrid } from 'lucide-react';
import { WIDGET_LIST } from './widgets/registry';

interface Props {
  onAdd: (widgetType: string) => void;
}

/**
 * Side panel listing all widget types grouped by category. Clicking a widget
 * adds it to the canvas at the next open slot.
 */
export default function WidgetCatalog({ onAdd }: Props) {
  const byCategory = WIDGET_LIST.reduce<Record<string, typeof WIDGET_LIST>>((acc, w) => {
    (acc[w.category] ||= []).push(w);
    return acc;
  }, {});

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-3 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <LayoutGrid className="w-4 h-4 text-gray-500" />
        Widgets
      </div>
      {Object.entries(byCategory).map(([cat, widgets]) => (
        <div key={cat}>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1.5">
            {cat}
          </div>
          <div className="space-y-1.5">
            {widgets.map((w) => (
              <button
                key={w.id}
                onClick={() => onAdd(w.id)}
                className="w-full text-left p-2 rounded-md border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-colors group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {w.label}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                      {w.description}
                    </div>
                  </div>
                  <Plus className="w-4 h-4 text-gray-400 group-hover:text-blue-600 flex-shrink-0" />
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
