/**
 * Best-effort 16-day daily precipitation forecast from Open-Meteo, used to
 * make the cleaning optimizer rain-aware (don't schedule a wash right before
 * rain washes the array for free). Returns null on any failure so callers
 * degrade to the rain-blind behavior.
 */

export interface RainForecastDay {
  date: string; // YYYY-MM-DD
  precipitation_mm: number;
}

export async function fetchRainForecast(
  lat: number,
  lon: number,
): Promise<RainForecastDay[] | null> {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    '&daily=precipitation_sum&forecast_days=16&timezone=UTC';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const days: string[] = json?.daily?.time ?? [];
    const rain: (number | null)[] = json?.daily?.precipitation_sum ?? [];
    if (!days.length || days.length !== rain.length) return null;
    return days.map((date, i) => ({
      date,
      precipitation_mm: Number(rain[i] ?? 0),
    }));
  } catch {
    return null;
  }
}
