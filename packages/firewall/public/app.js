// Agent Spending Firewall dashboard: live view of the firewall's decisions (SSE) plus the human controls
// (approvals, breaker reset, mandates, demo vendor mode). Plain ES modules, no build step.
import { h, micro, usd, rate, shortAddr, shortId, clock, ago, countdown, safeUrl, store, copyText } from "./util.js";
import { createSpendChart } from "./chart.js";

// ------------------------------------------------------------------ config from the URL hash
// #token=<admin token>&vendor=<demo vendor base url>&theme=dark|light

const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get("token")) store.set("asf.token", hash.get("token"));
if (hash.get("theme") === "dark" || hash.get("theme") === "light") document.documentElement.dataset.theme = hash.get("theme");
if (hash.has("token")) {
  // Keep the admin token out of the address bar (it's on screen in the demo video).
  hash.delete("token");
  const rest = hash.toString();
  history.replaceState(null, "", location.pathname + location.search + (rest ? `#${rest}` : ""));
}
let token = store.get("asf.token") ?? "";
const vendorBase = (safeUrl(hash.get("vendor") ?? "") ?? "http://127.0.0.1:4022").replace(/\/+$/, "");

// ------------------------------------------------------------------ state

const SPENT = new Set(["approved", "human_approved"]);
const DENIED = new Set(["denied", "human_denied"]);
const TONE = {
  approved: "good", human_approved: "good",
  denied: "bad", human_denied: "bad", failed: "bad",
  pending_human: "warn",
};
const LABEL = {
  approved: "approved", human_approved: "human approved", denied: "denied",
  human_denied: "human denied", failed: "failed", pending_human: "pending human",
};
const MAX_ROWS = 5000; // kept in memory (stats + chart)
const MAX_DOM = 300;   // rendered in the log
const DAY = 24 * 3600 * 1000;
const WINDOW = 5 * 60 * 1000;

const state = {
  rows: new Map(),       // intentId → LedgerRow
  policy: null,
  breaker: { state: "closed" },
  trips: new Set(),      // ms timestamps of breaker trips (chart markers)
  mandates: new Map(),   // id → Mandate (+ remaining)
  filter: "all",
  open: new Set(),       // expanded log rows
  busy: new Set(),       // approval ids with a request in flight
  ledgerTruncated: false,
};

const $ = (id) => document.getElementById(id);
const chart = createSpendChart($("chart"));

// ------------------------------------------------------------------ API

class AuthError extends Error {}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "x-admin-token": token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showAuth();
    throw new AuthError("admin token required");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

let toastTimer;
function toast(msg, tone) {
  const t = $("toast");
  t.textContent = msg;
  t.dataset.tone = tone ?? "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ------------------------------------------------------------------ connection (SSE + snapshot)

let es = null;
let retryMs = 1000;
let retryTimer;

function setConn(st, label) {
  $("conn").dataset.state = st;
  $("conn-label").textContent = label;
}

function showAuth() {
  setConn("unauthorized", "Unauthorized");
  $("auth").hidden = false;
  es?.close();
  es = null;
  clearTimeout(retryTimer);
  setTimeout(() => $("auth-input").focus(), 0);
}

$("auth-form").addEventListener("submit", (e) => {
  e.preventDefault();
  token = $("auth-input").value.trim();
  store.set("asf.token", token);
  $("auth-input").value = "";
  $("auth").hidden = true;
  connect();
});

function connect() {
  clearTimeout(retryTimer);
  es?.close();
  if (!token) return showAuth();
  setConn(state.connectedOnce ? "reconnecting" : "connecting", state.connectedOnce ? "Reconnecting…" : "Connecting…");
  es = new EventSource(`/events?token=${encodeURIComponent(token)}`);
  es.addEventListener("hello", (e) => {
    retryMs = 1000;
    state.connectedOnce = true;
    setConn("live", "Live");
    const { breaker } = JSON.parse(e.data);
    setBreaker(breaker);
    resync();
  });
  es.addEventListener("decision", (e) => upsert(JSON.parse(e.data), true));
  es.addEventListener("breaker", (e) => setBreaker(JSON.parse(e.data)));
  es.addEventListener("mandate", (e) => upsertMandate(JSON.parse(e.data)));
  es.onerror = async () => {
    if (es?.readyState === EventSource.CONNECTING) {
      setConn("reconnecting", "Reconnecting…");
      return; // the browser retries on its own
    }
    // Closed for good (HTTP error such as 401, or the server went away): find out which, then retry.
    es?.close();
    es = null;
    setConn("offline", "Offline · retrying");
    try {
      await api("/breaker");
    } catch (err) {
      if (err instanceof AuthError) return;
    }
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 10_000);
  };
}

