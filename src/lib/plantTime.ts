/**
 * Plant-local time formatting for chart axes, tooltips and panel stamps.
 *
 * Timestamps in the analytics store are true UTC. Charts must render them in
 * ONE declared zone — the plant's — instead of silently using the viewer's
 * browser zone (a Madrid plant's solar-noon peak used to render at 14:00 for
 * a CEST viewer with no hint of what clock the axis was on). Panels that
 * adopt this should name the zone in their meta (see plantTzLabel).
 */

export type PlantTimeStyle = 'axis-hour' | 'axis-day' | 'tooltip' | 'stamp';

const STYLE_OPTIONS: Record<PlantTimeStyle, Intl.DateTimeFormatOptions> = {
  // "14:00" — hourly x-axis ticks
  'axis-hour': { hour: '2-digit', minute: '2-digit', hour12: false },
  // "Jul 19" — daily x-axis ticks
  'axis-day': { month: 'short', day: 'numeric' },
  // "Jul 19, 14:00" — hover tooltips
  tooltip: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false },
  // "2026-07-19 14:00" — sortable stamps in tables/meta
  stamp: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false },
};

function isValidTz(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize the analytics store's timestamp strings to an explicit-UTC form.
 * Rows often arrive as "2026-07-19 14:00:00" (no offset) — JS parses that as
 * BROWSER-local, silently shifting the whole series. Treat offset-less
 * strings as the UTC they are.
 */
export function toUtcDate(iso: string | Date): Date {
  if (iso instanceof Date) return iso;
  let s = iso.trim().replace(' ', 'T');
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
  if (!hasOffset && s.includes('T')) s = `${s}Z`;
  return new Date(s);
}

/**
 * Format a UTC timestamp in the plant's zone. Falls back to UTC (not the
 * browser zone) when no valid plant zone is known — a deterministic axis
 * beats one that changes per viewer.
 */
export function formatPlantTime(
  iso: string | Date,
  tz: string | null | undefined,
  style: PlantTimeStyle,
): string {
  const date = toUtcDate(iso);
  if (Number.isNaN(date.getTime())) return typeof iso === 'string' ? iso : '';
  const timeZone = isValidTz(tz) ? tz : 'UTC';
  // en-CA renders stamps ISO-ordered (2026-07-19); en-US for the short styles.
  const locale = style === 'stamp' ? 'en-CA' : 'en-US';
  return new Intl.DateTimeFormat(locale, { ...STYLE_OPTIONS[style], timeZone })
    .format(date)
    .replace(', ', ' ');
}

/** "times in Europe/Madrid" (or "times in UTC") for panel meta. */
export function plantTzLabel(tz: string | null | undefined): string {
  return `times in ${isValidTz(tz) ? tz : 'UTC'}`;
}
