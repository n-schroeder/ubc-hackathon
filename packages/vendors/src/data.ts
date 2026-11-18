// Fake but plausible vendor data. Seeded from the city name so the same city always gets the same
// numbers: demo runs and tests are repeatable, and the agent's recommendation is stable.

/** FNV-1a hash of the normalized seed, fed into mulberry32. */
function rng(seed: string): (min: number, max: number) => number {
  let h = 2166136261;
  for (const ch of seed.trim().toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (min, max) => min + Math.floor(next() * (max - min + 1));
}

const conditions = (precip: number, wind: number) =>
  precip >= 60 ? "rain" : precip >= 35 ? "cloudy" : wind >= 30 ? "windy" : precip >= 15 ? "partly cloudy" : "sunny";

export type DayForecast = { day: string; highC: number; lowC: number; precipChancePct: number; windKph: number; conditions: string };

export function forecast(city: string) {
  const r = rng(`forecast:${city}`);
  const base = r(8, 30);
  const days: DayForecast[] = ["Saturday", "Sunday"].map((day) => {
    const highC = base + r(-3, 4);
    const precipChancePct = r(0, 90);
    const windKph = r(3, 40);
    return { day, highC, lowC: highC - r(5, 11), precipChancePct, windKph, conditions: conditions(precipChancePct, windKph) };
  });
  return { city: city.trim(), unit: "celsius", days };
}

/** Hourly detail for Saturday daytime (the "premium" provider's selling point). */
export function hourly(city: string, hours = [9, 12, 15, 18]) {
  const r = rng(`hourly:${city}`);
  const sat = forecast(city).days[0]!;
  return hours.map((h) => ({
    time: `Saturday ${String(h).padStart(2, "0")}:00`,
    tempC: sat.lowC + Math.round(((sat.highC - sat.lowC) * Math.min(h - 6, 9)) / 9),
    precipChancePct: Math.max(0, Math.min(100, sat.precipChancePct + r(-15, 15))),
    windKph: Math.max(0, sat.windKph + r(-5, 5)),
  }));
}

const AQI_BANDS: [number, string][] = [[50, "good"], [100, "moderate"], [150, "unhealthy for sensitive groups"], [200, "unhealthy"]];

export function airQuality(city: string) {
  const r = rng(`air:${city}`);
  const aqi = r(12, 170);
  const pollenIndex = r(0, 12);
  return {
    city: city.trim(),
    aqi,
    category: AQI_BANDS.find(([max]) => aqi <= max)![1],
    dominantPollutant: ["pm2.5", "ozone", "pm10", "no2"][r(0, 3)],
    pollenIndex,
    pollen: pollenIndex <= 3 ? "low" : pollenIndex <= 7 ? "moderate" : "high",
  };
}
