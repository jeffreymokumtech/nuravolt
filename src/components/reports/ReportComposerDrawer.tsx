'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, X, Plus, ExternalLink, Check, Loader2 } from 'lucide-react';
import type { Dashboard, DashboardScope, DashboardWidget } from '@/types/dashboard';
import DashboardCanvas from './DashboardCanvas';
import WidgetCatalog from './WidgetCatalog';
import { WidgetConfigPopover } from './WidgetConfigPopover';
import { widgetDefaultLayout } from '@/lib/reports/widget-defaults';
import { useReportComposerOptional } from '@/components/copilot/ReportComposerContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

/**
 * Report composer side drawer: the live view of the report Shams is
 * composing, fully editable (drag/resize/add/remove/configure). Refetches
 * whenever a chat tool mutates the report (refreshNonce) and autosaves
 * drawer edits (debounced PUT). Positioned with fixed right offsets (no
 * transform animation — react-grid-layout drag breaks under transformed
 * ancestors).
 */

const AUTOSAVE_MS = 800;

export function ReportComposerDrawer() {
  const composer = useReportComposerOptional();
  const surface = usePlantRoutePrefix();
  const router = useRouter();

  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(720);

  const open = composer?.drawerOpen ?? false;
  const reportId = composer?.activeReportId ?? null;

  // Fetch on open / active-report change / chat mutation.
  useEffect(() => {
    if (!open || !reportId) return;
    let alive = true;
    setLoading(true);
    fetch(`/api/dashboards/${encodeURIComponent(reportId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (alive) setDashboard(d.data ?? d.dashboard ?? d);
      })
      .catch(() => {
        if (alive) setDashboard(null);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, reportId, composer?.refreshNonce]);

  // Measure canvas width (rgl needs an explicit px width).
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const w = canvasHost.current?.clientWidth;
      if (w && w > 320) setCanvasWidth(w);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, dashboard?.id]);

  const scheduleSave = useCallback(
    (next: Dashboard) => {
      setDashboard(next);
      setSaveState('saving');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          const res = await fetch(`/api/dashboards/${encodeURIComponent(next.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: next.title, widgets: next.widgets }),
          });
          setSaveState(res.ok ? 'saved' : 'error');
        } catch {
          setSaveState('error');
        }
      }, AUTOSAVE_MS);
    },
    []
  );

  if (!composer || !open) return null;

  const scope: DashboardScope = {
    plantIds: dashboard?.scope_plant_ids ?? [],
    deviceIds: dashboard?.scope_device_ids ?? [],
    range: dashboard?.default_range ?? 'last_30d',
    from: dashboard?.default_from ?? null,
    to: dashboard?.default_to ?? null,
  };

  const widgets = dashboard?.widgets ?? [];
  const editingWidget = widgets.find((w) => w.id === editingWidgetId) ?? null;
  const editorHref = `${surface === '/showcase' ? '/demo' : surface}/reports/${dashboard?.id ?? reportId}`;

  const patchWidget = (id: string, patch: Partial<DashboardWidget['config']>) => {
    if (!dashboard) return;
    scheduleSave({
      ...dashboard,
      widgets: widgets.map((w) =>
        w.id === id ? { ...w, config: { ...w.config, ...patch } } : w
      ),
    });
  };

  const addWidget = (type: string) => {
    if (!dashboard) return;
    const layout = widgetDefaultLayout(type);
    const maxY = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    scheduleSave({
      ...dashboard,
      widgets: [
        ...widgets,
        {
          id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type,
          x: 0,
          y: maxY,
          w: layout.w,
          h: layout.h,
          config: {},
        },
      ],
    });
    setCatalogOpen(false);
  };

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
        onClick={() => composer.setDrawerOpen(false)}
        aria-hidden
      />
      <aside
        className="ops-light-scope fixed inset-y-0 right-0 z-50 flex w-[min(880px,94vw)] flex-col border-l border-gray-200 bg-gray-50 shadow-2xl"
        aria-label="Report composer"
      >
        <header className="flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-3">
          <FileText className="h-4 w-4 shrink-0 text-blue-600" />
          <input
            value={dashboard?.title ?? ''}
            onChange={(e) => dashboard && scheduleSave({ ...dashboard, title: e.target.value })}
            placeholder={loading ? 'Loading…' : 'Report title'}
            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-gray-900 hover:border-gray-200 focus:border-blue-400 focus:outline-none"
          />
          <span className="shrink-0 text-[10px] text-gray-400" aria-live="polite">
            {saveState === 'saving' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : saveState === 'saved' ? (
              <span className="inline-flex items-center gap-0.5 text-emerald-600">
                <Check className="h-3 w-3" /> Saved
              </span>
            ) : saveState === 'error' ? (
              <span className="text-red-500">Save failed</span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => setCatalogOpen((v) => !v)}
            className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium ${catalogOpen ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-700'}`}
          >
            <Plus className="h-3 w-3" /> Add widget
          </button>
          <button
            type="button"
            onClick={() => router.push(editorHref)}
            className="shrink-0 rounded-md p-1.5 text-gray-400 hover:text-blue-600"
            title="Open full editor"
            aria-label="Open full editor"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => composer.setDrawerOpen(false)}
            className="shrink-0 rounded-md p-1.5 text-gray-400 hover:text-red-500"
            aria-label="Close composer"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!reportId ? (
            <EmptyNote text="No active report. Ask Shams to create one, or open one from Reports." />
          ) : loading && !dashboard ? (
            <EmptyNote text="Loading report…" />
          ) : !dashboard ? (
            <EmptyNote text="Could not load this report. It may have been deleted." />
          ) : (
            <>
              {catalogOpen && (
                <div className="mb-4">
                  <WidgetCatalog onAdd={addWidget} />
                </div>
              )}
              {editingWidget && (
                <div className="mb-4">
                  <WidgetConfigPopover
                    widget={editingWidget}
                    onChange={(patch) => patchWidget(editingWidget.id, patch)}
                    onClose={() => setEditingWidgetId(null)}
                  />
                </div>
              )}
              <div ref={canvasHost}>
                <DashboardCanvas
                  scope={scope}
                  widgets={widgets}
                  width={canvasWidth}
                  onLayoutChange={(next) => dashboard && scheduleSave({ ...dashboard, widgets: next })}
                  onRemoveWidget={(id) =>
                    dashboard &&
                    scheduleSave({ ...dashboard, widgets: widgets.filter((w) => w.id !== id) })
                  }
                  onEditWidget={(id) => setEditingWidgetId(id)}
                />
              </div>
              <p className="mt-3 text-center text-[10px] text-gray-400">
                Edits save automatically. You can also tell Shams to change this report.
              </p>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function EmptyNote({ text }: { text: string }) {
  return (
    <div className="flex h-64 items-center justify-center text-sm italic text-gray-400">
      {text}
    </div>
  );
}
