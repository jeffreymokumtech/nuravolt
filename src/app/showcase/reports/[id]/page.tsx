'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileText, Lock, Share2 } from 'lucide-react';

interface SampleDashboardTile {
  title: string;
  metric?: string;
  unit?: string;
  series?: { label: string; value: number }[];
  note?: string;
}

interface SampleDashboard {
  id: string;
  title: string;
  subtitle: string;
  scope: string;
  generated_at: string;
  tiles: SampleDashboardTile[];
}

export default function ShowcaseReportViewerPage() {
  const params = useParams();
  const id = decodeURIComponent(params.id as string);

  const [dashboard, setDashboard] = useState<SampleDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/data/showcase/dashboards/${id}.json`)
      .then((r) => {
        if (!r.ok) throw new Error('Not found');
        return r.json();
      })
      .then((json) => setDashboard(json))
      .catch((err) => setError(err.message));
  }, [id]);

  if (error) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-10">
        <Link
          href="/showcase/reports"
          className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-gray-900 mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Reports
        </Link>
        <div className="rounded-xl bg-signal-critical/10 border border-signal-critical/20 p-6 text-signal-critical">
          Could not load dashboard: {error}
        </div>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 sm:px-6 py-10">
        <div className="text-ink-3">Loading dashboard…</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-8">
      <Link
        href="/showcase/reports"
        className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-gray-900 mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        Reports
      </Link>

      {/* Header */}
      <div className="rounded-xl bg-white border border-divider p-6 mb-6">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1">
              {dashboard.scope}
            </div>
            <h1 className="text-2xl font-bold text-ink mb-1">{dashboard.title}</h1>
            <p className="text-sm text-ink-2">{dashboard.subtitle}</p>
            <div className="text-xs text-ink-3 mt-2">
              Generated {new Date(dashboard.generated_at).toLocaleString()}
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-signal-positive/10 text-signal-positive px-3 py-1 font-semibold border border-signal-positive/20">
              <Lock className="w-3 h-3" />
              Read-only snapshot
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-paper-2 text-ink-3 rounded-lg cursor-not-allowed"
              disabled
              title="Disabled in showcase"
            >
              <Share2 className="w-3.5 h-3.5" /> Share
            </button>
          </div>
        </div>
      </div>

      {/* Tiles */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-6">
        {dashboard.tiles.map((tile, i) => (
          <div key={i} className="rounded-xl bg-white border border-divider p-5">
            <div className="text-xs text-ink-3 font-semibold uppercase tracking-wider mb-2">
              {tile.title}
            </div>
            {tile.metric && (
              <div className="text-3xl font-bold text-ink mb-1">
                {tile.metric}
                {tile.unit && (
                  <span className="text-base text-ink-3 font-normal ml-1">{tile.unit}</span>
                )}
              </div>
            )}
            {tile.series && tile.series.length > 0 && (
              <div className="mt-3 space-y-2">
                {tile.series.map((s, j) => {
                  const max = Math.max(...(tile.series ?? []).map((x) => Math.abs(x.value))) || 1;
                  const pct = (Math.abs(s.value) / max) * 100;
                  return (
                    <div key={j} className="flex items-center gap-3">
                      <span className="text-xs text-ink-2 w-32 flex-shrink-0">{s.label}</span>
                      <div className="flex-1 relative h-5 bg-paper-2 rounded-full overflow-hidden">
                        <div
                          className={`absolute inset-y-0 left-0 ${s.value < 0 ? 'bg-red-400' : 'bg-blue-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-ink-2 w-16 text-right">
                        {s.value >= 0 ? '+' : ''}
                        {s.value.toFixed(1)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {tile.note && <p className="text-xs text-ink-3 mt-3">{tile.note}</p>}
          </div>
        ))}
      </div>

      {/* Notice */}
      <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 flex items-start gap-4">
        <FileText className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-blue-900 leading-relaxed">
          This is a <strong>static snapshot</strong> for the public showcase. In the
          production reporter, every widget pulls live data at render time, is fully
          interactive, and can be exported to PDF or scheduled for recurring email
          delivery.
        </div>
      </div>
    </div>
  );
}