async function resync() {
  try {
    const [policy, ledger, approvals, mandates, breaker] = await Promise.all([
      api("/policy"), api("/ledger?limit=1000"), api("/approvals"), api("/mandates"), api("/breaker"),
    ]);
    setPolicy(policy);
    state.ledgerTruncated = ledger.length >= 1000;
    for (const r of [...ledger].reverse()) upsert(r, false);
    for (const r of approvals) upsert(r, false);
    // Rows that were pending in our view but are no longer in the queue were resolved while we were away.
    const pendingNow = new Set(approvals.map((r) => r.intentId));
    for (const r of state.rows.values()) if (r.outcome === "pending_human" && !pendingNow.has(r.intentId)) refreshIntent(r.intentId);
    state.mandates.clear();
    for (const m of mandates) state.mandates.set(m.id, m);
    setBreaker(breaker);
    renderAll();
  } catch (err) {
    if (!(err instanceof AuthError)) toast(`Could not load the firewall state: ${err.message}`, "bad");
  }
}

async function refreshIntent(id) {
  // The agent-facing endpoint returns a summary; merge it into what we have.
  try {
    const r = await fetch(`/intents/${encodeURIComponent(id)}`).then((x) => (x.ok ? x.json() : null));
    const row = state.rows.get(id);
    if (r && row) upsert({ ...row, outcome: r.outcome, rule: r.rule, detail: r.detail, txHash: r.txHash, explorerUrl: r.explorerUrl, gatewayTransferId: r.gatewayTransferId }, false);
  } catch { /* next resync will catch up */ }
}

// ------------------------------------------------------------------ rows

function upsert(row, live) {
  if (!row || typeof row.intentId !== "string") return;
  const prev = state.rows.get(row.intentId);
  // A resolved approval never goes back to pending (a late snapshot can't undo a live update).
  if (prev && prev.outcome !== "pending_human" && row.outcome === "pending_human") return;
  state.rows.set(row.intentId, row);
  if (state.rows.size > MAX_ROWS) {
    const oldest = [...state.rows.values()].sort((a, b) => a.seq - b.seq).slice(0, state.rows.size - MAX_ROWS);
    for (const r of oldest) state.rows.delete(r.intentId);
  }
  if (live && SPENT.has(row.outcome) && !(prev && SPENT.has(prev.outcome))) {
    const m = state.mandates.get(row.mandateId);
    if (m) {
      m.spent = usdStr(micro(m.spent) + micro(row.amount));
      m.remaining = usdStr(micro(m.budget) - micro(m.spent));
    }
    refetchMandatesSoon();
  }
  if (live) {
    renderRow(row, !prev || prev.outcome !== row.outcome);
    scheduleRender();
  }
}

const usdStr = (u) => (u / 1e6).toFixed(6);

let mandateTimer;
function refetchMandatesSoon() {
  // The firewall only emits "mandate" on create/status change; spend updates come from refetching.
  if (mandateTimer) return;
  mandateTimer = setTimeout(async () => {
    mandateTimer = null;
    try {
      const list = await api("/mandates");
      state.mandates.clear();
      for (const m of list) state.mandates.set(m.id, m);
      renderMandates();
    } catch { /* keep the optimistic numbers */ }
  }, 1200);
}

const logEl = $("log");
const domRows = new Map(); // intentId → <li>

function visible(row) {
  if (state.filter === "blocked") return DENIED.has(row.outcome) || row.outcome === "failed";
  if (state.filter === "paid") return SPENT.has(row.outcome);
  return true;
}

