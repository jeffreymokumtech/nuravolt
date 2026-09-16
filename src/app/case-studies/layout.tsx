import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Case Studies | NuraVolt - Real Solar & BESS Monitoring Results',
  description: 'Anonymized case studies showing 6-13 month ROI across Europe, UAE, and GCC solar portfolios. Power recovery, O&M savings, and soiling optimization from real deployments.',
  keywords: [
    'solar monitoring case studies',
    'PV monitoring ROI',
    'solar ROI examples',
    'UAE solar monitoring',
    'European solar monitoring',
    'GCC solar projects',
    'solar power recovery',
    'O&M savings',
    'soiling optimization'
  ],
  openGraph: {
    title: 'Case Studies | NuraVolt - Real Solar & BESS Monitoring Results',
    description: 'See real results from solar operators: 6-13 month ROI, power recovery, and O&M savings.',
    type: 'website',
    url: 'https://nuravolt.com/case-studies'
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Case Studies | NuraVolt',
    description: 'Real solar monitoring results from Europe, UAE, and GCC'
  }
};

export default function CaseStudiesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
