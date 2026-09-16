'use client';

import { useEffect, useState } from 'react';
import { ChevronRight, Radio, Satellite, Sparkles, Gauge, ArrowRight } from 'lucide-react';
import OpsPanel from '@/components/ops/OpsPanel';

type SourceClass = 'ingested' | 'sensor' | 'satellite' | 'climate_transfer' | 'synthesized';

interface FieldMap {
  from: string;
  to: string;
  unit: string | null;
  confidence: number | null;
}

interface Stream {
  key: string;
  label: string;
  metrics: string[];
  source_class: SourceClass;
  source_label: string;
  connection: { name: string; type: string; status: string } | null;
  field_mappings: FieldMap[];
  last_updated: string | null;
  provisional: boolean;
  note?: string;
}

interface LineageResponse {
  plant: {
    slug: string;
    has_weather_station: boolean;
    irradiance_sensor_type: string | null;
    has_dustiq_sensor: boolean;
  };
  streams: Stream[];
}

/**
 * Per-plant data provenance: for every stream the platform uses, shows where
 * it actually comes from — the ingested SCADA/inverter feed (with the raw
 * device -> metric field mappings), open-source satellite reanalysis, the
 * climate-transfer forecast, or a synthesized placeholder awaiting a real feed.
 */

const CLASS_META: Record<
  SourceClass,
  { badge: string; tone: string; bg: string; border: string; Icon: typeof Radio }