function renderRow(row, flash) {
  const li = buildRow(row);
  li.hidden = !visible(row);
  const old = domRows.get(row.intentId);
  if (old) {
    old.replaceWith(li);
  } else {
    // Newest first by seq; live rows almost always go on top.
    let before = logEl.firstElementChild;
    while (before && Number(before.dataset.seq) > row.seq) before = before.nextElementSibling;
    logEl.insertBefore(li, before);
    while (logEl.children.length > MAX_DOM) {
      const last = logEl.lastElementChild;
      domRows.delete(last.dataset.id);
      state.open.delete(last.dataset.id);
      last.remove();
    }
  }
  domRows.set(row.intentId, li);
  if (flash) li.classList.add("flash");
}

function buildRow(r) {
  const tone = TONE[r.outcome] ?? "bad";
  const open = state.open.has(r.intentId);
  const target = r.kind === "transfer"
    ? h("span", { class: "target", title: r.recipient ?? "" }, "→ ", h("span", { class: "addr" }, shortAddr(r.recipient)))
    : h("span", { class: "target", title: `${r.service ?? ""}${r.path ?? ""}` }, r.service ?? "?", r.path ? h("span", { class: "path" }, r.path) : null);
  const amount = r.amount != null ? usd(micro(r.amount)) : "—";
  const checks = Array.isArray(r.checks) ? r.checks : [];

  const why = r.rule
    ? [h("code", { class: "rule" }, r.rule), h("span", { class: "detail" }, r.detail ?? "")]
    : [h("span", { class: "detail" }, r.detail ?? ""), checks.length ? h("span", { class: "muted small" }, `✓ ${checks.length}/${checks.length} checks passed`) : null];

  let proof = null;
  const link = r.explorerUrl && safeUrl(r.explorerUrl);
  if (link) {
    proof = h("a", { class: "proof", href: link, target: "_blank", rel: "noopener noreferrer", title: r.txHash ?? link, onclick: (e) => e.stopPropagation() },
      "Explorer ", h("code", null, shortAddr(r.txHash ?? "")), " ↗");
  } else if (r.gatewayTransferId) {
    proof = h("span", { class: "proof", title: r.gatewayTransferId }, h("span", { class: "gw" }, "Gateway "), h("code", null, shortId(r.gatewayTransferId, 10)));
  }

  const li = h("li", {
    class: `row${open ? " open" : ""}`, tabindex: "0", "aria-expanded": String(open),
    dataset: { id: r.intentId, seq: String(r.seq), tone, outcome: r.outcome },
  },
    h("div", { class: "row-main" },
      h("span", { class: "row-time", title: r.at }, clock(r.at)),
      h("span", { class: "kind", dataset: { kind: r.kind } }, r.kind === "transfer" ? "transfer" : "x402"),
      target,
      h("span", { class: "amount" }, amount),
      h("span", { class: "badge", dataset: { tone } }, LABEL[r.outcome] ?? String(r.outcome)),
    ),
    h("div", { class: "row-why" }, why),
    h("div", { class: "row-reason" }, h("span", { class: "reason" }, r.reason ?? ""), proof),
    open ? buildChecks(r, checks) : null,
  );
  return li;
}

function buildChecks(r, checks) {
  const table = h("table", { class: "checks" },
    h("thead", null, h("tr", null, h("th", null, "Result"), h("th", null, "Rule"), h("th", null, "Detail"))),
    h("tbody", null, checks.length
      ? checks.map((c) => h("tr", null,
        h("td", null, h("span", { class: "co", dataset: { o: c.outcome } }, c.outcome)),
        h("td", null, h("code", null, c.rule)),
        h("td", null, c.detail ?? "",
          c.observed || c.limit ? h("div", { class: "muted small" }, [c.observed ? `observed ${c.observed}` : "", c.limit ? `limit ${c.limit}` : ""].filter(Boolean).join(" · ")) : null,
          c.tripBreaker ? h("div", { class: "tone-bad small" }, "tripped the breaker") : null)))
      : h("tr", null, h("td", { colspan: "3", class: "muted" }, "No checks ran (rejected before the pipeline)."))),
  );
  const meta = [
    ["intent", r.intentId], ["mandate", r.mandateId], ["decided by", r.decidedBy],
    ["request", r.requestKey], ["vendor HTTP", r.vendorStatus], ["tx", r.txHash], ["gateway transfer", r.gatewayTransferId],
    ["task progress", r.taskProgress],
  ].filter(([, v]) => v !== undefined && v !== null && v !== "");
  return h("div", { class: "row-checks" }, table,
    h("div", { class: "meta" }, meta.map(([k, v]) => h("span", null, h("b", null, `${k} `), h("code", null, String(v))))));
}

