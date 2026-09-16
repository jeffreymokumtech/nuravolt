import revenue from '../../../public/data/showcase/bess/nimbus/ancillary_revenue_30d.json';
import { shapeBessRevenueOutput } from '@/lib/ai/tool-shapes';
import {
  assistantMsg,
  textPart,
  toolPart,
  userMsg,
  type DemoThread,
} from './types';
import { BESS_SERVICES } from '@/lib/config/bessServices';

/**
 * Example session for Nimbus Storage (public /showcase surface): the BESS
 * revenue stack, per service then per day. All numbers computed from the
 * shipped ancillary_revenue_30d.json through the live tool's shaper.
 */

const PLANT = { id: 'showcase-nimbus', slug: 'nimbus', name: 'Nimbus Storage' };

const byService = shapeBessRevenueOutput(revenue as any, PLANT, 7, 'service')!;
const byDay = shapeBessRevenueOutput(revenue as any, PLANT, 14, 'day')!;

const totalK = ((byService as any).total / 1000).toFixed(1);
const dailyMeanK = ((byService as any).daily_mean / 1000).toFixed(1);
const topBase = (byService as any).top_service as string;
const topMeta = BESS_SERVICES.find((s) => s.base === topBase);
const topSharePct = (byService as any).services[topBase].share_pct.toFixed(1);

const threads: DemoThread[] = [
  {
    id: 'nimbus-revenue-stack',
    title: 'What did the battery earn this week?',
    prompt: `What did ${PLANT.name} earn this week, and from which services?`,
    plantSlug: PLANT.slug,
    plantName: PLANT.name,
    surface: 'showcase',
    messages: [
      userMsg(`What did ${PLANT.name} earn this week, and from which services?`),
      assistantMsg([
        textPart(`Pulling the trailing 7 day revenue stack for ${PLANT.name}.`),
        toolPart('getBessRevenue', { plantId: PLANT.slug, days: 7, by: 'service' }, byService),
        textPart(
          `${PLANT.name} earned £${totalK}k over the trailing 7 days [[cite:revenue|plant=${PLANT.slug}]], a daily mean of £${dailyMeanK}k. The top earner is ${topMeta?.label ?? topBase} at ${topSharePct}% of the stack.\n\nHere is how that composed day by day over the last two weeks.`
        ),
        toolPart('getBessRevenue', { plantId: PLANT.slug, days: 14, by: 'day' }, byDay),
        textPart(
          `Frequency response carries the stack, with wholesale arbitrage topping up on spread days. The full service history is in the revenue cockpit [[cite:revenue|plant=${PLANT.slug}|service=${topBase}]].`
        ),
      ]),
    ],
  },
];

export default threads;
