'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LayoutDashboard, Plus, Clock, Share2, ArrowUpRight } from 'lucide-react';

interface DashboardListItem {
  id: string;
  title: string;
  widget_count: number;
  share_token: string | null;
  scope_plant_ids: string[];
  updated_at: string;
}

/**
 * Portfolio-sidebar card that replaces the old compact ScheduledReportsList.
 * Shows the 4 most-recently-updated dashboards with a prominent "New Dashboard"
 * CTA and a link to the full Reports hub. Scheduled reports still live inside
 * the hub (per-dashboard), so this one card covers both use-cases cleanly.
 */
export default function ReportsCard() {
  const [items, setItems] = useState<DashboardListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/dashboards')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => setItems((json?.data ?? []).slice(0, 4)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-semibold text-ink uppercase tracking-wide">
            Reports & Dashboards
          </h3>
        </div>
        <Link
          href="/demo/reports"
          className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-0.5"
        >
          View all <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>

      {loading ? (
        <div className="text-xs text-ink-3">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-center py-5">
          <p className="text-xs text-ink-3 mb-3">
            Build interactive dashboards with the metrics you care about.
          </p>
          <Link
            href="/demo/reports/new"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" /> New Dashboard
          </Link>
        </div>
      ) : (
        <>
          <ul className="space-y-1.5 mb-3">
            {items.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/demo/reports/${d.id}`}
                  className="flex items-center justify-between gap-2 p-2 rounded-md hover:bg-slate-50 group"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink truncate group-hover:text-blue-700">
                      {d.title}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-ink-3">
                      <span>{d.widget_count} widgets</span>
                      <span>·</span>
                      <Clock className="w-3 h-3" />
                      <span>{new Date(d.updated_at).toLocaleDateString()}</span>
                      {d.share_token && (
                        <>
                          <span>·</span>
                          <Share2 className="w-3 h-3 text-signal-positive" />
                        </>
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href="/demo/reports/new"
            className="flex items-center justify-center gap-1.5 w-full px-3 py-2 border border-dashed border-slate-300 text-ink-2 rounded-md text-sm hover:border-blue-400 hover:text-blue-700"
          >
            <Plus className="w-4 h-4" /> New Dashboard
          </Link>
        </>
      )}
    </div>
  );
}