> = {
  ingested: {
    badge: 'INGESTED',
    tone: 'var(--ops-ok)',
    bg: 'var(--ops-ok-bg)',
    border: 'var(--ops-ok-border)',
    Icon: Radio,
  },
  sensor: {
    badge: 'ON-SITE SENSOR',
    tone: 'var(--ops-ok)',
    bg: 'var(--ops-ok-bg)',
    border: 'var(--ops-ok-border)',
    Icon: Gauge,
  },
  satellite: {
    badge: 'SATELLITE / OPEN DATA',
    tone: 'var(--ops-info)',
    bg: 'var(--ops-info-bg)',
    border: 'var(--ops-info-border)',
    Icon: Satellite,
  },
  climate_transfer: {
    badge: 'CLIMATE TRANSFER',
    tone: 'var(--ops-warn)',
    bg: 'var(--ops-warn-bg)',
    border: 'var(--ops-warn-border)',
    Icon: Sparkles,
  },
  synthesized: {
    badge: 'SYNTHESIZED',
    tone: 'var(--ops-bess)',
    bg: 'var(--ops-bess-bg)',
    border: 'var(--ops-bess-border)',
    Icon: Sparkles,
  },
};

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export default function DataLineagePanel({ plantId }: { plantId: string }) {
  const [data, setData] = useState<LineageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/plants/${plantId}/data-lineage`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`lineage ${r.status}`);
        return r.json();
      })
      .then((json: LineageResponse) => {
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [plantId]);

  return (
    <OpsPanel
      label="Data lineage · provenance"
      subtitle="Where each stream actually comes from"
      meta={
        <span style={{ color: 'var(--ops-muted)' }}>
          {data ? `${data.streams.length} streams` : ''}
        </span>
      }
      flush
    >
      {loading && (
        <div className="px-3.5 py-4 font-mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>
          resolving provenance…
        </div>
      )}

      {error && !loading && (
        <div className="px-3.5 py-4 font-mono text-[11px]" style={{ color: 'var(--ops-alarm)' }}>
          {error}
        </div>
      )}

      {data && !loading && data.streams.length === 0 && (
        <div className="px-3.5 py-4 font-mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>
          No streams configured yet. Connect a source below to populate lineage.
        </div>
      )}

      {data && !loading && data.streams.length > 0 && (
        <ul>
          {data.streams.map((s) => {
            const meta = CLASS_META[s.source_class] ?? CLASS_META.synthesized;
            const { Icon } = meta;
            const isOpen = !!expanded[s.key];
            const hasMappings = s.field_mappings.length > 0;
            const rel = relativeTime(s.last_updated);
            return (
              <li
                key={s.key}
                className="border-t first:border-t-0"
                style={{ borderColor: 'var(--ops-row-hair)' }}
              >
                <div className="flex items-start gap-3 px-3.5 py-2.5">
                  <Icon
                    className="mt-0.5 h-4 w-4 flex-shrink-0"
                    style={{ color: meta.tone }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span
                        className="font-sans text-[13px] font-medium"
                        style={{ color: 'var(--ops-txt)' }}
                      >
                        {s.label}
                      </span>
                      <span
                        className="inline-flex items-center rounded-sm px-1.5 py-px font-mono text-[9px] font-medium tracking-wider"
                        style={{ color: meta.tone, background: meta.bg, border: `1px solid ${meta.border}` }}
                      >
                        {meta.badge}
                      </span>
                      {s.provisional && (
                        <span
                          className="font-mono text-[9px] uppercase tracking-wider"
                          style={{ color: 'var(--ops-warn)' }}
                        >
                          provisional
                        </span>
                      )}
                    </div>

                    <div
                      className="mt-0.5 font-mono text-[11px]"
                      style={{ color: 'var(--ops-muted)' }}
                    >
                      {s.source_label}
                      {rel ? ` · updated ${rel}` : ''}
                      {s.connection ? ` · ${s.connection.status.toLowerCase()}` : ''}
                    </div>

                    {s.metrics.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {s.metrics.map((m) => (
                          <span
                            key={m}
                            className="rounded-sm px-1.5 py-px font-mono text-[10px]"
                            style={{
                              color: 'var(--ops-dim)',
                              background: 'var(--ops-surface-2)',
                              border: '1px solid var(--ops-row-hair)',
                            }}
                          >
                            {m}
                          </span>
                        ))}
                      </div>
                    )}

                    {s.note && (
                      <div
                        className="mt-1 font-sans text-[11px] leading-snug"
                        style={{ color: 'var(--ops-dim)' }}
                      >
                        {s.note}
                      </div>
                    )}

                    {hasMappings && (
                      <>
                        <button
                          type="button"
                          onClick={() => setExpanded((p) => ({ ...p, [s.key]: !p[s.key] }))}
                          className="mt-1.5 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider transition-colors"
                          style={{ color: 'var(--ops-info)' }}
                        >
                          <ChevronRight
                            className="h-3 w-3 transition-transform"
                            style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }}
                          />
                          {s.field_mappings.length} field mapping
                          {s.field_mappings.length === 1 ? '' : 's'}
                        </button>

                        {isOpen && (
                          <div
                            className="mt-1.5 overflow-hidden rounded-sm border"
                            style={{ borderColor: 'var(--ops-row-hair)' }}
                          >
                            {s.field_mappings.map((fm, i) => (
                              <div
                                key={`${fm.from}-${i}`}
                                className="flex items-center gap-2 px-2 py-1 font-mono text-[10px]"
                                style={{
                                  borderTop: i === 0 ? 'none' : '1px solid var(--ops-row-hair)',
                                  color: 'var(--ops-txt)',
                                }}
                              >
                                <span style={{ color: 'var(--ops-dim)' }}>{fm.from}</span>
                                <ArrowRight
                                  className="h-3 w-3 flex-shrink-0"
                                  style={{ color: 'var(--ops-muted)' }}
                                />
                                <span style={{ color: 'var(--ops-ok)' }}>{fm.to}</span>
                                {fm.unit && (
                                  <span style={{ color: 'var(--ops-muted)' }}>[{fm.unit}]</span>
                                )}
                                {fm.confidence != null && (
                                  <span className="ml-auto" style={{ color: 'var(--ops-muted)' }}>
                                    {Math.round(fm.confidence * 100)}%
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </OpsPanel>
  );
}
