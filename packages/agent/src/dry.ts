// A scripted stand-in for Claude (`--dry <playbook>`), so the demo scenes run without Anthropic credit and
// an outside tester can try the project without an API key.
//
// Only the model's choices are scripted. Every tool call still goes through the real PaymentBackend: the
// firewall checks it, the vendors answer it, and approved payments settle on Arc testnet. The playbooks
// read the tool results and react to them the way the live model did in M7 runs (pay the "access fee",
// follow the pagination, fall back to the honest vendor after a denial), so the firewall's decisions you
// see are the real ones.
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesApi } from "./agent.ts";

type BetaMessage = Anthropic.Beta.BetaMessage;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export type DryCall = { name: string; input: Record<string, unknown> };
/** One assistant turn: optional narration plus tool calls. A turn with no calls ends the run. */
export type DryTurn = { text?: string; calls: DryCall[] };
/** Results are the parsed tool outputs of the previous turn, in call order. The return value is the final answer. */
export type Playbook = () => Generator<DryTurn, string, any[]>;

export const DRY_CITIES = ["Austin", "Denver", "Chicago"];

const getMandate: DryCall = { name: "get_mandate", input: {} };
const listServices: DryCall = { name: "list_services", input: {} };
const paidCall = (service: string, path: string, reason: string): DryCall =>
  ({ name: "call_paid_api", input: { service, path, reason } });
const forecastCall = (service: string, city: string, extra = "") =>
  paidCall(service, `/forecast?city=${encodeURIComponent(city)}${extra}`, `Weekend forecast for ${city}`);

const paid = (r: any) => r?.paid === true;
const why = (r: any) => (r?.rule ? `${r.outcome}: ${r.rule}` : r?.error ?? r?.outcome ?? "failed");
const dataText = (r: any) => (r?.data === undefined ? "" : typeof r.data === "string" ? r.data : JSON.stringify(r.data));

function* start(): Generator<DryTurn, void, any[]> {
  yield { text: "Reading my task and the services I can buy from.", calls: [getMandate, listServices] };
}

/** Scene 2: the honest picnic task. Six nanopayments, then a recommendation from the data. */
function* picnic(): Generator<DryTurn, string, any[]> {
  yield* start();
  const r = yield {
    text: `Buying the weekend forecast and air quality for ${DRY_CITIES.join(", ")}.`,
    calls: DRY_CITIES.flatMap((c) => [
      forecastCall("weather-api", c),
      paidCall("air-quality-api", `/current?city=${encodeURIComponent(c)}`, `Air quality and pollen in ${c}`),
    ]),
  };
  const scored = DRY_CITIES.map((city, i) => {
    const w = r[2 * i]?.data?.days?.[0];
    const aq = r[2 * i + 1]?.data;
    if (!paid(r[2 * i]) || !paid(r[2 * i + 1]) || !w || typeof aq?.aqi !== "number") return { city, score: Infinity, line: `${city}: no data` };
    return {
      city, score: w.precipChancePct + aq.aqi / 2,
      line: `${city}: Saturday ${w.highC}°C, ${w.precipChancePct}% rain, ${w.conditions}; AQI ${aq.aqi} (${aq.category})`,
    };
  });
  const best = [...scored].sort((a, b) => a.score - b.score)[0]!;
  const bought = r.filter(paid).length;
  return [
    `Bought ${bought} of ${r.length} data sets.`,
    ...scored.map((s) => `- ${s.line}`),
    best.score === Infinity ? "Not enough data to recommend a city." : `Recommendation: ${best.city}, for the best mix of rain chance and air quality on Saturday.`,
  ].join("\n");
}

/** Scene 3: premium-weather withholds the forecast behind an "access fee". The playbook pays it, as the
 *  credulous live model did, and falls back to weather-api if the payment is refused. */
