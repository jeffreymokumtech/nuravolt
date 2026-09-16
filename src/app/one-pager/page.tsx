import PVOnePager from '@/components/resources/PVOnePager';

export const metadata = {
  title: 'PV Monitoring Overview | NuraVolt',
  description: 'Comprehensive one-pager explaining NuraVolt\'s PV monitoring solution with 8-week implementation timeline',
  robots: 'noindex, nofollow', // Keep this private, not for SEO
};

export default function OnePagerPage() {
  return (
    <div className="min-h-screen bg-paper-2 py-8 px-4">
      <div className="max-w-[210mm] mx-auto mb-4">
        <div className="bg-paper-2 border border-divider rounded-lg p-4 print:hidden">
          <h2 className="font-bold text-ink mb-2">How to Export to PDF:</h2>
          <ol className="text-sm text-ink space-y-1 list-decimal list-inside">
            <li>Click the "Export to PDF" button below</li>
            <li>In the print dialog, select "Save as PDF" as destination</li>
            <li>Choose "Portrait" layout and "Default" or "Minimal" margins</li>
            <li>Enable "Background graphics" for best color output</li>
            <li>Click "Save" and choose your filename</li>
          </ol>
          <p className="text-xs text-primary mt-2">
            💡 Tip: Save as "NuraVolt-PV-Monitoring-Overview.pdf" for professional sharing
          </p>
        </div>
      </div>

      <PVOnePager />
    </div>
  );
}
