'use client';

import OpsShell from '@/components/ops/OpsShell';
import OpsPanel from '@/components/ops/OpsPanel';
import TelemetryStrip from '@/components/ops/TelemetryStrip';
import AlarmStack from '@/components/ops/AlarmStack';
import OpsTable from '@/components/ops/OpsTable';
import OpsFooter from '@/components/ops/OpsFooter';
import LiveBadge from '@/components/ops/LiveBadge';
import StatusLed from '@/components/ops/StatusLed';
import OpsLineChart from '@/components/ops/charts/OpsLineChart';
import SrForecastChart from '@/components/ops/charts/SrForecastChart';
import SoHProjectionChart from '@/components/ops/charts/SoHProjectionChart';
import ZoneHeatmap, { HeatLegend } from '@/components/ops/charts/ZoneHeatmap';
import ThermalMap from '@/components/ops/charts/ThermalMap';
import RainflowHistogram from '@/components/ops/charts/RainflowHistogram';
import WarrantyTracker from '@/components/ops/charts/WarrantyTracker';
import DispatchBars from '@/components/ops/charts/DispatchBars';

/**
 * Storybook-equivalent, renders every Phase 0 primitive with sample data.
 * Use it for Phase 0 verification (theme toggle in command bar) and as a
 * visual regression baseline for later phases.
 */
