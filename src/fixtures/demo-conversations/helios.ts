import srForecast from '../../../public/data/showcase/soiling/helios/sr_forecast.json';
import irradianceComparison from '../../../public/data/showcase/soiling/helios/quality/irradiance_comparison.json';
import { buildSoilingThread } from './soilingThread';
import { buildIrradianceQualityThread } from './irradianceThread';
import type { DemoThread } from './types';

/** Example sessions for Helios PV (public /showcase surface). */

const PLANT = { id: 'showcase-helios', slug: 'helios', name: 'Helios PV' };

const threads: DemoThread[] = [
  buildSoilingThread({
    fixture: srForecast as any,
    plant: PLANT,
    surface: 'showcase',
  }),
  buildIrradianceQualityThread({
    fixture: irradianceComparison,
    plant: PLANT,
    surface: 'showcase',
  }),
];

export default threads;
