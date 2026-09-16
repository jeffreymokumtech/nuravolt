'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OpsPanel from '@/components/ops/OpsPanel';
import TelemetryStrip from '@/components/ops/TelemetryStrip';
import AlarmStack from '@/components/ops/AlarmStack';
import OpsTable from '@/components/ops/OpsTable';
import OpsFooter from '@/components/ops/OpsFooter';
import FaultExplanationDrawer, {
  type FaultDetails,
  type CascadeLayer,
} from '@/components/ops/FaultExplanationDrawer';
import { useDataRoot } from '@/contexts/DataSourceContext';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import type { StatusTone } from '@/components/ops/StatusLed';
import type { PredictiveAlarm } from '@/lib/tickets/createFromAlarm';

interface OpsFaultsProps {
  plantId: string;
}

interface FaultsEnhanced {
  plant_id: string;
  generated_at: string;
  summary: {
    current_loss_kwh: number;
    projected_loss_kwh: number;
    currency: string;
    reactive_count: number;
    predictive_count: number;
    critical_count: number;
    urgent_count: number;
    soon_count: number;
    planned_count: number;
    monitoring_count: number;
  };
  health_score: { value: number; status: string; trend: string };
  urgency_summary: Record<string, { count: number; total_revenue_at_risk_eur: number }>;
  rul_predictions: Array<{
    fault_type: string;
    display_name: string;
    days_to_fault: number;
    confidence: number;
    current_value: number;
    threshold: number;
    unit: string;
    trend: number;
    urgency: string;
    recommended_action: string;
    repair_cost_eur: number;
    estimated_date: string;
    projected_energy_loss_kwh: number;
    revenue_at_risk_eur: number;
    inverter_id: string;
  }>;
  predictive_faults: Array<{
    id: string;
    fault_type: string;
    display_name: string;
    equipment_id: string;
    days_to_fault: number;
    urgency: string;
    recommended_action: string;
    revenue_at_risk_eur: number;
    classification_layer?: 'RULE' | 'TWIN_RESIDUAL' | 'ML_CLASSIFIER' | 'AI_OVERRIDE';
    evidence?: string;
    winner_reason?: string;
    cascade_winning_confidence?: number;
    asset_type?: string;
    bess_source?: boolean;
    is_reactive?: boolean;
  }>;
  cascade_summary?: {
    rows_classified: number;
    layer_distribution: Partial<Record<'RULE' | 'TWIN_RESIDUAL' | 'ML_CLASSIFIER' | 'AI_OVERRIDE', number>>;
    ai_overrides: number;
    ai_override_rate: number;
  };
  maintenance_schedule?: {
    /** Per-day breakdown of upcoming maintenance, array of `{ date, tasks[] }`. */
    next_7_days: Array<{ date: string; tasks: unknown[] }> | number;
    total_repair_cost_eur: number;
    total_revenue_saved_eur: number;
    roi_pct: number;
  };
}

const URG_TONE: Record<string, StatusTone> = {
  critical: 'alarm',
  urgent: 'alarm',
  soon: 'warn',
  planned: 'info',
  monitoring: 'muted',
};

type AssetFilter = 'all' | 'pv' | 'bess';
type LifecycleFilter = 'all' | 'active' | 'predictive';

// ---------------------------------------------------------------------------
// Plant classifications payload, shape returned by
// /api/plants/[plantId]/classifications. Kept loose so a missing endpoint or
// empty list both render the same friendly empty state.
// ---------------------------------------------------------------------------
interface PlantClassificationRow {
  inverterId: string;
  plantId: string;
  group: string;
  tier: 'ACUTE' | 'DEGRADED' | 'CHRONIC' | 'NORMAL' | string;
  pds: number;
  likelyCause: string;
  confidence: number;
  etaDays: number | null;
  projectedEnergyLossKwhPerDay: number | null;
  evidence: string[];
  recommendedAction: string;
  ruleId: string;
  generatedAt: string;
}

interface PlantClassificationsResponse {
  plantId: string;
  not_applicable?: boolean;
  asset_type?: string;
  classifications?: PlantClassificationRow[];
}

const TIER_TONE: Record<string, StatusTone> = {
  ACUTE: 'alarm',
  DEGRADED: 'warn',
  CHRONIC: 'info',
  NORMAL: 'ok',
};

