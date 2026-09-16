/**
 * A battery's commissioning date must agree with the history it carries, and
 * an asset with no BMS must not present a state of charge.
 *
 * The regression: scripts/add_bess_to_plant.ts stamped `new Date()` into
 * BessAsset.installation_date whenever the plant had no commissioning date, so
 * the local ribera battery said it was installed today while carrying 396 days
 * of dispatch behind it. The console then drew "Calendar age 1.1 / 10 yr" from
 * the warranty tracker's own clock beside a commissioning date of today, and
 * the SoC tile read "50%" under the caption "state of charge" for an asset
 * that has no BMS at all.
 *
 * The pure cases below pin the resolution rules. The HTTP cases check the
 * serving contract and need a live server (npm run test:api); they skip
 * themselves when no publicly readable BESS plant answers.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DECLARED_INSTALLATION_SOURCES,
  INSTALLATION_SOURCE_LABEL,
  resolveInstallationDate,
} from '../../scripts/add_bess_to_plant';

const BASE = (process.env.QA_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const TODAY = day('2026-08-04');
const HISTORY_START = day('2025-07-05'); // the ribera modelled window

// ── Resolution rules ───────────────────────────────────────────────────────

describe('resolveInstallationDate', () => {
  it('replaces a date that postdates the asset own history', () => {
    // The exact ribera row: installed today, a year of dispatch on file.
    const r = resolveInstallationDate({
      existing: TODAY,
      historyStart: HISTORY_START,
    });
    expect(iso(r.date)).toBe('2025-07-05');
    expect(r.source).toBe('modelled_window_start');
  });

  it('prefers the plant commissioning date over the history start', () => {
    // The plant header already shows this date, so the asset takes the same
    // one rather than putting a second commissioning date on the screen.
    const r = resolveInstallationDate({
      existing: TODAY,
      plantCommissioning: day('2023-11-15'),
      historyStart: HISTORY_START,
    });
    expect(iso(r.date)).toBe('2023-11-15');
    expect(r.source).toBe('plant_commissioning');
  });

  it('lets an operator declaration win over everything', () => {
    const r = resolveInstallationDate({
      declared: day('2024-02-01'),
      existing: day('2020-01-01'),
      existingSource: 'contract',
      plantCommissioning: day('2023-11-15'),
      historyStart: HISTORY_START,
    });
    expect(iso(r.date)).toBe('2024-02-01');
    expect(r.source).toBe('operator_declared');
  });

  it.each(DECLARED_INSTALLATION_SOURCES)('never re-derives over a %s date', (source) => {
    const r = resolveInstallationDate({
      existing: TODAY,
      existingSource: source,
      plantCommissioning: day('2023-11-15'),
      historyStart: HISTORY_START,
    });
    expect(iso(r.date)).toBe('2026-08-04');
    expect(r.source).toBe(source);
  });

  it('keeps an unattributed date that is possible', () => {
    // scripts/seed_standalone_bess.ts leaves dates with no recorded source.
    const r = resolveInstallationDate({
      existing: day('2024-06-15'),
      plantCommissioning: day('2023-01-01'),
      historyStart: HISTORY_START,
    });
    expect(iso(r.date)).toBe('2024-06-15');
    expect(r.source).toBe('existing_unattributed');
  });

  it('leaves the column empty rather than inventing a date', () => {
    const r = resolveInstallationDate({});
    expect(r.date).toBeNull();
    expect(r.source).toBeNull();
  });

  it('converges on a re-run, keeping both the date and its caption', () => {
    const first = resolveInstallationDate({ existing: TODAY, historyStart: HISTORY_START });
    expect(first.source).toBe('modelled_window_start');
    const second = resolveInstallationDate({
      existing: first.date,
      existingSource: first.source,
      historyStart: HISTORY_START,
    });
    // Relabelling this as somebody else's claim would drop the "not a
    // commissioning record" caption off a date this script inferred.
    expect(iso(second.date)).toBe(iso(first.date));
    expect(second.source).toBe('modelled_window_start');
  });

  it('does not trust a source string it does not recognise', () => {
    const r = resolveInstallationDate({
      existing: day('2024-06-15'),
      existingSource: 'vibes',
      historyStart: HISTORY_START,
    });
    expect(r.source).toBe('existing_unattributed');
  });

  it('labels every source it can return, in house copy style', () => {
    for (const [source, label] of Object.entries(INSTALLATION_SOURCE_LABEL)) {
      expect(label.length, source).toBeGreaterThan(0);
      expect(label, source).not.toMatch(/[—–]| - /);
    }
  });
});

// ── The script itself ──────────────────────────────────────────────────────

describe('scripts/add_bess_to_plant.ts', () => {
  const src = readFileSync(
    path.join(process.cwd(), 'scripts', 'add_bess_to_plant.ts'),
    'utf-8'
  );

  it('never stamps the clock into installation_date', () => {
    // `new Date()` on that column is how the contradiction was born: it is the
    // day the row was typed, not the day the battery was installed.
    const assignment = /installation_date:\s*([^,\n]+)/.exec(src);
    expect(assignment, 'installation_date is no longer assigned').not.toBeNull();
    expect(assignment![1]).not.toContain('new Date()');
    expect(assignment![1]).toContain('install.date');
  });

  it('mirrors the source vocabulary the Python writer stamps', () => {
    // Both writers stamp metadata.installation_date_source and each has to
    // recognise the other's work, so the strings cannot drift.
    const py = readFileSync(
      path.join(process.cwd(), 'nuravolt', 'pipeline', 'bess_intelligence.py'),
      'utf-8'
    );
    expect(py).toContain('INSTALLATION_DATE_SOURCE_KEY = "installation_date_source"');
    for (const source of [
      ...DECLARED_INSTALLATION_SOURCES,
      'existing_unattributed',
      'plant_commissioning',
      'modelled_window_start',
    ]) {
      expect(py, `Python does not know the source "${source}"`).toContain(`"${source}"`);
    }
  });
});

// ── The serving contract ───────────────────────────────────────────────────

const CANDIDATES = [process.env.QA_BESS_PLANT, 'ribera', 'region_a-storage', 'athi-storage'].filter(
  (s): s is string => Boolean(s)
);

let assetRow: any = null;
let overview: any = null;
let warranty: any = null;
let probedSlug = '';

beforeAll(async () => {
  for (const slug of CANDIDATES) {
    try {
      const listRes = await fetch(`${BASE}/api/bess/plants/${slug}`);
      if (listRes.status !== 200) continue;
      const list = await listRes.json();
      const first = list?.assets?.[0];
      if (!first?.id) continue;
      const [detailRes, warrantyRes] = await Promise.all([
        fetch(`${BASE}/api/bess/plants/${slug}/assets/${first.id}`),
        fetch(`${BASE}/api/bess/plants/${slug}/assets/${first.id}/warranty`),
      ]);
      if (detailRes.status !== 200) continue;
      const detail = await detailRes.json();
      if (detail?._source !== 'database') continue;
      assetRow = first;
      overview = detail;
      warranty = warrantyRes.status === 200 ? await warrantyRes.json() : null;
      probedSlug = slug;
      break;
    } catch {
      /* server down; the cases below skip themselves */
    }
  }
  if (!assetRow) {
    console.warn(
      `[bess-installation-date] no database-backed BESS plant answered on ${BASE} (tried ${CANDIDATES.join(', ')}); HTTP assertions skipped`
    );
  }
});

