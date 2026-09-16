'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Save,
  Share2,
  Trash2,
  ArrowLeft,
  Copy,
  Check,
  FileDown,
  Mail,
} from 'lucide-react';
import ScheduledReportModal from '@/components/reports/ScheduledReportModal';
import { REPORT_TEMPLATES } from '@/components/reports/templates';
import ScopeBar from '@/components/reports/ScopeBar';
import WidgetCatalog from '@/components/reports/WidgetCatalog';
import DashboardCanvas from '@/components/reports/DashboardCanvas';
import { WIDGET_TYPES } from '@/components/reports/widgets/registry';
import type {
  Dashboard,
  DashboardScope,
  DashboardWidget,
  DateRangePreset,
} from '@/types/dashboard';

const DEMO_PLANTS = [
  { plantId: 'ribera', plantName: 'Ribera' },
  { plantId: 'alpha', plantName: 'Alpha' },
];

/**
 * Plant options for the scope bar. On /dashboard the org's own plants are the
 * only valid scope (fixture slugs 404 for org sessions — the exact failure
 * the demo org hit); /demo keeps the static fixture pair.
 */
function useAvailablePlants(prefix: string) {
  const [plants, setPlants] = useState<
    Array<{ plantId: string; plantName: string; assetType?: string }>
  >(prefix === '/dashboard' ? [] : DEMO_PLANTS);
  useEffect(() => {
    if (prefix !== '/dashboard') return;
    let alive = true;
    fetch('/api/plants')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!alive) return;
        const rows = Array.isArray(json?.data) ? json.data : [];
        setPlants(
          rows.map((p: any) => ({
            plantId: p.slug ?? p.id,
            plantName: p.name ?? p.slug,
            assetType: p.asset_type,
          }))
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [prefix]);
  return plants;
}

/**
 * Dashboard editor / viewer. Handles both saved (id = uuid/slug) and new
 * (id = "new") dashboards. Autosave happens on explicit click; scope changes
 * are local-only until save.
 */
export default function DashboardEditorPage() {
  const prefix = usePlantRoutePrefix();
  const params = useParams();
  const router = useRouter();
  const rawId = decodeURIComponent(params.id as string);
  const isNew = rawId === 'new';
  const availablePlants = useAvailablePlants(prefix);

  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [title, setTitle] = useState('Untitled Dashboard');
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [scope, setScope] = useState<DashboardScope>({
    plantIds: [],
    deviceIds: [],
    range: 'last_30d',
    from: null,
    to: null,
  });
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleSaved, setScheduleSaved] = useState(false);

  // New dashboard on /dashboard: default the scope to the org's first plant
  // so freshly added widgets query a plant the org actually owns instead of
  // erroring until a chip is clicked.
  useEffect(() => {
    if (!isNew || prefix !== '/dashboard' || availablePlants.length === 0) return;
    setScope((s) =>
      s.plantIds.length > 0 ? s : { ...s, plantIds: [availablePlants[0].plantId] }
    );
  }, [isNew, prefix, availablePlants]);

  // Load existing dashboard
  useEffect(() => {
    if (isNew) return;
    fetch(`/api/dashboards/${rawId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!json?.data) {
          setLoading(false);
          return;
        }
        const d: Dashboard = json.data;
        setDashboard(d);
        setTitle(d.title);
        setWidgets(Array.isArray(d.widgets) ? d.widgets : []);
        setScope({
          plantIds: d.scope_plant_ids,
          deviceIds: d.scope_device_ids,
          range: (d.default_range as DateRangePreset) ?? 'last_30d',
          from: d.default_from,
          to: d.default_to,
        });
        setShareToken(d.share_token);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [isNew, rawId]);

  const save = async () => {
    setSaving(true);
    const body = {
      title,
      scope_plant_ids: scope.plantIds,
      scope_device_ids: scope.deviceIds,
      default_range: scope.range,
      default_from: scope.from,
      default_to: scope.to,
      widgets,
    };
    const res = isNew
      ? await fetch('/api/dashboards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      : await fetch(`/api/dashboards/${rawId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
    setSaving(false);
    if (res.ok) {
      const json = await res.json();
      if (isNew && json.data?.id) {
        router.replace(`${prefix}/reports/${json.data.id}`);
      } else {
        setDashboard(json.data);
      }
    }
  };

  const applyTemplate = async (templateId: string) => {
    const tpl = REPORT_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    const pvPlant = availablePlants.find((p) => p.assetType === 'PV')?.plantId;
    const bessPlant = availablePlants.find(
      (p) => p.assetType === 'BESS' || p.assetType === 'HYBRID'
    )?.plantId;
    // Deep-dive templates chart the worst inverters; fetch the twin's fleet
    // ranking so the device slots come prefilled. Build still works without.
    let worstDevices: string[] | undefined;
    if (tpl.wantsWorstDevices && pvPlant) {
      try {
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
        const res = await fetch(
          `/api/digitaltwin/${encodeURIComponent(pvPlant)}/inverter-metrics?from=${from}&to=${to}`,
        );
        if (res.ok) {
          const json = await res.json();
          worstDevices = (json?.inverters ?? [])
            .filter((inv: any) => inv?.inverterId && Number.isFinite(inv?.lossPct))
            .sort((a: any, b: any) => b.lossPct - a.lossPct)
            .slice(0, 3)
            .map((inv: any) => String(inv.inverterId));
        }
      } catch {
        worstDevices = undefined;
      }
    }
    const built = tpl.build({
      pvPlant,
      bessPlant,
      allPlants: availablePlants.map((p) => p.plantId),
      worstDevices,
    });
    setTitle(built.title);
    setWidgets(built.widgets as DashboardWidget[]);
    setScope((s) => ({ ...s, plantIds: built.plantIds }));
  };

  const addWidget = (type: string) => {
    const meta = WIDGET_TYPES[type];
    if (!meta) return;
    // Find next open y by putting the new widget at the bottom.
    const maxY = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    const id = `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setWidgets([
      ...widgets,
      {
        id,
        type,
        x: 0,
        y: maxY,
        w: meta.defaultLayout.w,
        h: meta.defaultLayout.h,
        config: {},
      },
    ]);
  };

  const removeWidget = (id: string) =>
    setWidgets(widgets.filter((w) => w.id !== id));

  const enableShare = async () => {
    if (isNew) {
      await save();
      return;
    }
    const res = await fetch(`/api/dashboards/${rawId}/share`, { method: 'POST' });
    if (res.ok) {
      const json = await res.json();
      setShareToken(json.data.share_token);
    }
  };

  const copyShareLink = () => {
    if (!shareToken) return;
    const url = `${window.location.origin}/r/${shareToken}`;
    navigator.clipboard.writeText(url);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  };

  const exportPdf = async () => {
    if (isNew) {
      alert('Save the dashboard first before exporting.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/dashboards/${rawId}/export-pdf`, { method: 'POST' });
      if (!res.ok) {
        alert('PDF export failed');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${dashboard?.slug || 'dashboard'}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (isNew || !dashboard) return;
    if (!confirm('Delete this dashboard?')) return;
    await fetch(`/api/dashboards/${dashboard.id}`, { method: 'DELETE' });
    router.replace(`${prefix}/reports`);
  };

  if (loading) {
    return (
      <div className="p-8 text-sm text-ink-3">Loading dashboard…</div>
    );
  }

  return (
    <div className="max-w-[1400px] mx-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href={`${prefix}/reports`}
            className="text-ink-3 hover:text-gray-900 flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="w-4 h-4" /> Reports
          </Link>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="text-2xl font-bold text-ink bg-transparent border-b border-transparent focus:border-blue-400 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          {shareToken && (
            <button
              onClick={copyShareLink}
              className="flex items-center gap-1.5 px-3 py-2 bg-signal-positive/10 text-signal-positive border border-signal-positive/20 rounded-lg text-sm hover:bg-emerald-100"
            >
              {shareCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {shareCopied ? 'Copied!' : 'Copy share link'}
            </button>
          )}
          <button
            onClick={enableShare}
            className="flex items-center gap-1.5 px-3 py-2 bg-white border border-divider rounded-lg text-sm hover:border-blue-300"
          >
            <Share2 className="w-4 h-4" /> {shareToken ? 'Rotate share' : 'Share'}
          </button>
          <button
            onClick={exportPdf}
            disabled={saving || isNew}
            className="flex items-center gap-1.5 px-3 py-2 bg-white border border-divider rounded-lg text-sm hover:border-blue-300 disabled:opacity-50"
            title={isNew ? 'Save the dashboard first' : 'Export dashboard as PDF'}
          >
            <FileDown className="w-4 h-4" /> Export PDF
          </button>
          <button
            onClick={() => setScheduleOpen(true)}
            disabled={isNew}
            className="flex items-center gap-1.5 px-3 py-2 bg-white border border-divider rounded-lg text-sm hover:border-blue-300 disabled:opacity-50"
            title={isNew ? 'Save the dashboard first' : 'Email this report on a weekly or monthly schedule'}
          >
            <Mail className="w-4 h-4" /> Schedule email
          </button>
          {!isNew && (
            <button
              onClick={del}
              className="p-2 bg-white border border-divider rounded-lg text-ink-3 hover:text-red-600 hover:border-red-300"
              title="Delete dashboard"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
          >
            <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {scheduleSaved && (
        <div className="text-sm text-signal-positive bg-signal-positive/10 border border-signal-positive/20 rounded-lg px-3 py-2">
          Email schedule created. Manage it under Reports → Scheduled deliveries.
        </div>
      )}

      {/* Template chooser: fresh dashboards only, until the first widget. */}
      {isNew && widgets.length === 0 && (
        <div className="bg-white border border-divider rounded-xl p-4">
          <div className="text-sm font-semibold text-ink mb-1">Start from a template</div>
          <p className="text-xs text-ink-3 mb-3">
            Pre-built layouts scoped to your plants — every widget stays editable, or keep
            building from the blank canvas below.
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            {REPORT_TEMPLATES.filter((t) => {
              if (t.requires === 'bess') {
                return availablePlants.some(
                  (p) => p.assetType === 'BESS' || p.assetType === 'HYBRID'
                );
              }
              if (t.requires === 'pv') {
                return availablePlants.some(
                  (p) => p.assetType === 'PV' || p.assetType === 'HYBRID'
                );
              }
              return true;
            }).map((t) => (
              <button
                key={t.id}
                onClick={() => applyTemplate(t.id)}
                className="text-left border border-divider rounded-lg p-3 hover:border-blue-300 hover:shadow-sm transition"
              >
                <div className="text-sm font-semibold text-ink">{t.label}</div>
                <p className="text-xs text-ink-3 mt-1">{t.description}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      <ScopeBar
        scope={scope}
        onChange={setScope}
        availablePlants={availablePlants}
      />

      <div className="grid grid-cols-[260px_1fr] gap-4">
        <div>
          <WidgetCatalog onAdd={addWidget} />
        </div>
        <div>
          <DashboardCanvas
            scope={scope}
            widgets={widgets}
            onLayoutChange={setWidgets}
            onRemoveWidget={removeWidget}
          />
        </div>
      </div>

      {!isNew && (
        <ScheduledReportModal
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          dashboardId={dashboard?.id ?? rawId}
          initialName={title}
          initialPlantIds={scope.plantIds}
          onSaved={() => {
            setScheduleOpen(false);
            setScheduleSaved(true);
            setTimeout(() => setScheduleSaved(false), 6000);
          }}
        />
      )}
    </div>
  );
}
