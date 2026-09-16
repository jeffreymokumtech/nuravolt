import { bessMetrics } from '@/data/content/bessMetrics';
import { pvMetrics } from '@/data/content/pvMetrics';
import { faults } from '@/data/content/faults';
import { integrations } from '@/data/content/integrations';
import { insights } from '@/data/content/insights';
import { reports } from '@/data/content/reports';
import { comparisons } from '@/data/content/comparisons';
import { regions } from '@/data/content/regions';
import { SITE_URL } from '@/libs/seo';

export const dynamic = 'force-static';

/**
 * /llms.txt, the emerging convention (llmstxt.org) that gives AI crawlers a
 * curated, link-rich map of the site's substantive pages. Built from the
 * content catalog so it stays in sync as pages are added.
 */
export function GET() {
  const line = (title: string, path: string, desc: string) =>
    `- [${title}](${SITE_URL}${path}): ${desc}`;

  const body = [
    '# NuraVolt',
    '',
    '> Physics-informed AI monitoring for solar, wind, and battery storage. NuraVolt turns SCADA and BMS data into early fault detection, degradation-aware BESS analytics, and audit-ready reporting for solar and storage asset operators.',
    '',
    '## Products',
    line(
      'NuraVolt Audit',
      '/solutions/audit',
      'One-off, fixed-scope BESS audits on a single telemetry export: optimizer performance vs a perfect-foresight benchmark, warranty and degradation dossiers, and grid code compliance evidence packs.'
    ),
    line(
      'BESS Monitoring',
      '/solutions/bess-monitoring',
      'Continuous BESS analytics: SoH estimation, thermal runaway prediction, dispatch optimization, and warranty tracking on live SCADA and BMS data.'
    ),
    line(
      'NuraVolt MCP Server',
      '/mcp',
      'A Model Context Protocol server that connects plant telemetry, soiling forecasts, fault detections, and tickets to AI assistants like Claude, so operators can query and act on their fleet in natural language.'
    ),
    '',
    '## Data reports', ...reports.map((r) => line(r.title, `/reports/${r.slug}`, r.intro)),
    '',
    '## Comparisons', ...comparisons.map((c) => line(c.title, `/compare/${c.slug}`, c.intro)),
    '',
    '## Country guides', ...regions.map((r) => line(r.title, `/solar-monitoring/${r.slug}`, r.intro)),
    '',
    '## BESS metrics', ...bessMetrics.map((m) => line(m.title, `/bess/${m.slug}`, m.intro)),
    '',
    '## PV metrics', ...pvMetrics.map((m) => line(m.title, `/pv-metrics/${m.slug}`, m.intro)),
    '',
    '## PV & BESS faults', ...faults.map((f) => line(f.title, `/faults/${f.slug}`, f.intro)),
    '',
    '## Integrations', ...integrations.map((i) => line(i.title, `/integrations/${i.slug}`, i.intro)),
    '',
    '## Insights', ...insights.map((i) => line(i.title, `/insights/${i.slug}`, i.intro)),
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
