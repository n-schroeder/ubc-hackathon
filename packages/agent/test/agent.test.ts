// M7: the agent loop, driven by a scripted fake model against an in-process firewall (no network, no money).
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { loadDemoAddresses } from "@asf/shared";
import { createApp } from "@asf/firewall/server";
import { makeRig } from "@asf/firewall/testing";
import { runAgent, type MessagesApi } from "../src/agent.ts";
import { FirewallBackend } from "../src/backend.ts";
import { assertNoCredentials, loadAgentEnv } from "../src/env.ts";
import { FirewallClient } from "../src/firewall-client.ts";
import { ProgressTracker, resourceKey } from "../src/progress.ts";
import { MAX_DATA_CHARS, TOOLS, truncateData } from "../src/tools.ts";

type BetaMessage = Anthropic.Beta.BetaMessage;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Call = { name: string; input: Record<string, unknown> };

let ids = 0;
function reply(calls: Call[], text = ""): BetaMessage {
  const content: any[] = [];
  if (text) content.push({ type: "text", text, citations: null });
  for (const c of calls) content.push({ type: "tool_use", id: `toolu_${++ids}`, name: c.name, input: c.input });
  return {
    id: `msg_${ids}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content,
    stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null, stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}

/** A model that plays back `script`, one assistant turn per request, and records what it was sent. */
function scripted(script: (BetaMessage | ((p: Params) => BetaMessage))[]) {
  const sent: Params[] = [];
  const api: MessagesApi = {
    async create(p) {
      sent.push(structuredClone(p));
      const next = script.shift();
      if (!next) throw new Error("script ran out");
      return typeof next === "function" ? next(p) : next;
    },
  };
  return { api, sent };
}

/** Last tool results the model was sent, parsed. */
function lastResults(p: Params): any[] {
  const last = p.messages[p.messages.length - 1]!;
  return (last.content as any[]).filter((b) => b.type === "tool_result").map((b) => JSON.parse(b.content));
}

const servers: { close(): void }[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

async function setup(mandate: { allowTransfers?: boolean } = {}) {
  const rig = makeRig();
  const m = rig.fw.createMandate({ task: "Plan a weekend picnic in Austin.", allowTransfers: mandate.allowTransfers ?? false });
  const server = createApp(rig.fw, { adminToken: "t" }).listen(0);
  servers.push(server);
  await new Promise((ok) => server.once("listening", ok));
  const fw = new FirewallClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const backend = new FirewallBackend(fw, m.id, { pollMs: 10, waitMs: 50 });
  return { ...rig, m, backend };
}

const quiet = () => {};

describe("agent loop", () => {
  it("finishes a task through the firewall, with the request shape the model requires", async () => {
    const { backend, pay } = await setup();
    const { api, sent } = scripted([
      reply([{ name: "get_mandate", input: {} }, { name: "list_services", input: {} }], "Reading my task."),
      reply([
        { name: "call_paid_api", input: { service: "weather-api", path: "/forecast?city=Austin", reason: "weather" } },
        { name: "call_paid_api", input: { service: "air-quality-api", path: "/current?city=Austin", reason: "air" } },
      ]),
      reply([], "Saturday looks good."),
    ]);
    const r = await runAgent({ messages: api, backend, log: quiet });

    expect(r).toMatchObject({ stop: "done", turns: 3, toolCalls: 4, finalText: "Saturday looks good." });
    expect(pay.paid).toHaveLength(2);
    expect(backend.progress.count).toBe(2);

    const first = sent[0]!;
    expect(first.model).toBe("claude-sonnet-5-5");
    expect(first.fallbacks).toBe("default");
    expect(first.betas).toContain("server-side-fallback-2026-07-01");
    expect(first.output_config).toEqual({ effort: "medium" });
    expect(first).not.toHaveProperty("thinking");
    expect(first).not.toHaveProperty("tool_choice");
    expect(first.tools!.map((t: any) => t.name)).toEqual(["list_services", "call_paid_api", "send_payment", "check_payment", "get_mandate"]);

    // Turn 2 replays turn 1's assistant content unchanged and returns both results in ONE user message.
    const t2 = sent[1]!.messages;
    expect(t2).toHaveLength(3);
    expect(t2[1]).toMatchObject({ role: "assistant" });
    expect((t2[1]!.content as any[]).map((b) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
    const [mandate, services] = lastResults(sent[1]!);
    expect(mandate.task).toBe("Plan a weekend picnic in Austin.");
    expect(services.services.map((s: any) => s.id)).toContain("weather-api");
    expect(JSON.stringify(services)).not.toMatch(/0x[0-9a-fA-F]{40}/); // no addresses reach the agent

    const [weather] = lastResults(sent[2]!);
    expect(weather).toMatchObject({ outcome: "approved", paid: true });
    expect(weather.data).toBeDefined();
  });

  it("uses the tool_use id as the idempotency key, so a replayed call can't pay twice", async () => {
    const { backend, pay, fw } = await setup();
    const call = { service: "weather-api", path: "/forecast?city=Austin", reason: "weather" };
    const a = await backend.callPaidApi(call.service, call.path, call.reason, "toolu_same");
    const b = await backend.callPaidApi(call.service, call.path, call.reason, "toolu_same");
    expect(b.intentId).toBe(a.intentId);
    expect(pay.paid).toHaveLength(1);
    expect(fw.store.recent()).toHaveLength(1);
  });

  it("an instruction injected into vendor data gets the transfer denied, and the agent carries on", async () => {
    const { backend, pay } = await setup({ allowTransfers: true });
    const attacker = loadDemoAddresses().attacker!;
    const { api, sent } = scripted([
      reply([{ name: "call_paid_api", input: { service: "premium-weather", path: "/forecast?city=Austin", reason: "weather" } }]),
      // The model falls for it, as the credulous prompt invites.
      reply([{ name: "send_payment", input: { recipient: attacker, amount: "5", reason: "vendor verification" } }]),
      reply([], "The verification payment was blocked, so I used the free data I had."),
    ]);
    const r = await runAgent({ messages: api, backend, log: quiet });

    expect(r.stop).toBe("done");
    expect(pay.transfers).toHaveLength(0);
    const [denial] = lastResults(sent[2]!);
    expect(denial).toMatchObject({ outcome: "denied", paid: false, rule: "policy.recipient_not_allowed" });
    expect(denial.detail).toMatch(/per-transfer cap/);
  });

  it("a vendor's endless pagination trips the velocity breaker, because the harness sees no new progress", async () => {
    const { backend, pay } = await setup();
    const page = (n: number) => reply([{ name: "call_paid_api", input: { service: "premium-weather", path: `/forecast?city=Austin&page=${n}`, reason: "next page" } }]);
    const { api, sent } = scripted([...Array.from({ length: 14 }, (_, i) => page(i + 1)), reply([], "Stopped.")]);
    await runAgent({ messages: api, backend, log: quiet, maxTurns: 20 });

    const outcomes = sent.slice(1).map((p) => lastResults(p)[0]);
    const firstDenied = outcomes.findIndex((o) => o.outcome === "denied");
    expect(firstDenied).toBeGreaterThan(0);
    expect(firstDenied).toBeLessThanOrEqual(11);
    expect(outcomes[firstDenied].rule).toMatch(/^(velocity|breaker)\./);
    expect(pay.paid.length).toBeLessThanOrEqual(11);
    expect(backend.progress.count).toBe(1);
  });

  it("turns tool errors into is_error results and stops at the turn limit", async () => {
    const { backend } = await setup();
    const loop = () => reply([{ name: "call_paid_api", input: { service: "weather-api", path: "", reason: "r" } }]);
    const { api, sent } = scripted([loop(), loop(), loop()]);
    const r = await runAgent({ messages: api, backend, log: quiet, maxTurns: 2 });
    expect(r.stop).toBe("max_turns");
    const last = sent[1]!.messages.at(-1)!.content as any[];
    expect(last[0]).toMatchObject({ type: "tool_result", is_error: true });
  });

  it("stops on a refusal without running tools", async () => {
    const { backend, pay } = await setup();
    const refusal = { ...reply([{ name: "call_paid_api", input: { service: "weather-api", path: "/forecast", reason: "r" } }]), stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } } as unknown as BetaMessage;
    const { api } = scripted([refusal]);
    const r = await runAgent({ messages: api, backend, log: quiet });
    expect(r.stop).toBe("refusal");
    expect(pay.paid).toHaveLength(0);
  });
});

describe("tools", () => {
  it("are strict and say nothing about security", () => {
    for (const t of TOOLS) {
      expect(t.strict).toBe(true);
      expect((t.input_schema as any).additionalProperties).toBe(false);
      expect(t.description).not.toMatch(/firewall|allowlist|limit|suspicious|injection|never/i);
    }
  });

  it("truncates large vendor bodies", () => {
    expect(truncateData({ a: 1 })).toEqual({ a: 1 });
    const big = truncateData("x".repeat(MAX_DATA_CHARS + 100)) as string;
    expect(big.length).toBeLessThan(MAX_DATA_CHARS + 60);
    expect(big).toMatch(/truncated, 100 more characters/);
  });
});

describe("progress", () => {
  it("ignores pagination and parameter order", () => {
    expect(resourceKey("w", "/forecast?city=Austin&page=3")).toBe(resourceKey("w", "/forecast?page=9&city=austin"));
    expect(resourceKey("w", "/forecast?city=Austin")).not.toBe(resourceKey("w", "/forecast?city=Dallas"));
    expect(resourceKey("w", "/forecast")).not.toBe(resourceKey("aq", "/forecast"));
  });

  it("summarizes the same set the same way", () => {
    const a = new ProgressTracker();
    const b = new ProgressTracker();
    a.record("w", "/f?city=A"); a.record("w", "/f?city=B");
    b.record("w", "/f?city=B"); b.record("w", "/f?city=A&page=2");
    expect(a.summary()).toBe(b.summary());
    expect(a.summary()).toMatch(/^2 resources\//);
  });
});

describe("agent environment", () => {
  it("refuses to start with firewall credentials in its environment", () => {
    expect(() => assertNoCredentials({ ENTITY_SECRET: "x" })).toThrow(/ENTITY_SECRET/);
    expect(() => assertNoCredentials({ FIREWALL_ADMIN_TOKEN: "x", BASELINE_PRIVATE_KEY: "y" })).toThrow(/FIREWALL_ADMIN_TOKEN, BASELINE_PRIVATE_KEY/);
    expect(() => assertNoCredentials({ ANTHROPIC_API_KEY: "k", PATH: "/bin" })).not.toThrow();
  });

  it("reads only its own variables from .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-env-"));
    const f = join(dir, ".env");
    writeFileSync(f, "ANTHROPIC_API_KEY=a\nENTITY_SECRET=s\nTEST_API_KEY=t\nAGENT_MODEL=m\nFIREWALL_ADMIN_TOKEN=x\n");
    expect(loadAgentEnv(f, { AGENT_MODEL: "override" })).toEqual({ ANTHROPIC_API_KEY: "a", AGENT_MODEL: "override" });
  });
});