function toggleRow(li) {
  const id = li.dataset.id;
  if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
  const row = state.rows.get(id);
  if (row) renderRow(row, false);
  domRows.get(id)?.focus({ preventScroll: true });
}

logEl.addEventListener("click", (e) => {
  if (e.target.closest("a, .row-checks")) return;
  if (getSelection()?.toString()) return; // selecting text, not toggling
  const li = e.target.closest(".row");
  if (li) toggleRow(li);
});
logEl.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("row")) {
    e.preventDefault();
    toggleRow(e.target);
  }
});

for (const b of document.querySelectorAll(".filters .seg")) {
  b.addEventListener("click", () => {
    state.filter = b.dataset.filter;
    for (const o of document.querySelectorAll(".filters .seg")) o.setAttribute("aria-pressed", String(o === b));
    for (const li of logEl.children) li.hidden = !visible(state.rows.get(li.dataset.id) ?? {});
    renderLogMeta();
  });
}

function renderLog() {
  const rows = [...state.rows.values()].sort((a, b) => b.seq - a.seq).slice(0, MAX_DOM);
  domRows.clear();
  logEl.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const li = buildRow(r);
    li.hidden = !visible(r);
    domRows.set(r.intentId, li);
    frag.append(li);
  }
  logEl.append(frag);
}

function renderLogMeta() {
  const shown = [...logEl.children].filter((li) => !li.hidden).length;
  $("log-empty").hidden = shown > 0;
  $("log-count").textContent = state.rows.size ? `${state.rows.size.toLocaleString("en-US")} loaded${state.ledgerTruncated ? "+" : ""}` : "";
}

// ------------------------------------------------------------------ header stats

function renderStats() {
  const now = Date.now();
  let spent = 0, n = 0, denied = 0, pending = 0;
  for (const r of state.rows.values()) {
    if (r.outcome === "pending_human") pending++;
    if (now - Date.parse(r.at) > DAY) continue;
    n++;
    if (SPENT.has(r.outcome)) spent += micro(r.amount);
    if (DENIED.has(r.outcome)) denied++;
  }
  $("stat-spent").textContent = usd(spent);
  $("stat-decisions").textContent = n.toLocaleString("en-US");
  $("stat-denied").textContent = denied.toLocaleString("en-US");
  $("stat-pending").textContent = String(pending);
  const budget = micro(state.policy?.dailyBudget);
  $("stat-budget").textContent = budget ? usd(budget) : "—";
  const bar = $("stat-spent-bar");
  bar.style.width = budget ? `${Math.min(100, (spent / budget) * 100)}%` : "0";
  bar.classList.toggle("over", budget > 0 && spent >= budget);
  if (state.ledgerTruncated) $("stat-spent").title = "Computed from the most recent 1000 ledger rows plus live updates";
}

// ------------------------------------------------------------------ approvals

const apprEl = $("approvals");
const apprDom = new Map();

function renderApprovals() {
  const pending = [...state.rows.values()].filter((r) => r.outcome === "pending_human").sort((a, b) => a.seq - b.seq);
  const ids = new Set(pending.map((r) => r.intentId));
  for (const [id, li] of apprDom) if (!ids.has(id)) { li.remove(); apprDom.delete(id); }
  for (const r of pending) {
    let li = apprDom.get(r.intentId);
    if (!li) {
      li = buildApproval(r);
      apprDom.set(r.intentId, li);
      apprEl.append(li);
    }
    for (const b of li.querySelectorAll("button")) b.disabled = state.busy.has(r.intentId);
  }
  $("approvals-empty").hidden = pending.length > 0;
  $("approvals-count").hidden = pending.length === 0;
  $("approvals-count").textContent = String(pending.length);
}

