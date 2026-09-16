import {
  shapeSoilingForecastOutput,
  soilingRowsFromFixture,
  type ToolPlantRef,
} from '@/lib/ai/tool-shapes';
import {
  assistantMsg,
  textPart,
  toolPart,
  userMsg,
  type DemoThread,
} from './types';

/**
 * Shared soiling/cleaning example-session builder — ribera (demo) and helios
 * (showcase) use the same sr_forecast.json fixture shape. All numerals in the
 * prose are template literals over the same computed values the tool output
 * carries.
 */

interface SrFixture {
  metadata: { current_sr: number };
  forecast: {
    summary: {
      min_sr_forecast: number;
      max_soiling_loss_pct: number;
      cleaning_recommendation?: string | null;
      days_until_rain?: number | null;
    };
    daily: any[];
  };
}

export function buildSoilingThread(args: {
  fixture: SrFixture;
  plant: ToolPlantRef;
  surface: 'demo' | 'showcase';
}): DemoThread {
  const { fixture, plant, surface } = args;
  const summary = fixture.forecast.summary;
  const rows = soilingRowsFromFixture(fixture.forecast.daily, summary.cleaning_recommendation);
  const output = shapeSoilingForecastOutput(rows, plant, rows.length, 'ml_forecast', null);

  const currentPct = (fixture.metadata.current_sr * 100).toFixed(1);
  const minPct = (summary.min_sr_forecast * 100).toFixed(1);
  const maxLossPct = summary.max_soiling_loss_pct.toFixed(1);
  const cleanRow = rows.find((r) => r.cleaningRecommended);
  const cleanDate = cleanRow?.date ?? rows[Math.min(13, rows.length - 1)].date;

  const scheduleDraft = {
    kind: 'cleaning_schedule_draft',
    draft: {
      plant_id: plant.id,
      plant_slug: plant.slug,
      plant_name: plant.name,
      dates: [cleanDate],
      rationale: `The soiling ratio is ${currentPct}% today and the forecast bottoms out at ${minPct}% over the horizon, a peak production loss of ${maxLossPct}%. The model flags cleaning inside the ${cleanDate} window before losses compound; rain relief is not expected in this period.`,
    },
    note: 'This is a DRAFT. The user reviews and adopts it via the rendered card.',
  };

  return {
    id: `${plant.slug}-cleaning-roi`,
    title: 'When should we clean, and is it worth it?',
    prompt: `When should we clean ${plant.name}, and is it worth it?`,
    plantSlug: plant.slug,
    plantName: plant.name,
    surface,
    messages: [
      userMsg(`When should we clean ${plant.name}, and is it worth it?`),
      assistantMsg([
        textPart(`Let me pull the soiling forecast for ${plant.name}.`),
        toolPart(
          'getSoilingForecast',
          { plantId: plant.slug, days: rows.length, includeWeather: false },
          output
        ),
        textPart(
          `Here is the picture. The soiling ratio at ${plant.name} [[cite:plant|plant=${plant.slug}]] is ${currentPct}% today and the forecast declines to ${minPct}% over the next ${rows.length} days, a peak production loss of ${maxLossPct}%. No meaningful rain relief is expected inside the horizon, so the array will not clean itself.\n\nThe model recommends cleaning by ${cleanDate}, before the loss curve steepens. I have prepared a draft schedule for that window.`
        ),
        toolPart(
          'proposeCleaningSchedule',
          { plantId: plant.slug, dates: [cleanDate], rationale: scheduleDraft.draft.rationale },
          scheduleDraft
        ),
        textPart(
          `A draft cleaning schedule is ready for your review above. Nothing is booked until you adopt it.`
        ),
      ]),
    ],
  };
}
