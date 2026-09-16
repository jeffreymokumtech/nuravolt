import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ROI Calculator | NuraVolt - Calculate Solar Monitoring Savings',
  description: 'Free ROI calculator for solar PV and BESS monitoring. Conservative estimates based on NREL research. Calculate power recovery, O&M savings, and soiling optimization for your plant.',
  keywords: [
    'solar ROI calculator',
    'PV monitoring ROI',
    'solar monitoring cost savings',
    'PV optimization calculator',
    'solar plant ROI',
    'O&M cost reduction',
    'solar power recovery',
    'soiling optimization calculator',
    'solar monitoring savings'
  ],
  openGraph: {
    title: 'ROI Calculator | NuraVolt - Calculate Solar Monitoring Savings',
    description: 'Calculate your solar monitoring ROI. Conservative estimates based on NREL research and real customer results.',
    type: 'website',
    url: 'https://nuravolt.com/roi-calculator'
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ROI Calculator | NuraVolt',
    description: 'Calculate your solar monitoring cost savings - free, research-backed, transparent'
  }
};

export default function ROICalculatorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
