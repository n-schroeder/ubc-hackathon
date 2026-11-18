// The agent's five tools. Their descriptions say what each tool does and nothing about security: the
// agent is not trusted to enforce limits, so it is not asked to (SPEC §3.5). The firewall decides.
import type Anthropic from "@anthropic-ai/sdk";
import type { PaymentBackend, ToolOutput } from "./backend.ts";

type BetaTool = Anthropic.Beta.BetaTool;

/** Vendor bodies can be large (or hostile); the model sees at most this many characters of one. */
export const MAX_DATA_CHARS = 6000;

const obj = (properties: Record<string, unknown>, required: string[]): BetaTool["input_schema"] => ({
  type: "object", properties, required, additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });

export const TOOLS: BetaTool[] = [
  {
    name: "list_services",
    description: "List the paid data services available to you, with what each one provides and its usual price per call in USDC.",
    input_schema: obj({}, []),
    strict: true,
  },
  {
    name: "call_paid_api",
    description:
      "Call a paid data service and get its response. The service charges a small USDC fee per call, which is paid automatically. " +
      "`path` is the request path under the service, including any query string, e.g. /forecast?city=Austin.",
    input_schema: obj({
      service: str("Service id from list_services."),
      path: str("Request path and query string, starting with /."),
      reason: str("One sentence: why this call helps the task."),
    }, ["service", "path", "reason"]),
    strict: true,
  },
  {
    name: "send_payment",
    description: "Send USDC directly to a wallet address on the Arc network.",
    input_schema: obj({
      recipient: str("0x wallet address."),
      amount: str("Amount in USDC as a decimal string, e.g. \"0.25\"."),
      reason: str("One sentence: why this payment is needed."),
    }, ["recipient", "amount", "reason"]),
    strict: true,
  },
  {
    name: "check_payment",
    description: "Check the status of a payment that is waiting for approval. Waits up to about 45 seconds for a decision.",
    input_schema: obj({ intentId: str("The intentId returned when the payment was submitted.") }, ["intentId"]),
    strict: true,
  },
  {
    name: "get_mandate",
    description: "Show your current task, its budget, how much is spent and remaining, and when it expires.",
    input_schema: obj({}, []),
    strict: true,
  },
];

export type ToolResult = { output: ToolOutput; isError: boolean };

function need(input: Record<string, unknown>, ...keys: string[]): string[] {
  return keys.map((k) => {
    const v = input[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`missing or empty "${k}"`);
    return v;
  });
}

/** Cap a vendor body so one response can't flood the context. */
export function truncateData(data: unknown): unknown {
  if (data === undefined) return undefined;
  const text = typeof data === "string" ? data : JSON.stringify(data);
  if (text.length <= MAX_DATA_CHARS) return data;
  return `${text.slice(0, MAX_DATA_CHARS)}… [truncated, ${text.length - MAX_DATA_CHARS} more characters]`;
}

/** Run one tool call. `key` (the tool_use id) doubles as the intent's idempotency key, so a retried
 *  request can't pay twice. Errors become is_error results, never exceptions, so the loop keeps going. */
export async function runTool(backend: PaymentBackend, name: string, rawInput: unknown, key: string): Promise<ToolResult> {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "list_services":
        return { output: await backend.listServices(), isError: false };
      case "call_paid_api": {
        const [service, path, reason] = need(input, "service", "path", "reason");
        const out = await backend.callPaidApi(service!, path!, reason!, key);
        if ("data" in out) out.data = truncateData(out.data);
        return { output: out, isError: false };
      }
      case "send_payment": {
        const [recipient, amount, reason] = need(input, "recipient", "amount", "reason");
        return { output: await backend.sendPayment(recipient!, amount!, reason!, key), isError: false };
      }
      case "check_payment": {
        const [intentId] = need(input, "intentId");
        return { output: await backend.checkPayment(intentId!), isError: false };
      }
      case "get_mandate":
        return { output: await backend.getMandate(), isError: false };
      default:
        return { output: { error: `unknown tool "${name}"` }, isError: true };
    }
  } catch (e) {
    return { output: { error: (e as Error).message }, isError: true };
  }
}
