// Shared contracts between the agent, the firewall, the vendors and the red-team suite.
// Internal amounts are bigint USDC base units (6 decimals). Over HTTP/JSON they travel as
// decimal USDC strings like "0.001" (see money.ts formatUsdc/parseUsdc).

export type Address = `0x${string}`;

// ---------------------------------------------------------------- intents & decisions

export type IntentKind = "x402_call" | "transfer";

/** What the agent asks for. It's a request, not a payment. */
export type PaymentIntent = {
  id: string;                  // assigned by the firewall
  idempotencyKey: string;      // supplied by the caller (or = id); same key => same decision, never paid twice
  kind: IntentKind;
  mandateId: string;
  reason: string;              // the agent's stated reason, logged verbatim
  taskProgress?: string;       // opaque summary/hash of task state (P3 no-progress rule)
  // x402_call
  service?: string;            // registry id
  path?: string;               // path on the service, e.g. "/weather?city=Austin"
  // transfer
  recipient?: Address;
  amount?: bigint;
  createdAt: string;           // ISO
};

export type CheckOutcome = "pass" | "deny" | "escalate";

export type CheckResult = {
  outcome: CheckOutcome;
  rule: string;                // stable id, e.g. "preflight.payto_mismatch" (red-team tests assert on it)
  detail: string;              // human-readable, shown to agent + dashboard
  observed?: string;
  limit?: string;
  tripBreaker?: boolean;       // velocity checks set this to open the breaker
};

export type DecisionOutcome =
  | "approved"        // passed all checks and was paid
  | "denied"          // a check denied it
  | "pending_human"   // waiting in the approval queue
  | "human_approved"  // a human approved it and it was paid
  | "human_denied"    // a human denied it
  | "failed";         // passed checks but payment/settlement failed (fail closed)

/** A quote parsed from an x402 402 response: what the server is asking us to sign. */
export type X402Quote = {
  scheme: string;
  network: string;             // CAIP-2, e.g. "eip155:5042002"
  asset: Address;
  amount: bigint;
  payTo: Address;
  extraName?: string;          // e.g. "GatewayWalletBatched"
  extraVersion?: string;       // Gateway batching domain version ("1" | "2")
  verifyingContract?: Address; // EIP-712 verifyingContract we'd sign for (must be the GatewayWallet)
  resource?: string;
};

/** One append-only ledger row per intent decision (rows are updated only by the approval flow). */
export type LedgerRow = {
  seq: number;
  intentId: string;
  idempotencyKey: string;
  at: string;                  // ISO time of the decision
  kind: IntentKind;
  mandateId: string;
  service?: string;
  path?: string;
  requestKey?: string;         // normalized "service|path" or "transfer|recipient|amount" (duplicate detection)
  recipient?: Address;
  amount?: bigint;             // effective amount (transfer amount or x402 quote amount)
  reason: string;
  taskProgress?: string;
  outcome: DecisionOutcome;
  rule?: string;               // deciding rule (first deny / escalate), if any
  detail?: string;
  checks: CheckResult[];
  txHash?: string;             // onchain tx hash (transfers; nanopayments once Gateway batches them)
  explorerUrl?: string;
  gatewayTransferId?: string;  // Gateway nanopayment transfer id (x402 calls)
  vendorStatus?: number;       // HTTP status of the paid x402 request
  decidedBy?: string;          // "firewall" or the human who approved/denied
};

/** Spending counts only rows that actually moved money. */
export const SPENT_OUTCOMES: readonly DecisionOutcome[] = ["approved", "human_approved"];

// ---------------------------------------------------------------- mandates (P4)

export type MandateStatus = "active" | "completed" | "expired" | "revoked";

export type Mandate = {
  id: string;
  task: string;
  budget: bigint;
  spent: bigint;
  allowedServices: string[];   // registry ids; empty = no x402 services allowed
  allowTransfers: boolean;     // may this task make direct transfers at all?
  createdAt: string;
  expiresAt: string;
  status: MandateStatus;
  closedAt?: string;           // ISO; set when completed or revoked (not on lazy expiry)
};

// ---------------------------------------------------------------- registry (P2, P5 piece)

export type RegistryEntry = {
  id: string;                  // "weather-api"
  baseUrl: string;
  category: string;
  description: string;         // written by us; vendor metadata never reaches the LLM
  expectedPrice: bigint;
  priceTolerancePct: number;   // allow up to +N% over expectedPrice
  payTo: Address;              // pinned
  asset: Address;              // USDC on Arc testnet
  network: string;             // CAIP-2 Arc testnet
  status: "pinned";            // "pending" reserved for trust-on-first-use (stretch S2.1)
};

/** What the agent sees from list_services(): sanitized, no addresses. */
export type ServiceListing = Pick<RegistryEntry, "id" | "category" | "description"> & { expectedPrice: string };

// ---------------------------------------------------------------- policy

export type Policy = {
  perCallMax: bigint;          // max for one x402 call
  perTransferCap: bigint;      // max for one direct transfer
  humanApprovalAbove: bigint;  // escalate when effective amount > this
  dailyBudget: bigint;         // rolling 24h, all mandates
  recipientAllowlist: Address[];
  mandateDefaults: { budget: bigint; ttlSeconds: number };
  preflight: { maxDriftPct: number };
  velocity: {
    perMinute: bigint;                 // $/min across everything
    maxCallsPerServicePerTask: number;
    duplicateLimit: number;            // same requestKey more than N times in window => trip
    duplicateWindowSeconds: number;
    noProgressLimit: number;           // N spent calls in a mandate with unchanged taskProgress => trip
  };
};

// ---------------------------------------------------------------- breaker (P3)

export type BreakerState = {
  state: "closed" | "open";    // "half_open" reserved for stretch S3.1
  trippedAt?: string;
  rule?: string;
  detail?: string;
  resetAt?: string;            // last human reset; velocity windows start no earlier than this
};

// ---------------------------------------------------------------- the check pipeline

/** Everything a check may look at. Checks are pure: no I/O, no mutation. */
export type CheckContext = {
  now: Date;
  policy: Policy;
  breaker: BreakerState;
  mandate?: Mandate;           // resolved from intent.mandateId (undefined if unknown)
  service?: RegistryEntry;     // resolved from intent.service (undefined if unknown)
  quote?: X402Quote;           // for x402_call, the server's 402 requirements
  amount?: bigint;             // effective amount: transfer amount or quote amount
  requestKey?: string;
  history: LedgerRow[];        // ledger rows from the last 24h, oldest first (excludes this intent's own row)
  humanApproved?: boolean;     // re-run after a human approved an escalated intent
};

export type Check = {
  name: string;                // "breaker" | "mandate" | "preflight" | "policy" | "velocity" | "escalation" | ...
  run: (intent: PaymentIntent, ctx: CheckContext) => CheckResult | CheckResult[];
};

// ---------------------------------------------------------------- firewall HTTP API (JSON)

export type IntentRequest = {
  kind: IntentKind;
  mandateId: string;
  reason: string;
  idempotencyKey?: string;
  taskProgress?: string;
  service?: string;
  path?: string;
  recipient?: string;
  amount?: string;             // decimal USDC, transfers only
};

export type IntentResponse = {
  intentId: string;
  outcome: DecisionOutcome;
  rule?: string;
  detail?: string;
  amount?: string;             // decimal USDC
  txHash?: string;
  explorerUrl?: string;
  gatewayTransferId?: string;
  data?: unknown;              // the paid API's response body (x402_call, when approved)
};
