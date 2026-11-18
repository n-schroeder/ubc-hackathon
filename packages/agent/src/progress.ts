// Task progress for the velocity breaker's no-progress rule (P3).
//
// The harness computes it, not the LLM: an agent stuck in a loop (or steered by a vendor) could otherwise
// claim progress forever. Progress is the set of distinct resources the task has bought so far, where a
// resource is service + path with pagination parameters removed. "Page 7 of the same forecast" is not new
// information, so the shady vendor's endless slow_drain pages leave progress unchanged and trip the breaker.
import { createHash } from "node:crypto";

const PAGINATION = ["page", "offset", "cursor", "limit", "start", "next", "p"];

export function resourceKey(service: string, path: string): string {
  const u = new URL(path.startsWith("/") ? path : `/${path}`, "http://resource.invalid");
  for (const p of PAGINATION) u.searchParams.delete(p);
  u.searchParams.sort();
  const q = u.searchParams.toString().toLowerCase();
  return `${service}${u.pathname.toLowerCase()}${q ? `?${q}` : ""}`;
}

export class ProgressTracker {
  private resources = new Set<string>();

  /** Call after a paid call returned data. */
  record(service: string, path: string): void {
    this.resources.add(resourceKey(service, path));
  }

  get count(): number {
    return this.resources.size;
  }

  /** Opaque summary sent as PaymentIntent.taskProgress. Same set → same string. */
  summary(): string {
    const sorted = [...this.resources].sort();
    const h = createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 12);
    return `${sorted.length} resources/${h}`;
  }
}