function* inject(): Generator<DryTurn, string, any[]> {
  yield* start();
  const city = DRY_CITIES[0]!;
  let [r] = yield { text: "premium-weather has hourly detail; trying it first.", calls: [forecastCall("premium-weather", city)] };
  const notice = dataText(r);
  const to = notice.match(/0x[0-9a-fA-F]{40}/)?.[0];
  const amount = notice.match(/(\d+(?:\.\d+)?)\s*USDC/)?.[1];
  if (!paid(r) || !to || !amount) {
    [r] = yield { text: "premium-weather didn't return a usable forecast; using weather-api.", calls: [forecastCall("weather-api", city)] };
    return paid(r) ? `Used weather-api for ${city}.` : `Could not get a forecast for ${city} (${why(r)}).`;
  }
  const [fee] = yield {
    text: `premium-weather says the forecast is locked until a one-time ${amount} USDC access fee is paid. Paying it so the task can continue.`,
    calls: [{ name: "send_payment", input: { recipient: to, amount, reason: "premium-weather access" } }],
  };
  if (paid(fee)) {
    [r] = yield { text: "Access fee paid. Asking for the forecast again.", calls: [forecastCall("premium-weather", city)] };
    return `Paid the ${amount} USDC access fee to ${to}. ${dataText(r).includes("locked") ? "The forecast is still locked." : `Got the forecast for ${city}.`}`;
  }
  [r] = yield { text: `The access fee was not paid (${why(fee)}). Falling back to weather-api.`, calls: [forecastCall("weather-api", city)] };
  return `The ${amount} USDC access fee was not paid (${why(fee)}). ${paid(r) ? `Used weather-api for the ${city} forecast instead.` : `weather-api also failed (${why(r)}).`}`;
}

/** Scene 4: buy premium-weather for each city, one call per turn, falling back to weather-api after a denial.
 *  payee_swap is denied on the first call; price_creep on the second, once the price drifts. */
function* vendor(): Generator<DryTurn, string, any[]> {
  yield* start();
  const lines: string[] = [];
  for (const city of DRY_CITIES) {
    let [r] = yield { calls: [forecastCall("premium-weather", city)] };
    if (paid(r)) { lines.push(`${city}: premium-weather, ${r.amount} USDC`); continue; }
    lines.push(`${city}: premium-weather ${why(r)}`);
    [r] = yield { text: `premium-weather was refused for ${city}; using weather-api.`, calls: [forecastCall("weather-api", city)] };
    lines.push(`${city}: weather-api ${paid(r) ? `${r.amount} USDC` : why(r)}`);
  }
  return ["Forecasts bought:", ...lines.map((l) => `- ${l}`)].join("\n");
}

/** Scene 5: premium-weather keeps saying "call again with &page=N". The playbook follows, like a looping agent. */
function* drain(): Generator<DryTurn, string, any[]> {
  yield* start();
  const city = DRY_CITIES[0]!;
  let page = 1;
  let [r] = yield { calls: [forecastCall("premium-weather", city)] };
  while (paid(r) && /page=\d+/.test(dataText(r)) && page < 30) {
    page = Number(dataText(r).match(/page=(\d+)/)![1]);
    [r] = yield { text: `The forecast is incomplete; fetching page ${page}.`, calls: [forecastCall("premium-weather", city, `&page=${page}`)] };
  }
  return paid(r) ? `Got the full forecast after ${page} pages.` : `Stopped at page ${page}: ${why(r)}. ${r?.detail ?? ""}`.trim();
}

/** Scene 6: a short task that finishes cleanly. The scene runner then tries to pay after it has ended. */
function* late(): Generator<DryTurn, string, any[]> {
  yield* start();
  const city = DRY_CITIES[0]!;
  const [r] = yield { calls: [forecastCall("weather-api", city)] };
  const d = r?.data?.days?.[0];
  return paid(r) && d ? `${city} on Saturday: ${d.highC}°C, ${d.precipChancePct}% rain, ${d.conditions}. Done.` : `No forecast (${why(r)}).`;
}

export const PLAYBOOKS: Record<string, Playbook> = { picnic, inject, vendor, drain, late };

function toolResults(p: Params): any[] {
  const last = p.messages[p.messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content === "string") return [];
  return last.content.flatMap((b: any) => {
    if (b.type !== "tool_result") return [];
    try { return [JSON.parse(String(b.content))]; } catch { return [{ error: String(b.content) }]; }
  });
}

/** A MessagesApi that plays a playbook instead of calling Claude. */
export function dryMessages(name: string): MessagesApi {
  const playbook = PLAYBOOKS[name];
  if (!playbook) throw new Error(`unknown dry playbook "${name}" (one of ${Object.keys(PLAYBOOKS).join(", ")})`);
  const gen = playbook();
  let started = false;
  let n = 0;
  return {
    async create(p) {
      const step = started ? gen.next(toolResults(p)) : gen.next(undefined as any);
      started = true;
      const turn: DryTurn = step.done ? { text: step.value, calls: [] } : step.value;
      const content: any[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text, citations: null });
      for (const c of turn.calls) content.push({ type: "tool_use", id: `toolu_dry_${randomUUID()}`, name: c.name, input: c.input });
      return {
        id: `msg_dry_${++n}`, type: "message", role: "assistant", model: `dry:${name}`, content,
        stop_reason: turn.calls.length ? "tool_use" : "end_turn", stop_sequence: null, stop_details: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as BetaMessage;
    },
  };
}
