// P3: while the velocity breaker is open, nothing is spent, not even a human-approved intent.
import type { Check } from "@asf/shared";
import { deny, pass } from "./util.ts";

export const breakerCheck: Check = {
  name: "breaker",
  run: (_intent, ctx) => {
    const b = ctx.breaker;
    if (b.state !== "open") return pass("breaker.closed", "breaker closed");
    const why = b.rule ? ` by ${b.rule}` : "";
    return deny("breaker.open", `breaker open (tripped${why} at ${b.trippedAt ?? "?"}): all spending paused until a human resets it`);
  },
};
