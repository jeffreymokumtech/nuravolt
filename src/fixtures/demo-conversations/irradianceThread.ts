import {
  shapeIrradianceQualityOutput,
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
 * Shared irradiance data-quality example-session builder — ribera (demo) and
 * helios (showcase) use the same irradiance_comparison.json fixture shape.
 * All numerals in the prose are template literals over the same computed
 * values the tool output carries.
 */

export function buildIrradianceQualityThread(args: {
  fixture: any;
  plant: ToolPlantRef;
  surface: 'demo' | 'showcase';
}): DemoThread {
  const { fixture, plant, surface } = args;
  const output = shapeIrradianceQualityOutput(fixture, plant) as any;

  const corr = output.overall.correlation as number;
  const biasPct = output.overall.bias_pct as number;
  const rmse = output.overall.rmse_w_m2 as number;
  const samples = output.overall.sample_count as number;
  const alertCount = output.alerts.length as number;
  const highCount = output.alerts.filter((a: any) => a.severity === 'high').length;

  return {
    id: `${plant.slug}-irradiance-quality`,
    title: 'Can we trust the irradiance sensor?',
    prompt: `How good is our irradiance data at ${plant.name}?`,
    plantSlug: plant.slug,
    plantName: plant.name,
    surface,
    messages: [
      userMsg(`How good is our irradiance data at ${plant.name}?`),
      assistantMsg([
        textPart(
          `Let me compare the on-site sensor track against the satellite reference model.`
        ),
        toolPart('getIrradianceQuality', { plantId: plant.slug }, output),
        textPart(
          `The on-site pyranometer at ${plant.name} [[cite:plant|plant=${plant.slug}]] needs attention. Across ${samples.toLocaleString('en-GB')} matched hours the correlation with the Open-Meteo reference is only ${corr.toFixed(2)}, and the sensor reads ${biasPct.toFixed(1)}% higher than the model on average, with an RMSE of ${Math.round(rmse)} W/m2.\n\nThe analysis raised ${alertCount} quality alerts, ${highCount} of them high severity. The pattern of a persistent positive bias plus asymmetric morning and evening deviation points to calibration or orientation drift rather than random noise.\n\nMy recommendation: schedule a sensor calibration check during the next site visit, and until then treat soiling and performance ratios derived from this sensor with caution. The satellite track is the more stable reference for trend analysis right now.`
        ),
      ]),
    ],
  };
}
