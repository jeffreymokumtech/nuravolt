/**
 * Audit provenance banner.
 *
 * A mixed asset ran on the modelled twin until its BMS was connected and on
 * measured telemetry after. Blanket labelling the whole bundle provisional
 * throws away evidence the operator actually owns, so the banner has to
 * describe the cutover. It also must not claim a cutover it has no date for.
 *
 * Run: npx vitest run --config tests/ui/vitest.config.ts
 */

import { describe, expect, it } from 'vitest';
import {
  firstMeasuredDate,
  regimeNotice,
} from '@/components/audit/AuditProvenanceBanner';

describe('firstMeasuredDate', () => {
  it('accepts either spelling and trims a timestamp to its date', () => {
    expect(firstMeasuredDate({ first_measured_date: '2026-03-01' })).toBe('2026-03-01');
    expect(firstMeasuredDate({ firstMeasuredDate: '2026-03-01T00:00:00Z' })).toBe('2026-03-01');
  });

  it('rejects anything that is not a date', () => {
    expect(firstMeasuredDate({ first_measured_date: '' })).toBeNull();
    expect(firstMeasuredDate({ first_measured_date: 'soon' })).toBeNull();
    expect(firstMeasuredDate(null)).toBeNull();
  });
});

describe('regimeNotice', () => {
  it('describes a mixed asset as measured from a date, modelled before it', () => {
    const notice = regimeNotice(
      { provisional: true },
      { mode: 'mixed', first_measured_date: '2026-03-01', source: 'huawei_cloud' },
    );
    expect(notice?.tone).toBe('info');
    expect(notice?.text).toContain('Measured telemetry from huawei_cloud from 2026-03-01');
    expect(notice?.text).toContain('modelled dispatch twin');
  });

  it('will not call an asset mixed without the cutover date, and stays conservative', () => {
    const notice = regimeNotice({ provisional: true }, { mode: 'mixed', first_measured_date: null });
    expect(notice?.tone).toBe('warn');
    expect(notice?.text).toContain('no BMS telemetry connected');
  });

  it('keeps the provisional wording for a modelled asset', () => {
    expect(regimeNotice({ provisional: true }, null)?.tone).toBe('warn');
    expect(regimeNotice(null, { mode: 'modelled' })?.text).toContain('modelled twin');
  });

  it('reads the regime off the provenance block when no prop is passed', () => {
    const notice = regimeNotice({
      provisional: true,
      telemetry: { mode: 'measured', source: 'sungrow_cloud' },
    } as any);
    expect(notice?.tone).toBe('info');
    expect(notice?.text).toContain('measured telemetry from sungrow_cloud');
  });

  it('renders nothing when there is nothing to disclose', () => {
    expect(regimeNotice({ provisional: false }, null)).toBeNull();
    expect(regimeNotice(null, null)).toBeNull();
    expect(regimeNotice(null, { mode: 'measured' })?.tone).toBe('info');
  });
});