export default function OpsPreviewPage() {
  const tw7 = [0.92, 0.93, 0.91, 0.94, 0.93, 0.95, 0.94];
  const dt7 = [32.1, 31.8, 31.0, 30.4, 29.7, 28.6, 28.0];

  // Sample SR forecast, 30 days of slow decline + cleaning marker at day 21
  const srPoints = Array.from({ length: 30 }, (_, i) => {
    const sr = 0.965 - 0.006 * i + Math.sin(i / 4) * 0.005;
    return {
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      predicted: sr,
      lower: sr - 0.012 - i * 0.0008,
      upper: sr + 0.012 + i * 0.0008,
    };
  });

  // Sample SoH projection
  const sohPoints: Array<{ year: number; soh: number; measured: boolean }> = [];
  for (let y = 2024; y <= 2034; y += 0.5) {
    sohPoints.push({
      year: y,
      soh: 1.0 - (y - 2024) * 0.018,
      measured: y <= 2026,
    });
  }

  // Sample zone heatmap (24 cells), deterministic so SSR matches CSR (hash by index)
  const heatCells = Array.from({ length: 24 }, (_, i) => ({
    id: `Z${i + 1}`,
    value: 86 + ((i * 7 + 3) % 13),
    sublabel: `Z${String(i + 1).padStart(2, '0')}`,
  }));

  // Sample thermal grid (24 cells, 27-32°C), deterministic
  const thermalCells = Array.from({ length: 24 }, (_, i) => ({
    id: `M${i + 1}`,
    value: 27.5 + ((i * 11 + 5) % 45) / 10,
    sublabel: `M${String(i + 1).padStart(2, '0')}`,
  }));

  return (
    <OpsShell
      plantId="preview"
      activeNavKey="overview"
      commandBar={{
        section: 'PREVIEW',
        sectionTone: 'info',
        plantLabel: 'RIBERA',
        assetChip: 'PV + BESS',
        conn: 'ok',
        pollSeconds: 2,
        userInitials: 'AM',
      }}
    >
      <div className="space-y-3">
        <h1
          className="font-mono text-[12px] uppercase tracking-[0.14em]"
          style={{ color: 'var(--ops-label)' }}
        >
          OPS_PREVIEW · primitives + charts
        </h1>

        {/* Telemetry strip */}
        <TelemetryStrip
          cells={[
            { label: 'AC POWER', value: '4.12', unit: 'MW', tone: 'neutral', sparkline: tw7, sparklineTone: 'ok' },
            { label: 'DC POWER', value: '4.31', unit: 'MW', tone: 'neutral', sparkline: tw7, sparklineTone: 'ok' },
            { label: 'PERF RATIO', value: '86.1', unit: '%', tone: 'ok', sparkline: tw7 },
            { label: 'IRRADIANCE', value: '612', unit: 'W/m²', tone: 'neutral', sparkline: tw7 },
            { label: 'MOD TEMP', value: '41.2', unit: '°C', tone: 'warn', sparkline: dt7, sparklineTone: 'warn' },
            { label: 'GRID FREQ', value: '50.01', unit: 'Hz', tone: 'neutral' },
            { label: 'EXPORT', value: '2.50', unit: 'MW', tone: 'neutral' },
            { label: 'BESS SoC', value: '72.0', unit: '%', tone: 'bess' },
          ]}
        />

        <div className="grid gap-3" style={{ gridTemplateColumns: '1.55fr 1fr' }}>
          {/* OpsLineChart */}
          <OpsPanel
            label="DIGITAL_TWIN.expected_vs_actual"
            meta={
              <span className="flex items-center gap-3">
                <LiveBadge />
                <span>EXP <span style={{ color: 'var(--ops-txt)' }}>32.5</span>GWh</span>
                <span>ACT <span style={{ color: 'var(--ops-ok)' }}>28.0</span>GWh</span>
                <span>Δ <span style={{ color: 'var(--ops-alarm)' }}>−13.9%</span></span>
              </span>
            }
          >
            <OpsLineChart
              series={[
                { key: 'expected', label: 'Expected', tone: 'muted', dashed: true, values: [32, 32.2, 32, 32.4, 32.6, 32.5, 32.7, 32.3, 32.2, 32.1, 32.0, 31.9] },
                { key: 'actual', label: 'Actual', tone: 'ok', values: [32, 31.8, 30.5, 28.8, 27.2, 27.5, 26.8, 27.4, 28.0, 28.5, 28.4, 28.0] },
              ]}
              xLabels={['Dec 04', 'Dec 11', 'Dec 18', 'Dec 25', 'Jan 01']}
              yLabels={['33', '30', '27', '25']}
              annotations={[{ index: 7, label: 'soiling onset · Dec 14', tone: 'info' }]}
            />
          </OpsPanel>

          {/* Alarm stack */}
          <OpsPanel
            label="ACTIVE_ALARMS"
            meta={<span style={{ color: 'var(--ops-alarm)' }}>5 CRIT · 9 WARN</span>}
            flush
          >
            <AlarmStack
              alarms={[
                { id: '1', asset: 'INV-3-014', message: 'DC current imbalance', age: '6d 04h', severity: 'critical', ackable: true },
                { id: '2', asset: 'INV-3-022', message: 'Sustained underperformance', age: '3d 11h', severity: 'critical', ackable: true },
                { id: '3', asset: 'INV-3-007', message: 'String CV deviation', age: '2d 02h', severity: 'critical', ackable: true },
                { id: '4', asset: 'PV-02', message: 'Soiling threshold exceeded', age: '9d', severity: 'warning', ackable: true },
                { id: '5', asset: 'INV-1-019', message: 'Comms intermittent', age: '14h', severity: 'warning', ackable: true },
                { id: '6', asset: 'MET-02', message: 'Pyranometer drift', age: '1d 06h', severity: 'warning', ackable: true },
              ]}
            />
          </OpsPanel>
        </div>

        {/* SR forecast + SoH projection */}
        <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <OpsPanel
            label="SOILING_RATIO.forecast · 30-day"
            meta={<span style={{ color: 'var(--ops-info)' }}>95% CI · transfer-learning</span>}
          >
            <SrForecastChart
              points={srPoints}
              cleaningWindowIndex={21}
              cleaningWindowLabel="clean rec · Jun 22"
              yRange={[0.88, 0.99]}
            />
          </OpsPanel>
          <OpsPanel
            label="SoH_DEGRADATION.projection · 10yr horizon"
            meta={<span style={{ color: 'var(--ops-bess)' }}>model: semi-empirical fade</span>}
          >
            <SoHProjectionChart points={sohPoints} warrantyFloor={0.8} eolYear={2033} />
          </OpsPanel>
        </div>

        {/* Warranty tracker + rainflow */}
        <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <OpsPanel
            label="WARRANTY_TRACKER"
            meta={
              <span
                className="rounded-sm border px-1.5 py-px"
                style={{
                  color: 'var(--ops-ok)',
                  background: 'var(--ops-ok-bg)',
                  borderColor: 'var(--ops-ok-border)',
                }}
              >
                ON TRACK
              </span>
            }
          >
            <WarrantyTracker
              rows={[
                { label: 'Capacity guarantee', value: '94.1% / 70% @10yr', fraction: 0.88, tone: 'ok' },
                { label: 'Cycle budget (FEC)', value: '1,240 / 6,000', fraction: 0.21, tone: 'bess' },
                { label: 'Throughput limit', value: '9.8 / 24 GWh', fraction: 0.41, tone: 'bess' },
                { label: 'Calendar age', value: '2.2 / 10 yr', fraction: 0.22, tone: 'warn' },
              ]}
              projectedBreach={
                <>
                  <span>Projected floor breach</span>
                  <span style={{ color: 'var(--ops-txt)', fontWeight: 600 }}>2033 · within warranty ✓</span>
                </>
              }
            />
          </OpsPanel>
          <OpsPanel
            label="CYCLE_DEPTH.rainflow"
            meta={<span>avg DoD 61%</span>}
          >
            <RainflowHistogram
              bars={[
                { label: '8%', count: 14 },
                { label: '14%', count: 22 },
                { label: '22%', count: 34 },
                { label: '34%', count: 45 },
                { label: '45%', count: 78 },
                { label: '61%', count: 124 },
                { label: '78%', count: 96 },
                { label: '88%', count: 52 },
                { label: '100%', count: 22 },
              ]}
            />
          </OpsPanel>
        </div>

        {/* Heatmaps */}
        <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <OpsPanel
            label="ZONE_SOILING.map"
            meta={<HeatLegend min={86} max={98} unit="%" />}
          >
            <ZoneHeatmap
              cells={heatCells}
              columns={8}
              valueMin={86}
              valueMax={98}
              formatValue={(v) => `${v}`}
              unit="%"
            />
          </OpsPanel>
          <OpsPanel
            label="MODULE_THERMAL.map · °C"
            meta={<HeatLegend min={27} max={32} unit="°" />}
          >
            <ThermalMap cells={thermalCells} columns={8} />
          </OpsPanel>
        </div>

        {/* Dispatch + ops table */}
        <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <OpsPanel
            label="BESS.live · 3.2 MWh NMC"
            meta={<LiveBadge label="CHARGING" tone="info" />}
          >
            <DispatchBars
              bars={[
                { hour: '01', magnitude: 0.18, direction: 'idle' },
                { hour: '03', magnitude: 0.38, direction: 'charge' },
                { hour: '05', magnitude: 0.52, direction: 'charge' },
                { hour: '07', magnitude: 0.7, direction: 'charge' },
                { hour: '09', magnitude: 0.84, direction: 'charge' },
                { hour: '11', magnitude: 0.46, direction: 'charge' },
                { hour: '13', magnitude: 0.28, direction: 'idle' },
                { hour: '15', magnitude: 0.55, direction: 'discharge' },
                { hour: '17', magnitude: 0.78, direction: 'discharge' },
                { hour: '19', magnitude: 1.0, direction: 'discharge' },
                { hour: '21', magnitude: 0.88, direction: 'discharge' },
                { hour: '23', magnitude: 0.6, direction: 'discharge' },
              ]}
            />
          </OpsPanel>
          <OpsPanel
            label="INVERTER_GROUPS.telemetry · 120 units · 4 groups"
            meta={<span>updated 2s ago · sort PR↑</span>}
            flush
          >
            <OpsTable
              columns={[
                { key: 'group', label: 'GROUP', render: (r) => r.group, weight: 0.7 },
                { key: 'unit', label: 'UNIT', render: (r) => <span className="ops-num">{r.unit}</span> },
                { key: 'ac', label: 'AC kW', numeric: true, render: (r) => r.ac },
                { key: 'dc', label: 'DC kW', numeric: true, render: (r) => r.dc },
                { key: 'pr', label: 'PR%', numeric: true, render: (r) => r.pr },
                { key: 'vdc', label: 'Vdc', numeric: true, render: (r) => r.vdc },
                { key: 'tmod', label: 'Tmod', numeric: true, render: (r) => `${r.tmod}°` },
              ]}
              rows={[
                { group: 'G-1', unit: 'INV-1-001', ac: 42.1, dc: 44.0, pr: 89.2, vdc: 712, tmod: 38.4, status: 'ok' as const },
                { group: 'G-1', unit: 'INV-1-002', ac: 41.6, dc: 43.5, pr: 88.7, vdc: 709, tmod: 39.1, status: 'ok' as const },
                { group: 'G-2', unit: 'INV-2-001', ac: 39.4, dc: 43.0, pr: 84.2, vdc: 696, tmod: 41.8, status: 'warn' as const },
                { group: 'G-3', unit: 'INV-3-007', ac: 12.8, dc: 36.5, pr: 38.4, vdc: 643, tmod: 47.2, status: 'alarm' as const },
                { group: 'G-3', unit: 'INV-3-014', ac: 18.6, dc: 38.9, pr: 49.1, vdc: 651, tmod: 49.7, status: 'alarm' as const },
              ]}
              status={(r) => r.status}
              groupBy={(r) => r.group}
            />
          </OpsPanel>
        </div>

        <OpsFooter
          pulseLabel="SCADA NOMINAL"
          metrics={[
            { label: 'AVAIL', value: '99.4', unit: '%' },
            { label: 'MTBF', value: '128', unit: 'd' },
            { label: 'MTTR', value: '4.2', unit: 'h' },
            { label: 'CO₂', value: '−14.6', unit: 't' },
            { label: 'PEER', value: '78', unit: '%ile' },
            { label: 'SYNC', value: '2s ago', valueColor: 'var(--ops-txt)' },
          ]}
          buildTag="v2.4.1"
        />

        {/* Tone reference */}
        <OpsPanel label="Tone reference">
          <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]" style={{ color: 'var(--ops-muted)' }}>
            <span className="inline-flex items-center gap-1.5"><StatusLed tone="ok" /> ok</span>
            <span className="inline-flex items-center gap-1.5"><StatusLed tone="warn" /> warn</span>
            <span className="inline-flex items-center gap-1.5"><StatusLed tone="alarm" pulse /> alarm (pulse)</span>
            <span className="inline-flex items-center gap-1.5"><StatusLed tone="info" /> info</span>
            <span className="inline-flex items-center gap-1.5"><StatusLed tone="bess" /> bess</span>
          </div>
        </OpsPanel>
      </div>
    </OpsShell>
  );
}