function buildApproval(r) {
  const to = r.kind === "transfer"
    ? h("div", { class: "approval-to", title: r.recipient ?? "" }, "transfer to ", h("code", null, shortAddr(r.recipient)))
    : h("div", { class: "approval-to" }, "x402 call to ", h("code", null, `${r.service ?? "?"}${r.path ?? ""}`));
  return h("li", { class: "approval" },
    h("div", { class: "approval-top" },
      h("span", { class: "approval-amt" }, r.amount != null ? usd(micro(r.amount)) : "—"),
      h("span", { class: "muted small" }, clock(r.at))),
    to,
    h("div", { class: "approval-why" }, r.rule ? h("code", { class: "rule" }, r.rule) : null, r.detail ?? ""),
    h("div", { class: "approval-reason" }, r.reason ?? ""),
    h("div", { class: "approval-actions" },
      h("button", { class: "btn btn-approve", type: "button", onclick: () => resolve(r.intentId, true) }, "Approve"),
      h("button", { class: "btn btn-deny", type: "button", onclick: () => resolve(r.intentId, false) }, "Deny")),
  );
}

async function resolve(id, approve) {
  if (state.busy.has(id)) return;
  state.busy.add(id);
  renderApprovals();
  try {
    const res = await api(`/approvals/${encodeURIComponent(id)}`, { method: "POST", body: { approve, by: "dashboard" } });
    const row = state.rows.get(id);
    if (row) upsert({ ...row, ...pick(res, ["outcome", "rule", "detail", "txHash", "explorerUrl", "gatewayTransferId"]), decidedBy: "dashboard" }, true);
    toast(approve
      ? res.outcome === "human_approved" ? `Approved and paid ${res.amount ? `$${res.amount}` : ""}` : `Re-check after approval: ${res.outcome}${res.rule ? ` (${res.rule})` : ""}`
      : "Denied");
  } catch (err) {
    if (err instanceof AuthError) return;
    if (err.status === 404) {
      toast("That approval was already resolved");
      refreshIntent(id);
    } else toast(`Could not ${approve ? "approve" : "deny"}: ${err.message}`, "bad");
  } finally {
    state.busy.delete(id);
    renderApprovals();
  }
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

// ------------------------------------------------------------------ breaker + spend rate

function setBreaker(b) {
  if (!b || (b.state !== "open" && b.state !== "closed")) return;
  state.breaker = b;
  if (b.state === "open" && b.trippedAt) state.trips.add(Date.parse(b.trippedAt));
  renderBreaker();
}

function renderBreaker() {
  const b = state.breaker;
  const open = b.state === "open";
  $("breaker").dataset.state = b.state;
  $("breaker-label").textContent = open ? "OPEN" : "CLOSED";
  $("breaker-sub").textContent = open ? "All spending paused until a human resets it" : "Spending allowed";
  $("breaker-reset").hidden = !open;
  $("breaker-why").hidden = !open;
  if (open) {
    $("breaker-rule").textContent = b.rule ?? "";
    $("breaker-detail").textContent = b.detail ?? "";
    renderBreakerAge();
  }
}

function renderBreakerAge() {
  const b = state.breaker;
  if (b.state !== "open" || !b.trippedAt) return;
  $("breaker-at").textContent = `tripped at ${clock(b.trippedAt)} · ${ago(Date.now() - Date.parse(b.trippedAt))}`;
}

$("breaker-reset").addEventListener("click", async () => {
  const btn = $("breaker-reset");
  btn.disabled = true;
  try {
    setBreaker(await api("/breaker/reset", { method: "POST" }));
    toast("Breaker reset: spending allowed again");
  } catch (err) {
    if (!(err instanceof AuthError)) toast(`Reset failed: ${err.message}`, "bad");
  } finally {
    btn.disabled = false;
  }
});

function spendSeries(now) {
  const end = Math.floor(now / 1000) * 1000;
  const start = end - WINDOW;
  const ev = [];
  for (const r of state.rows.values()) {
    if (!SPENT.has(r.outcome)) continue;
    const t = Date.parse(r.at);
    if (t > start - 60_000 && t <= end) ev.push([t, micro(r.amount)]);
  }
  ev.sort((a, b) => a[0] - b[0]);
  // Sliding 60 s window over the sorted spend events.
  const series = [];
  let lo = 0, hi = 0, sum = 0;
  for (let t = start; t <= end; t += 1000) {
    while (hi < ev.length && ev[hi][0] <= t) sum += ev[hi++][1];
    while (lo < hi && ev[lo][0] <= t - 60_000) sum -= ev[lo++][1];
    series.push({ t, v: sum });
  }
  return { series, now: end };
}

function renderRate() {
  const { series, now } = spendSeries(Date.now());
  const limit = micro(state.policy?.velocity?.perMinute);
  const cur = series.at(-1)?.v ?? 0;
  $("rate-now").textContent = rate(cur);
  $("rate-now").classList.toggle("over", limit > 0 && cur >= limit);
  $("rate-limit").textContent = limit ? rate(limit) : "—";
  chart.draw({ series, now, windowMs: WINDOW, limit, trips: [...state.trips] });
}

// ------------------------------------------------------------------ mandates

function upsertMandate(m) {
  if (!m || typeof m.id !== "string") return;
  state.mandates.set(m.id, m);
  renderMandates();
}

function mandateStatus(m) {
  return m.status === "active" && Date.parse(m.expiresAt) <= Date.now() ? "expired" : m.status;
}

function renderMandates() {
  const all = [...state.mandates.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const active = all.filter((m) => mandateStatus(m) === "active");
  const recent = all.filter((m) => mandateStatus(m) !== "active").slice(0, 2);
  $("mandates").replaceChildren(...active.map(buildMandate), ...recent.map(buildMandate));
  $("mandates-empty").hidden = active.length > 0;
}

function buildMandate(m) {
  const st = mandateStatus(m);
  const budget = micro(m.budget), spent = micro(m.spent);
  const remaining = m.remaining != null ? micro(m.remaining) : budget - spent;
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 100;
  const left = Date.parse(m.expiresAt) - Date.now();
  const actions = st === "active" ? h("div", { class: "mandate-actions" },
    h("button", { class: "btn btn-small", type: "button", onclick: (e) => mandateAction(m.id, "complete", e.currentTarget) }, "Complete"),
    h("button", { class: "btn btn-small btn-deny", type: "button", onclick: (e) => mandateAction(m.id, "revoke", e.currentTarget) }, "Revoke"),
  ) : null;
  return h("li", { class: `mandate${st === "active" ? "" : " inactive"}` },
    h("div", { class: "mandate-top" },
      h("div", { class: "mandate-task" }, m.task ?? ""),
      h("span", { class: "status", dataset: { s: st } }, st)),
    h("div", { class: "mandate-id" }, h("code", { title: m.id }, shortId(m.id, 13)),
      h("button", { class: "link-btn", type: "button", onclick: async () => toast((await copyText(m.id)) ? "Mandate id copied" : "Copy failed", undefined) }, "copy"),
      m.allowTransfers ? h("span", null, "· transfers allowed") : null),
    h("div", { class: "budget" },
      h("div", { class: "budget-nums" },
        h("span", null, h("b", null, usd(spent)), ` spent of ${usd(budget)}`),
        h("span", null, h("b", null, usd(remaining)), " left")),
      h("div", { class: "bar" }, h("div", { class: pct >= 100 ? "over" : pct >= 80 ? "warn" : "", style: `width:${pct}%` }))),
    h("div", { class: "mandate-foot" },
      h("span", { class: `expiry${st === "active" && left < 60_000 ? " soon" : ""}`, dataset: { expires: m.expiresAt, active: String(st === "active") } },
        st === "active" ? countdown(left) : `${st} · ${clock(m.expiresAt)}`),
      actions),
  );
}

function tickMandates() {
  let changed = false;
  for (const el of document.querySelectorAll(".expiry[data-active='true']")) {
    const left = Date.parse(el.dataset.expires) - Date.now();
    if (left <= 0) changed = true;
    el.textContent = countdown(left);
    el.classList.toggle("soon", left < 60_000);
  }
  if (changed) renderMandates();
}

async function mandateAction(id, action, btn) {
  btn.disabled = true;
  try {
    upsertMandate(await api(`/mandates/${encodeURIComponent(id)}/${action}`, { method: "POST" }));
    toast(action === "revoke" ? "Mandate revoked: zero spending authority for that task" : "Mandate completed");
  } catch (err) {
    if (!(err instanceof AuthError)) toast(`Could not ${action}: ${err.message}`, "bad");
    btn.disabled = false;
  }
}

$("mandate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const body = { task: f.task.value.trim(), allowTransfers: f.allowTransfers.checked };
  if (f.budget.value.trim()) body.budget = f.budget.value.trim();
  if (f.ttl.value) body.ttlSeconds = Math.round(Number(f.ttl.value) * 60);
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  $("mandate-error").hidden = true;
  try {
    const m = await api("/mandates", { method: "POST", body });
    upsertMandate(m);
    $("mandate-new-id").textContent = m.id;
    $("mandate-result").hidden = false;
    f.task.value = "";
  } catch (err) {
    if (!(err instanceof AuthError)) {
      $("mandate-error").textContent = err.message;
      $("mandate-error").hidden = false;
    }
  } finally {
    btn.disabled = false;
  }
});

$("mandate-copy").addEventListener("click", async () => {
  const ok = await copyText($("mandate-new-id").textContent);
  $("mandate-copy").textContent = ok ? "Copied" : "Copy failed";
  setTimeout(() => ($("mandate-copy").textContent = "Copy"), 1500);
});

function setPolicy(p) {
  state.policy = p;
  const f = $("mandate-form");
  if (p?.mandateDefaults) {
    f.budget.placeholder = p.mandateDefaults.budget;
    f.ttl.placeholder = String(Math.round(p.mandateDefaults.ttlSeconds / 60));
  }
}

// ------------------------------------------------------------------ demo vendor control

const FALLBACK_MODES = ["honest", "overcharge", "payee_swap", "price_creep", "slow_drain", "inject"];
const vendor = { online: null, mode: null, modes: FALLBACK_MODES, busy: false };
$("vendor-url").textContent = vendorBase;

async function vendorFetch(method, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  try {
    const res = await fetch(`${vendorBase}/admin/mode`, {
      method, signal: ctl.signal,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function applyVendor(data) {
  vendor.online = true;
  if (typeof data?.mode === "string") vendor.mode = data.mode;
  if (Array.isArray(data?.modes) && data.modes.every((m) => typeof m === "string")) vendor.modes = data.modes;
}

async function pollVendor() {
  if (vendor.busy) return;
  try {
    applyVendor(await vendorFetch("GET"));
  } catch {
    vendor.online = false;
  }
  renderVendor();
}

async function setVendorMode(mode) {
  if (vendor.busy || !vendor.online) return;
  const prev = vendor.mode;
  vendor.busy = true;
  vendor.mode = mode;
  renderVendor();
  try {
    applyVendor(await vendorFetch("POST", { mode }));
    toast(`Vendor mode: ${vendor.mode}`, vendor.mode === "honest" ? undefined : "bad");
  } catch (err) {
    vendor.mode = prev;
    toast(`Could not switch vendor mode: ${err.message}`, "bad");
  } finally {
    vendor.busy = false;
    renderVendor();
  }
}

function renderVendor() {
  const st = $("vendor-status");
  st.dataset.state = vendor.online ? "online" : vendor.online === false ? "offline" : "unknown";
  st.textContent = vendor.online ? "online" : vendor.online === false ? "offline" : "checking…";
  const box = $("vendor-modes");
  box.classList.toggle("offline", vendor.online === false);
  box.replaceChildren(...vendor.modes.map((m) =>
    h("button", { class: "seg", type: "button", "aria-pressed": String(m === vendor.mode), dataset: { mode: m }, disabled: vendor.online === false || vendor.busy, onclick: () => setVendorMode(m) }, m)));
}

// ------------------------------------------------------------------ render loop

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderStats();
    renderApprovals();
    renderLogMeta();
  });
}

function renderAll() {
  renderLog();
  renderStats();
  renderApprovals();
  renderLogMeta();
  renderMandates();
  renderBreaker();
  renderRate();
}

renderAll();
renderVendor();
connect();
pollVendor();
setInterval(() => {
  renderRate();
  renderBreakerAge();
  tickMandates();
  renderStats();
}, 1000);
setInterval(pollVendor, 5000);