function truncate(s: string | undefined | null, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Horizontal "earliest predicted fault per asset" bars. Each row = one asset
 * (inverter or battery), sorted by ascending days_to_fault. Tone is driven by
 * the per-asset earliest fault's urgency (critical → red, soon → amber,
 * monitoring → muted). Bar length is log-scaled so a 1-day fault doesn't
 * compress 3650-day ones into invisibility.
 */
function AssetRulBars({
  rows,
}: {
  rows: Array<{
    asset: string;
    kind: 'PV' | 'BESS';
    days: number;
    urgency: string;
    topFault: string;
    topRecommended: string;
  }>;
}) {
  const TONE_VAR: Record<string, string> = {
    critical: 'var(--ops-alarm)',
    urgent: 'var(--ops-warn)',
    soon: 'var(--ops-warn)',
    planned: 'var(--ops-info)',
    monitoring: 'var(--ops-muted)',
  };
  // Log scale so 1d fits next to 3650d. Floor at log(1) = 0.
  const maxLog = Math.max(...rows.map((r) => Math.log10(Math.max(1, r.days + 1))));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => {
        const pct = maxLog > 0 ? (Math.log10(Math.max(1, r.days + 1)) / maxLog) * 100 : 0;
        const tone = TONE_VAR[r.urgency] ?? 'var(--ops-info)';
        const daysLabel = r.days <= 0 ? 'now' : r.days < 1 ? '<1d' : `${Math.round(r.days)}d`;
        return (
          <div key={r.asset}>
            <div className="mb-1 flex items-baseline justify-between font-mono text-[11.5px]">
              <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ops-txt)' }}>
                <span
                  className="rounded-sm border px-1 py-px text-[9px] uppercase tracking-wider"
                  style={{
                    color: r.kind === 'BESS' ? 'var(--ops-bess)' : 'var(--ops-info)',
                    borderColor: 'var(--ops-hair)',
                    background: 'var(--ops-panel-2)',
                  }}
                >
                  {r.kind}
                </span>
                <span className="ops-num">{r.asset}</span>
                <span style={{ color: 'var(--ops-muted)' }}> · {truncate(r.topFault, 32)}</span>
              </span>
              <span className="ops-num" style={{ color: tone }}>
                {daysLabel}
              </span>
            </div>
            <div className="h-[7px] overflow-hidden rounded" style={{ background: 'var(--ops-row-hair)' }}>
              <div className="h-full" style={{ width: `${pct}%`, background: tone }} />
            </div>
          </div>
        );
      })}
      <div className="pt-1 font-mono text-[10px]" style={{ color: 'var(--ops-muted)' }}>
        Bar length is log-scaled. &ldquo;now&rdquo; = fault already due. Long bars (3650d) = no near-term concern.
      </div>
    </div>
  );
}

