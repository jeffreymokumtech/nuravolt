import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'NuraVolt Audit | BESS Optimizer, Warranty and Compliance Audits',
  description:
    'One-off, fixed-scope BESS audits on your own telemetry: optimizer performance vs a perfect-foresight benchmark, warranty and degradation dossiers, and grid code compliance evidence packs.',
  keywords: [
    'BESS audit',
    'battery storage audit',
    'optimizer performance audit',
    'BESS revenue capture ratio',
    'battery warranty dossier',
    'BESS degradation analysis',
    'grid code compliance evidence',
    'independent BESS benchmark',
    'battery health score',
  ],
  openGraph: {
    title: 'NuraVolt Audit | BESS Optimizer, Warranty and Compliance Audits',
    description:
      'Independent BESS audits that turn one telemetry export into evidence: revenue capture vs optimal dispatch, warranty health and violations, and compliance packs.',
    type: 'website',
    url: 'https://nuravolt.com/solutions/audit',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'NuraVolt Audit',
    description:
      'Independent BESS audits: optimizer performance, warranty and degradation dossiers, compliance evidence packs.',
  },
};

export default function AuditSolutionLayout({ children }: { children: React.ReactNode }) {
  return children;
}
