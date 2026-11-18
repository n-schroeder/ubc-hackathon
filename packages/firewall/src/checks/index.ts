// The ordered check pipeline (docs/SPEC.md §3.4). Adding a check = adding it to one of these arrays.
import type { Pipeline } from "../firewall.ts";

export const defaultPipeline = (): Pipeline => ({
  beforeQuote: [],
  afterQuote: [],
});