export default function OpsFaults({ plantId }: OpsFaultsProps) {
  const dataRoot = useDataRoot();
  const prefix = usePlantRoutePrefix();
  const [data, setData] = useState<FaultsEnhanced | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Triage acks for predictive-fault rows (artifact-derived, no DB identity);
  // persisted per plant in localStorage so an ack survives reloads.
  const ackStorageKey = `nuravolt:faultAcks:${plantId}`;
  const [acked, setAcked] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = window.localStorage.getItem(ackStorageKey);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const ackFault = useCallback(
    (id: string) => {
      setAcked((prev) => {
        const next = new Set([...prev, id]);
        try {
          window.localStorage.setItem(ackStorageKey, JSON.stringify([...next]));
        } catch {
          // localStorage unavailable; session-only ack still works
        }
        return next;
      });
      // Persist server-side so a teammate on another device sees the triage.
      // Best effort: a 401 in the public demo is fine (localStorage still holds
      // it), and the id doubles as the stable fault_key.
      fetch(`/api/plants/${encodeURIComponent(plantId)}/fault-acks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fault_key: id }),
      }).catch(() => {});
    },
    [ackStorageKey, plantId],
  );

  // Merge shared server-side acks over the local set. 401 (public demo) just
  // leaves the localStorage acks in place.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/plants/${encodeURIComponent(plantId)}/fault-acks`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || !Array.isArray(d.acked) || d.acked.length === 0) return;
        setAcked((prev) => {
          const next = new Set([...prev, ...(d.acked as string[])]);
          try {
            window.localStorage.setItem(ackStorageKey, JSON.stringify([...next]));
          } catch {
            /* ignore */
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plantId, ackStorageKey]);
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>('all');

  // Drawer state, shared between the predictive-alarm rows and the
  // Maintenance Horizon (classifications) panel below.
  const [drawerFault, setDrawerFault] = useState<FaultDetails | null>(null);

  // Maintenance horizon (plant classifications), folded in from the deleted
  // standalone page. 404 / empty / network failure all collapse to "no
  // predictive faults flagged".
  const [classifications, setClassifications] = useState<
    PlantClassificationRow[] | null
  >(null);
  const [classificationsLoaded, setClassificationsLoaded] = useState(false);

  // Build a FaultDetails payload from a predictive_faults entry (+ its
  // matching rul_predictions row for the threshold viz).
  const buildFaultFromPredictive = (
    pf: FaultsEnhanced['predictive_faults'][number],
    rul: FaultsEnhanced['rul_predictions'][number] | undefined,
  ): FaultDetails => {
    const sev: FaultDetails['severity'] =
      pf.urgency === 'critical' || pf.urgency === 'urgent'
        ? 'critical'
        : pf.urgency === 'soon'
          ? 'medium'
          : 'low';

    // We don't have a fully-realised per-layer chain in this payload, but we
    // can synthesise a minimal "winner" step so the cascade stepper renders.
    const layer_chain: CascadeLayer[] | undefined = pf.classification_layer
      ? [
          {
            layer: pf.classification_layer,
            confidence: pf.cascade_winning_confidence ?? rul?.confidence ?? 0,
            evidence: pf.evidence ?? pf.winner_reason ?? pf.recommended_action,
          },
        ]
      : undefined;

    return {
      fault_type: pf.fault_type,
      display_name: pf.display_name,
      classification_layer: pf.classification_layer ?? 'RULE',
      cascade_winning_confidence:
        pf.cascade_winning_confidence ?? rul?.confidence ?? 0,
      evidence:
        pf.evidence ?? pf.winner_reason ?? pf.recommended_action ?? '',
      layer_chain,
      current_value: rul?.current_value,
      threshold: rul?.threshold,
      unit: rul?.unit,
      trend: rul?.trend,
      asset_id: pf.equipment_id,
      severity: sev,
      eta_days: pf.days_to_fault,
    };
  };

  // Build a FaultDetails payload from a classifications row (predictive
  // panel). Confidence/eta/evidence come straight from the classifier.
  const buildFaultFromClassification = (
    row: PlantClassificationRow,
  ): FaultDetails => {
    const sev: FaultDetails['severity'] =
      row.tier === 'ACUTE'
        ? 'critical'
        : row.tier === 'DEGRADED'
          ? 'medium'
          : 'low';
    return {
      fault_type: row.ruleId || row.likelyCause,
      display_name: row.likelyCause.replace(/_/g, ' '),
      classification_layer: 'RULE',
      cascade_winning_confidence: row.confidence,
      evidence: row.evidence?.join(' · ') ?? '',
      layer_chain: [
        {
          layer: 'RULE',
          confidence: row.confidence,
          evidence: row.evidence?.[0] ?? row.likelyCause,
        },
      ],
      asset_id: row.inverterId,
      severity: sev,
      eta_days: row.etaDays ?? undefined,
    };
  };

  const handleAlarmClick = (
    alarm: import('@/components/ops/AlarmStack').AlarmRow,
  ) => {
    const raw = alarm.raw as PredictiveAlarm | undefined;
    if (!raw) return;
    const pf = data?.predictive_faults.find((f) => f.id === raw.id);
    if (!pf) return;
    const rul = data?.rul_predictions.find(
      (r) =>
        r.fault_type === pf.fault_type && r.inverter_id === pf.equipment_id,
    );
    setDrawerFault(buildFaultFromPredictive(pf, rul));
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    // On /dashboard the enhanced fault payload comes DB-first from the
    // synthesized `faults_enhanced` artifact via /api/faults; it may be absent
    // (real plant, model still maturing), in which case the page falls back to
    // the live plant-classifications panel below. Demo/showcase read the
    // richer fixture directly.
    const url =
      prefix === '/dashboard'
        ? `/api/faults?plantId=${encodeURIComponent(plantId)}&enhanced=1`
        : `${dataRoot}/faults/${plantId}/fault_detection_enhanced.json`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive) return;
        // API wraps as { enhanced }; the fixture is the enhanced object itself.
        const enhanced = j && typeof j === 'object' && 'enhanced' in j ? j.enhanced : j;
        setData(enhanced && enhanced.summary ? enhanced : null);
      })
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [plantId, dataRoot, prefix]);

  // Plant-wide maintenance classifications, backs the new Predictive panel.
  // 404, empty list, or network error all degrade silently to a clean empty
  // state (handled in render).
  useEffect(() => {
    let alive = true;
    setClassificationsLoaded(false);
    fetch(`/api/plants/${plantId}/classifications`)
      .then((r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<PlantClassificationsResponse>;
      })
      .then((j) => {
        if (!alive) return;
        setClassifications(j?.classifications ?? []);
      })
      .catch(() => {
        if (alive) setClassifications([]);
      })
      .finally(() => alive && setClassificationsLoaded(true));
    return () => {
      alive = false;
    };
  }, [plantId]);

  // A fault is "active" when the classifier flagged it as reactive OR when the
  // RUL forecast says the fault is already due (days_to_fault <= 0). Everything
  // else is forward-looking ("predictive"). Used by the lifecycle filter and
  // the meta count badge.
  const isActiveFault = (f: FaultsEnhanced['predictive_faults'][number]) =>
    f.is_reactive === true || (typeof f.days_to_fault === 'number' && f.days_to_fault <= 0);

  const alarms = useMemo(() => {
    if (!data?.predictive_faults) return [];
    const rulIndex = new Map<string, FaultsEnhanced['rul_predictions'][number]>();
    for (const r of data.rul_predictions ?? []) {
      rulIndex.set(`${r.fault_type}|${r.inverter_id}`, r);
    }
    return data.predictive_faults
      .filter((f) => !acked.has(f.id))
      .filter((f) => {
        if (assetFilter === 'all') return true;
        const isBess = !!(f.bess_source || (f.asset_type ?? '').startsWith('BESS'));
        return assetFilter === 'bess' ? isBess : !isBess;
      })
      .filter((f) => {
        if (lifecycleFilter === 'all') return true;
        const active = isActiveFault(f);
        return lifecycleFilter === 'active' ? active : !active;
      })
      .map((f) => {
        const rul = rulIndex.get(`${f.fault_type}|${f.equipment_id}`);
        const raw: PredictiveAlarm = {
          id: f.id,
          fault_type: f.fault_type,
          display_name: f.display_name,
          equipment_id: f.equipment_id,
          days_to_fault: f.days_to_fault,
          urgency: f.urgency,
          recommended_action: f.recommended_action,
          revenue_at_risk_eur: f.revenue_at_risk_eur,
          current_value: rul?.current_value,
          threshold: rul?.threshold,
          unit: rul?.unit,
          trend: rul?.trend,
          confidence: rul?.confidence,
          projected_energy_loss_kwh: rul?.projected_energy_loss_kwh,
          classification_layer: f.classification_layer,
          evidence: f.evidence,
          winner_reason: f.winner_reason,
        };
        return {
          id: f.id,
          asset: f.equipment_id,
          message: `${f.display_name} · ${f.recommended_action}`,
          age:
            f.days_to_fault < 0 ? `${Math.abs(f.days_to_fault)}d ago` : `in ${f.days_to_fault}d`,
          severity:
            f.urgency === 'critical' || f.urgency === 'urgent'
              ? 'critical'
              : f.urgency === 'soon'
                ? 'warning'
                : 'info',
          ackable: true,
          raw,
          classificationLayer: f.classification_layer,
          evidence: f.evidence,
          winnerReason: f.winner_reason,
          confidence: f.cascade_winning_confidence,
        };
      }) as import('@/components/ops/AlarmStack').AlarmRow[];
  }, [data, acked, assetFilter, lifecycleFilter]);

  const lifecycleCount = useMemo(() => {
    const rows = data?.predictive_faults ?? [];
    const active = rows.filter(isActiveFault).length;
    return { active, predictive: rows.length - active, total: rows.length };
  }, [data]);

  const pvBessCount = useMemo(() => {
    const rows = data?.predictive_faults ?? [];
    const bess = rows.filter((f) => f.bess_source || (f.asset_type ?? '').startsWith('BESS')).length;
    return { pv: rows.length - bess, bess, total: rows.length };
  }, [data]);

  const faultHistory = useMemo(() => {
    if (!data?.rul_predictions) return [];
    const groups = new Map<string, { code: string; description: string; count: number; minDays: number; loss: number }>();
    for (const p of data.rul_predictions) {
      const key = p.fault_type;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        existing.minDays = Math.min(existing.minDays, p.days_to_fault);
        existing.loss += p.projected_energy_loss_kwh / 1000;
      } else {
        groups.set(key, {
          code: key.toUpperCase().slice(0, 4),
          description: p.display_name,
          count: 1,
          minDays: p.days_to_fault,
          loss: p.projected_energy_loss_kwh / 1000,
        });
      }
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count);
  }, [data]);

  // Earliest predicted fault per asset (inverter or battery). For each
  // equipment_id, take the smallest days_to_fault from predictive_faults.
  // This replaces the previous per-fault-type RUL line chart, whose axis
  // labels were fault codes (soc_, cell, capa, cycl), confusing because
  // the panel claimed "per inverter" but mixed BESS and PV faults.
  const assetRul = useMemo(() => {
    if (!data?.predictive_faults?.length) return [];
    const byAsset = new Map<
      string,
      {
        asset: string;
        kind: 'PV' | 'BESS';
        days: number;
        urgency: string;
        topFault: string;
        topRecommended: string;
      }
    >();
    for (const f of data.predictive_faults) {
      if (typeof f.days_to_fault !== 'number') continue;
      const kind = f.bess_source || (f.asset_type ?? '').startsWith('BESS') ? 'BESS' : 'PV';
      const existing = byAsset.get(f.equipment_id);
      if (!existing || f.days_to_fault < existing.days) {
        byAsset.set(f.equipment_id, {
          asset: f.equipment_id,
          kind,
          days: f.days_to_fault,
          urgency: f.urgency,
          topFault: f.display_name,
          topRecommended: f.recommended_action,
        });
      }
    }
    return Array.from(byAsset.values()).sort((a, b) => a.days - b.days);
  }, [data]);

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center font-mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>
        loading fault telemetry…
      </div>
    );
  }

  // No enhanced fault telemetry yet (real plant / model maturing). Still show
  // the live plant classifications (DB-backed, from the digital twin) + the
  // fault drawer, rather than an empty box.
  if (!data) {
    const hasClass = classificationsLoaded && classifications && classifications.length > 0;
    return (
      <div className="space-y-3">
        {hasClass ? (
          <OpsPanel
            label="Fault classifications · per plant"
            subtitle="Plant classifications · ACUTE / DEGRADED / CHRONIC tiers"
            meta={<span style={{ color: 'var(--ops-muted)' }}>{classifications.length} classified · predictive queue maturing</span>}
            flush
          >
            <OpsTable
              columns={[
                { key: 'asset', label: 'ASSET', weight: 1.1, render: (r) => <span className="ops-num">{r.inverterId}</span> },
                { key: 'cause', label: 'FAULT TYPE', weight: 1.4, render: (r) => r.likelyCause.replace(/_/g, ' ') },
                {
                  key: 'tier', label: 'TIER', weight: 0.8,
                  render: (r) => (
                    <span className="font-mono text-[10.5px] uppercase tracking-wider"
                      style={{ color: r.tier === 'ACUTE' ? 'var(--ops-alarm)' : r.tier === 'DEGRADED' ? 'var(--ops-warn)' : r.tier === 'CHRONIC' ? 'var(--ops-info)' : 'var(--ops-muted)' }}>
                      {r.tier}
                    </span>
                  ),
                },
                { key: 'conf', label: 'CONF', weight: 0.7, numeric: true, unit: '%', render: (r) => Math.round((r.confidence ?? 0) * 100) },
                { key: 'rul', label: 'RUL', weight: 0.7, numeric: true, unit: 'd', render: (r) => (r.etaDays != null ? r.etaDays : '·') },
                { key: 'loss', label: 'LOSS', weight: 0.8, numeric: true, unit: 'kWh/d', render: (r) => (r.projectedEnergyLossKwhPerDay != null ? r.projectedEnergyLossKwhPerDay.toFixed(1) : '·') },
                { key: 'action', label: 'ACTION', weight: 1.1, render: (r) => <span className="font-mono text-[10.5px] uppercase tracking-wider" style={{ color: 'var(--ops-info)' }}>{r.recommendedAction}</span> },
              ]}
              rows={classifications}
              status={(r) => TIER_TONE[r.tier] ?? 'muted'}
              onRowClick={(r) => setDrawerFault(buildFaultFromClassification(r))}
            />
          </OpsPanel>
        ) : (
          <OpsPanel label="Predictive faults">
            <div className="flex h-32 items-center justify-center px-6 text-center font-mono text-[11px] italic" style={{ color: 'var(--ops-muted)' }}>
              Predictive fault model is still maturing for {plantId}. Classifications and RUL forecasts appear once the digital twin accrues enough history.
            </div>
          </OpsPanel>
        )}
        <FaultExplanationDrawer
          fault={drawerFault}
          plantId={plantId}
          open={!!drawerFault}
          onClose={() => setDrawerFault(null)}
        />
      </div>
    );
  }

  const s = data.summary;
  const total = s.predictive_count + s.reactive_count;

  return (
    <div className="space-y-3">
      <TelemetryStrip
        columns={6}
        cells={[
          { label: 'TOTAL', value: total.toString(), tone: total > 0 ? 'alarm' : 'ok', footer: 'reactive + predictive' },
          { label: 'CRITICAL', value: s.critical_count.toString(), tone: 'alarm', footer: 'requires action' },
          { label: 'URGENT', value: s.urgent_count.toString(), tone: 'warn', footer: '<7d window' },
          { label: 'SOON', value: s.soon_count.toString(), tone: 'warn', footer: '<30d window' },
          { label: 'PLANNED', value: s.planned_count.toString(), tone: 'info', footer: 'scheduled' },
          {
            label: 'HEALTH',
            value: data.health_score.value.toString(),
            unit: '/100',
            tone: data.health_score.value >= 80 ? 'ok' : data.health_score.value >= 60 ? 'warn' : 'alarm',
            footer: data.health_score.status,
          },
        ]}
      />

      <OpsPanel
        label={
          lifecycleFilter === 'active'
            ? 'Active faults'
            : lifecycleFilter === 'predictive'
              ? 'Predictive queue'
              : 'Active faults · predictive queue'
        }
        meta={
          <span className="inline-flex flex-wrap items-center gap-2.5">
            <span style={{ color: 'var(--ops-alarm)' }}>
              {s.critical_count} CRIT · {s.urgent_count} URG · {s.predictive_count} PRED
            </span>
            <span className="inline-flex rounded-sm border p-[2px] font-mono text-[10px]"
              style={{ borderColor: 'var(--ops-hair)', background: 'var(--ops-panel-2)' }}>
              {(['all', 'active', 'predictive'] as const).map((f) => {
                const isActive = lifecycleFilter === f;
                const n = f === 'all' ? lifecycleCount.total : f === 'active' ? lifecycleCount.active : lifecycleCount.predictive;
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setLifecycleFilter(f)}
                    className="rounded-sm px-1.5 py-[1px] tracking-wider uppercase transition-colors"
                    style={{
                      background: isActive ? 'var(--ops-nav-active-bg)' : 'transparent',
                      color: isActive ? 'var(--ops-info)' : 'var(--ops-muted)',
                      fontWeight: isActive ? 600 : 400,
                    }}
                  >
                    {f} {n}
                  </button>
                );
              })}
            </span>
            {pvBessCount.bess > 0 && (
              <span className="font-mono text-[10px]" style={{ color: 'var(--ops-muted)' }}>
                {pvBessCount.pv} PV · {pvBessCount.bess} BESS
              </span>
            )}
            {data.cascade_summary && (
              <span
                className="font-mono text-[10px]"
                style={{ color: 'var(--ops-muted)' }}
                title={`Cascade layer distribution, AI override rate: ${(data.cascade_summary.ai_override_rate * 100).toFixed(0)}%`}
              >
                {(['RULE', 'TWIN_RESIDUAL', 'ML_CLASSIFIER', 'AI_OVERRIDE'] as const)
                  .map((layer) => {
                    const n = data.cascade_summary!.layer_distribution[layer] ?? 0;
                    if (n === 0) return null;
                    const short = layer === 'TWIN_RESIDUAL' ? 'TWIN' : layer === 'ML_CLASSIFIER' ? 'ML' : layer === 'AI_OVERRIDE' ? 'AI' : 'RULE';
                    return `${n} ${short}`;
                  })
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            {pvBessCount.bess > 0 && (
              <span className="inline-flex rounded-sm border p-[2px] font-mono text-[10px]"
                style={{ borderColor: 'var(--ops-hair)', background: 'var(--ops-panel-2)' }}>
                {(['all', 'pv', 'bess'] as const).map((f) => {
                  const isActive = assetFilter === f;
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setAssetFilter(f)}
                      className="rounded-sm px-1.5 py-[1px] tracking-wider uppercase transition-colors"
                      style={{
                        background: isActive ? 'var(--ops-nav-active-bg)' : 'transparent',
                        color: isActive ? 'var(--ops-info)' : 'var(--ops-muted)',
                        fontWeight: isActive ? 600 : 400,
                      }}
                    >
                      {f}
                    </button>
                  );
                })}
              </span>
            )}
          </span>
        }
        flush
      >
        {alarms.length > 0 ? (
          <AlarmStack
            alarms={alarms}
            onAck={ackFault}
            onAlarmClick={handleAlarmClick}
          />
        ) : (
          <div
            className="flex h-24 items-center justify-center font-mono text-[11px] italic"
            style={{ color: 'var(--ops-muted)' }}
          >
            no active faults · health {data.health_score.value}/100 · {data.health_score.status}
          </div>
        )}
      </OpsPanel>

      <div className="ops-grid-2">
        <OpsPanel
          label="Fault history · by type"
          meta={<span>{faultHistory.length} distinct types · sort by count↓</span>}
          flush
        >
          {faultHistory.length > 0 ? (
            <OpsTable
              columns={[
                { key: 'code', label: 'CODE', render: (r) => <span className="ops-num">{r.code}</span>, weight: 0.7 },
                { key: 'desc', label: 'DESCRIPTION', render: (r) => r.description, weight: 1.8 },
                { key: 'count', label: 'COUNT', numeric: true, render: (r) => r.count },
                { key: 'days', label: 'MIN DAYS', numeric: true, render: (r) => r.minDays },
                { key: 'loss', label: 'LOSS MWh', numeric: true, render: (r) => r.loss.toFixed(2) },
              ]}
              rows={faultHistory}
              status={(r) => (r.minDays < 7 ? 'alarm' : r.minDays < 30 ? 'warn' : 'info')}
            />
          ) : (
            <div className="flex h-24 items-center justify-center font-mono text-[11px] italic" style={{ color: 'var(--ops-muted)' }}>
              no historical fault types
            </div>
          )}
        </OpsPanel>

        <OpsPanel
          label="Earliest predicted fault · per asset"
          meta={
            <span style={{ color: 'var(--ops-muted)' }}>
              {assetRul.length} {assetRul.length === 1 ? 'asset' : 'assets'} · sorted by urgency
            </span>
          }
        >
          {assetRul.length > 0 ? (
            <AssetRulBars rows={assetRul} />
          ) : (
            <div className="flex h-24 items-center justify-center font-mono text-[11px] italic" style={{ color: 'var(--ops-muted)' }}>
              no per-asset RUL predictions
            </div>
          )}
        </OpsPanel>
      </div>

      {/* Plant-wide maintenance classifications, only rendered when the route
          returns a non-empty list. The existing "Active faults · Predictive queue"
          panel above already shows the per-fault forward signals, so we skip
          this panel entirely when classifications are empty or the API is down,
          rather than render an empty duplicate. */}
      {classificationsLoaded && classifications && classifications.length > 0 && (
      <OpsPanel
        label="Fault classifications · per plant"
        subtitle="Plant classifications · ACUTE / DEGRADED / CHRONIC tiers"
        meta={
          <span style={{ color: 'var(--ops-muted)' }}>
            {classifications.length} classified · sort by action↑ ETA↑
          </span>
        }
        flush
      >
        {(
          <OpsTable
            columns={[
              {
                key: 'asset',
                label: 'ASSET',
                weight: 1.1,
                render: (r) => (
                  <span className="ops-num">{r.inverterId}</span>
                ),
              },
              {
                key: 'cause',
                label: 'FAULT TYPE',
                weight: 1.4,
                render: (r) => r.likelyCause.replace(/_/g, ' '),
              },
              {
                key: 'tier',
                label: 'TIER',
                weight: 0.8,
                render: (r) => (
                  <span
                    className="font-mono text-[10.5px] uppercase tracking-wider"
                    style={{
                      color:
                        r.tier === 'ACUTE'
                          ? 'var(--ops-alarm)'
                          : r.tier === 'DEGRADED'
                            ? 'var(--ops-warn)'
                            : r.tier === 'CHRONIC'
                              ? 'var(--ops-info)'
                              : 'var(--ops-muted)',
                    }}
                  >
                    {r.tier}
                  </span>
                ),
              },
              {
                key: 'conf',
                label: 'CONF',
                weight: 0.7,
                numeric: true,
                unit: '%',
                render: (r) => Math.round((r.confidence ?? 0) * 100),
              },
              {
                key: 'rul',
                label: 'RUL',
                weight: 0.7,
                numeric: true,
                unit: 'd',
                render: (r) => (r.etaDays != null ? r.etaDays : ','),
              },
              {
                key: 'loss',
                label: 'LOSS',
                weight: 0.8,
                numeric: true,
                unit: 'kWh/d',
                render: (r) =>
                  r.projectedEnergyLossKwhPerDay != null
                    ? r.projectedEnergyLossKwhPerDay.toFixed(1)
                    : ',',
              },
              {
                key: 'reason',
                label: 'LIKELY REASON',
                weight: 1.8,
                render: (r) => (
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: 'var(--ops-muted)' }}
                    title={r.evidence?.join(' · ')}
                  >
                    {truncate(r.evidence?.[0] ?? r.likelyCause, 60)}
                  </span>
                ),
              },
              {
                key: 'action',
                label: 'ACTION',
                weight: 1.1,
                render: (r) => (
                  <span
                    className="font-mono text-[10.5px] uppercase tracking-wider"
                    style={{ color: 'var(--ops-info)' }}
                  >
                    {r.recommendedAction}
                  </span>
                ),
              },
            ]}
            rows={classifications}
            status={(r) => TIER_TONE[r.tier] ?? 'muted'}
            onRowClick={(r) => setDrawerFault(buildFaultFromClassification(r))}
          />
        )}
      </OpsPanel>
      )}

      <OpsFooter
        pulseLabel={total === 0 ? 'FAULT QUEUE CLEAN' : 'FAULT QUEUE ACTIVE'}
        pulseTone={total === 0 ? 'ok' : 'warn'}
        metrics={[
          { label: 'OPEN', value: alarms.length },
          { label: 'ACK 24h', value: acked.size },
          {
            label: 'NEXT 7d',
            value: (() => {
              const next = data.maintenance_schedule?.next_7_days;
              if (next == null) return ',';
              if (typeof next === 'number') return next;
              // Sum tasks across all days for a true "upcoming maintenance count".
              return next.reduce(
                (sum, day) => sum + (Array.isArray(day.tasks) ? day.tasks.length : 0),
                0
              );
            })(),
          },
          {
            label: 'REPAIR €',
            value: data.maintenance_schedule
              ? `€${Math.round(data.maintenance_schedule.total_repair_cost_eur).toLocaleString()}`
              : ',',
          },
          { label: 'GEN', value: new Date(data.generated_at).toLocaleDateString() },
        ]}
        buildTag="real fixture"
      />

      <FaultExplanationDrawer
        fault={drawerFault}
        plantId={plantId}
        open={!!drawerFault}
        onClose={() => setDrawerFault(null)}
      />
    </div>
  );
}
