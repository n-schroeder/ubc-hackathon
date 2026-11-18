// Honest x402 vendor (F11): two paid endpoints at the registry's prices, paid to the registry's payTo.
import express from "express";
import { loadRegistry, type RegistryEntry } from "@asf/shared";
import { airQuality, forecast } from "./data.ts";
import { cityOf, createPaywall, registryEntry, requireCity } from "./paywall.ts";

export type HonestOptions = { registry?: RegistryEntry[]; facilitatorUrl?: string };

export function createHonestApp(opts: HonestOptions = {}) {
  const registry = opts.registry ?? loadRegistry();
  const weather = registryEntry(registry, "weather-api");
  const air = registryEntry(registry, "air-quality-api");
  const paywall = createPaywall(opts.facilitatorUrl);

  const app = express();
  app.get("/health", (_req, res) => { res.json({ ok: true, vendor: "honest" }); });
  app.get("/weather/forecast", requireCity, paywall(() => ({ price: weather.expectedPrice, payTo: weather.payTo })), (req, res) => {
    res.json(forecast(cityOf(req)));
  });
  app.get("/air-quality/current", requireCity, paywall(() => ({ price: air.expectedPrice, payTo: air.payTo })), (req, res) => {
    res.json(airQuality(cityOf(req)));
  });
  return { app };
}
