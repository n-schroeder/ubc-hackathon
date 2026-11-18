// The agent's only connection to money: the firewall's agent-facing HTTP API (no admin token).
import type { IntentRequest, IntentResponse, ServiceListing } from "@asf/shared";

export type MandateView = {
  id: string;
  task: string;
  budget: string;
  spent: string;
  remaining: string;
  allowedServices: string[];
  allowTransfers: boolean;
  expiresAt: string;
  status: string;
};

export class FirewallClient {
  constructor(readonly baseUrl: string, private fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`firewall ${init?.method ?? "GET"} ${path} → HTTP ${res.status}: ${body.error ?? "error"}`);
    return body;
  }

  listServices = () => this.json<ServiceListing[]>("/services");
  getMandate = (id: string) => this.json<MandateView>(`/mandates/${encodeURIComponent(id)}`);
  getIntent = (id: string) => this.json<IntentResponse>(`/intents/${encodeURIComponent(id)}`);
  submit = (req: IntentRequest) => this.json<IntentResponse>("/intents", { method: "POST", body: JSON.stringify(req) });
}
