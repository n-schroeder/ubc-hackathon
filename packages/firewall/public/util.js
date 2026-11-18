// Small helpers. Every string that reaches the DOM goes through text nodes (never innerHTML):
// ledger rows carry agent- and vendor-influenced text.

/** h("div", {class: "x", onclick}, "text", childNode, ...) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

/** Decimal USDC string ("0.001") → integer micro-USDC (Number is exact far beyond any testnet budget). */
export function micro(v) {
  if (typeof v !== "string") return 0;
  const m = /^(-)?(\d+)(?:\.(\d{1,6}))?$/.exec(v.trim());
  if (!m) return 0;
  const n = Number(m[2]) * 1e6 + Number((m[3] ?? "").padEnd(6, "0"));
  return m[1] ? -n : n;
}

/** micro-USDC → "$0.001" (at least 2 decimals, trailing zeros trimmed). */
export function usd(u, minDecimals = 2) {
  const neg = u < 0;
  const a = Math.round(Math.abs(u));
  let frac = String(a % 1e6).padStart(6, "0").replace(/0+$/, "");
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, "0");
  return `${neg ? "-" : ""}$${Math.floor(a / 1e6).toLocaleString("en-US")}.${frac}`;
}

/** A rate in micro-USDC/min → "$0.052" with 3 decimals (the precision the breaker talks in). */
export const rate = (u) => `$${(u / 1e6).toFixed(u >= 10e6 ? 2 : 3)}`;

export const shortAddr = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? ""));
export const shortId = (id, n = 8) => (typeof id === "string" && id.length > n + 4 ? `${id.slice(0, n)}…` : String(id ?? ""));

export function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

export function ago(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s ago`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
}

export function countdown(ms) {
  if (ms <= 0) return "expired";
  const sec = Math.floor(ms / 1000);
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hh ? `${hh}:${pad(mm)}:${pad(ss)} left` : `${mm}:${pad(ss)} left`;
}

/** Only http(s) links leave the page. */
export function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; 127.0.0.1 counts, but fall back anyway.
    const ta = h("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
