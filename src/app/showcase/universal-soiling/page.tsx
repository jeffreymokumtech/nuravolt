import { UniversalSoilingCard } from '@/app/demo/_components/UniversalSoilingCard';

export const metadata = {
  title: 'Universal soiling forecast, any client, day 1',
  description:
    'Drop in any plant coordinates and get a defensible per-day soiling rate forecast in under a second. Climate-prior baseline + NREL Soiling Map overlay. No client data required.',
};

export default function UniversalSoilingShowcasePage() {
  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-12 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8">
          <div className="text-sm uppercase tracking-wide text-emerald-400">Phase K · Pillar 3</div>
          <h1 className="mt-2 text-3xl font-bold">Universal soiling forecast</h1>
          <p className="mt-3 text-zinc-400">
            Any client onboarded today gets a defensible per-day soiling-rate forecast for their
            coordinates, climate-prior baseline (literature-derived per zone) augmented by the NREL
            Soiling Map (146 US sites). No training data, no sensor history, no DustIQ required.
            Built on{' '}
            <code className="rounded bg-zinc-800 px-1 py-0.5 text-sm">
              nuravolt/soiling/client_baseline.py
            </code>
            .
          </p>
        </header>

        <UniversalSoilingCard />

        <section className="mt-8 space-y-4 text-sm text-zinc-400">
          <h2 className="text-base font-semibold text-zinc-200">What this composes</h2>
          <ul className="list-inside list-disc space-y-1">
            <li>
              <strong className="text-zinc-300">Climate prior</strong>, lat/lon resolves to one of 7
              climate zones (Mediterranean, MENA, Sahel, India, SW US desert, North Africa desert,
              temperate continental); each has a 12-month soiling-rate profile from peer-reviewed
              literature.
            </li>
            <li>
              <strong className="text-zinc-300">NREL Soiling Map overlay</strong>, for US plants
              within 300km of an NREL Soiling Map site, the per-month observed soiling rate blends
              with the climate prior (weighted toward NREL as distance decreases).
            </li>
            <li>
              <strong className="text-zinc-300">pvlib physics path</strong>, when rainfall + PM2.5
              / PM10 inputs are supplied (CAMS + CHIRPS already wired), the HSU or Kimber model
              produces a per-day SR trajectory instead of climatological average. (Not exposed in
              this minimal demo; available via{' '}
              <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs">
                nuravolt.soiling.pvlib_forecast.universal_forecast()
              </code>
              .)
            </li>
          </ul>
          <h2 className="text-base font-semibold text-zinc-200 pt-2">Honest caveats</h2>
          <ul className="list-inside list-disc space-y-1">
            <li>The climate prior is a rate, not a per-day trajectory. Rain washes aren't modelled here.</li>
            <li>NREL Map is US-only. Outside the US, climate prior alone.</li>
            <li>The "UNKNOWN" zone fallback returns a conservative 0.2 %/day, replace as soon as a real climate zone is established.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}
