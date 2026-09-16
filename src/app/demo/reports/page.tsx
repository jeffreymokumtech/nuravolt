'use client';

import { useEffect, useState } from 'react';
import { usePlantRoutePrefix, homeHrefFor } from '@/utils/routePrefix';
import Link from 'next/link';
import {
  Plus,
  LayoutDashboard,
  Clock,
  Share2,
  Search,
  ArrowLeft,
  CalendarClock,
} from 'lucide-react';
import ScheduledReportsList from '@/components/reports/ScheduledReportsList';
import ScheduledReportModal from '@/components/reports/ScheduledReportModal';

interface DashboardListItem {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  scope_plant_ids: string[];
  default_range: string;
  widget_count: number;
  share_token: string | null;
  created_at: string;
  updated_at: string;
}

export default function ReportsHubPage() {
  const prefix = usePlantRoutePrefix();
  const [items, setItems] = useState<DashboardListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [editingReport, setEditingReport] = useState<any>(null);
  // Bumped after modal saves so the deliveries list refetches.
  const [deliveriesVersion, setDeliveriesVersion] = useState(0);

  useEffect(() => {
    fetch('/api/dashboards')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => setItems(json?.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  const filtered = items.filter(
    (d) =>
      !search ||
      d.title.toLowerCase().includes(search.toLowerCase()) ||
      d.description?.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href={homeHrefFor(prefix)}
            className="text-ink-3 hover:text-gray-900 flex items-center gap-1 text-sm mb-2"
          >
            <ArrowLeft className="w-4 h-4" /> {prefix === '/dashboard' ? 'Fleet' : 'Portfolio'}
          </Link>
          <h1 className="text-2xl font-bold text-ink">Reports & Dashboards</h1>
          <p className="text-sm text-ink-3 mt-1">
            Build interactive dashboards, share them, schedule PDF deliveries.
          </p>
        </div>
        <Link
          href={`${prefix}/reports/new`}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
        >
          <Plus className="w-4 h-4" /> New Dashboard
        </Link>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
        <input
          type="text"
          placeholder="Search dashboards…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2 border border-divider rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {loading ? (
        <div className="text-sm text-ink-3">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-divider rounded-xl bg-white">
          <LayoutDashboard className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-ink-3">
            {search ? 'No dashboards match your search.' : 'No dashboards yet.'}
          </p>
          {!search && (
            <Link
              href={`${prefix}/reports/new`}
              className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700"
            >
              <Plus className="w-4 h-4" /> Create your first dashboard
            </Link>
          )}
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((d) => (
            <Link
              key={d.id}
              href={`${prefix}/reports/${d.id}`}
              className="block bg-white border border-divider rounded-xl p-4 shadow-sm hover:shadow-md hover:border-blue-300 transition"
            >
              <div className="flex items-start justify-between mb-2">
                <LayoutDashboard className="w-5 h-5 text-blue-600" />
                {d.share_token && (
                  <span
                    className="flex items-center gap-1 text-xs text-signal-positive bg-signal-positive/10 border border-signal-positive/20 px-2 py-0.5 rounded-full"
                    title="Public share link active"
                  >
                    <Share2 className="w-3 h-3" />
                    Shared
                  </span>
                )}
              </div>
              <div className="font-semibold text-ink truncate">{d.title}</div>
              {d.description && (
                <p className="text-xs text-ink-3 mt-1 line-clamp-2">{d.description}</p>
              )}
              <div className="flex items-center gap-3 mt-3 text-xs text-ink-3">
                <span>{d.widget_count} widgets</span>
                <span>·</span>
                <span>{d.scope_plant_ids.length || 'no'} plant{d.scope_plant_ids.length === 1 ? '' : 's'}</span>
                <span className="ml-auto flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {new Date(d.updated_at).toLocaleDateString()}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Scheduled email deliveries (weekly/monthly PDF reports). */}
      <div className="pt-2">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold text-ink flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-blue-600" /> Scheduled deliveries
            </h2>
            <p className="text-xs text-ink-3 mt-0.5">
              Emailed PDF reports built from your plants&apos; own data. Link a
              dashboard to attach its rendered view.
            </p>
          </div>
          <button
            onClick={() => {
              setEditingReport(null);
              setScheduleModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3 py-2 bg-white border border-divider rounded-lg text-sm font-medium hover:border-blue-300"
          >
            <Plus className="w-4 h-4" /> Schedule report
          </button>
        </div>
        <ScheduledReportsList
          key={deliveriesVersion}
          onEdit={(report) => {
            setEditingReport(report);
            setScheduleModalOpen(true);
          }}
          onNewReport={() => {
            setEditingReport(null);
            setScheduleModalOpen(true);
          }}
        />
      </div>

      <ScheduledReportModal
        open={scheduleModalOpen}
        onOpenChange={setScheduleModalOpen}
        existingReport={editingReport}
        onSaved={() => {
          setScheduleModalOpen(false);
          setEditingReport(null);
          setDeliveriesVersion((v) => v + 1);
        }}
      />
    </div>
  );
}
