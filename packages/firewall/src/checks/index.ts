// The ordered check pipeline (docs/SPEC.md §3.4). Adding a check = adding it to one of these arrays.
// First deny wins; an escalate is remembered and the rest still run.
import type { Pipeline } from "../firewall.ts";
import { breakerCheck } from "./breaker.ts";
import { escalationCheck } from "./escalation.ts";
import { mandateBudgetCheck, mandateCheck } from "./mandate.ts";
import { policyCheck } from "./policy.ts";
import { preflightCheck } from "./preflight.ts";
import { velocityCheck } from "./velocity.ts";

export { breakerCheck, escalationCheck, mandateBudgetCheck, mandateCheck, policyCheck, preflightCheck, velocityCheck };

export const defaultPipeline = (): Pipeline => ({
  // Before the firewall contacts the vendor: is spending allowed at all, and for this task?
  beforeQuote: [breakerCheck, mandateCheck],
  // On the vendor's quote (or the transfer amount).
  afterQuote: [preflightCheck, policyCheck, mandateBudgetCheck, velocityCheck, escalationCheck],
});