/** The modelled twin owns the present when its dispatch runs up to today. */
function twinOwnsToday(): boolean {
  const last = overview?.dispatchSchedule?.scheduleDate;
  if (!last) return false;
  const ageDays = (Date.now() - Date.parse(`${String(last).slice(0, 10)}T00:00:00Z`)) / 86_400_000;
  return ageDays <= 2;
}

describe('GET /api/bess/plants/:plant', () => {
  it('does not commission a battery after it started operating', () => {
    if (!assetRow) return;
    const installed = assetRow.installationDate
      ? String(assetRow.installationDate).slice(0, 10)
      : null;
    const earliest = overview?.cyclingMetrics?.period?.start ?? null;
    if (!installed || !earliest) return; // absent is allowed, contradictory is not
    expect(
      installed <= String(earliest).slice(0, 10),
      `${probedSlug} claims installation ${installed} but has cycling history from ${earliest}`
    ).toBe(true);
  });

  it('does not present a state of charge for an asset with no BMS', () => {
    if (!assetRow || !twinOwnsToday()) return;
    // Dispatch schedules are written only by the modelled twin, and it writes
    // up to today only when no measured telemetry has taken over. So this
    // asset has no BMS, and the console captions the field "state of charge"
    // with no timestamp next to it.
    expect(
      assetRow.currentSoc,
      `${probedSlug} serves a state of charge with no BMS behind it`
    ).toBeNull();
  });

  it('keeps state of health, which is derived and labelled, not blank', () => {
    if (!assetRow || !twinOwnsToday()) return;
    // The counter-check: clearing SoC must not be read as "empty the KPI row".
    // SoH comes from the chemistry degradation model over real cycling, and
    // that is the pattern a derived field should follow.
    expect(assetRow.currentSoh).not.toBeNull();
  });

  it('agrees with the warranty tracker about the calendar age', () => {
    if (!assetRow || !warranty?.status) return;
    const installed = assetRow.installationDate
      ? Date.parse(`${String(assetRow.installationDate).slice(0, 10)}T00:00:00Z`)
      : null;
    const years = warranty.status.yearsRemaining;
    const warrantyYears = warranty.terms?.warrantyYears;
    if (installed == null || years == null || !warrantyYears) return;
    // The tracker bar renders warrantyYears - yearsRemaining, and the panel
    // header renders the commissioning date, side by side on one screen. They
    // have to describe the same battery.
    const ageFromBar = warrantyYears - years;
    const ageFromRow = (Date.now() - installed) / (365.25 * 24 * 3600 * 1000);
    expect(
      Math.abs(ageFromBar - ageFromRow),
      `calendar age reads ${ageFromBar.toFixed(2)} yr, commissioning date implies ${ageFromRow.toFixed(2)} yr`
    ).toBeLessThan(0.15);
  });
});
