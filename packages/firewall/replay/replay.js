// Static replay layer for the firewall dashboard (site/ only; built by scripts/build-replay.ts).
//
// The dashboard's own code (app.js, chart.js, util.js) runs unchanged. This classic script loads first and
// stands in for the firewall it would talk to:
//   - fetch() answers the admin API (/policy, /ledger, /mandates, /breaker, …) and the demo vendor's
//     /admin/mode from the recording in window.__REPLAY__; every write is refused (read-only),
//   - EventSource plays the recording's decision / mandate / breaker events as the virtual clock passes them,
//   - Date.now() is that virtual clock, so "last 24 h", the spend-rate chart and mandate countdowns read as
//     they did during the run.
// Seeking reloads the page at the new point (the dashboard only ever adds state, it can't rewind).
(() => {
  "use strict";
  const D = window.__REPLAY__;
  if (!D) return;

  const realNow = Date.now.bind(Date);
  const realSetInterval = window.setInterval.bind(window);
  const SPENT = new Set(["approved", "human_approved"]);
  const MODES = ["honest", "overcharge", "payee_swap", "price_creep", "slow_drain", "inject"];
  const SPEEDS = [1, 2, 5];
  const ms = (iso) => Date.parse(iso);
  const micro = (v) => {
    const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(v ?? "").trim());
    return m ? Number(m[1]) * 1e6 + Number((m[2] ?? "").padEnd(6, "0")) : 0;
  };
  const fmt = (u) => {
    const frac = String(u % 1e6).padStart(6, "0").replace(/0+$/, "");
    return `${Math.floor(u / 1e6)}${frac ? `.${frac}` : ""}`;
  };

  // ------------------------------------------------------------------ timeline
  // Play time p runs from 0 to totalP with the recording's quiet stretches (D.skips) cut out; toT maps it to
  // recording time.

  const toT = (p) => {
    let t = D.meta.startAt + p;
    for (const [a, b] of D.skips) if (t >= a) t += b - a; else break;
    return Math.min(t, D.meta.endAt);
  };
  const toP = (t) => {
    let p = t - D.meta.startAt;
    for (const [a, b] of D.skips) if (t >= b) p -= b - a; else if (t > a) p -= t - a;
    return Math.max(0, p);
  };
  const totalP = toP(D.meta.endAt);

  const hash = new URLSearchParams(location.hash.slice(1));
  const at = hash.get("at");
  const startTake = D.takes.find((t) => t.id === at);
  let speed = SPEEDS.includes(Number(hash.get("x"))) ? Number(hash.get("x")) : 2;
  let anchorP = startTake ? toP(startTake.start)
    : at === "start" ? 0
    : /^\d+$/.test(at ?? "") ? Math.min(totalP, Number(at))
    : totalP; // default: the end of the recording, everything on screen
  let anchorReal = realNow();
  let playing = hash.get("play") === "1" && anchorP < totalP;

  const playP = () => (playing ? Math.min(totalP, anchorP + (realNow() - anchorReal) * speed) : anchorP);
  const now = () => toT(playP());
  Date.now = now;

  // ------------------------------------------------------------------ recorded state at time t

  const rowsByMandate = new Map();
  for (const r of D.rows) rowsByMandate.set(r.mandateId, [...(rowsByMandate.get(r.mandateId) ?? []), r]);
  const mandatesById = new Map(D.mandates.map((m) => [m.id, m]));

  function mandateAt(m, t) {
    const spent = (rowsByMandate.get(m.id) ?? []).filter((r) => SPENT.has(r.outcome) && ms(r.at) <= t).reduce((a, r) => a + micro(r.amount), 0);
    const open = m.closedAt ? t < ms(m.closedAt) : m.status === "active";
    return { ...m, status: open ? "active" : m.status, spent: fmt(spent), remaining: fmt(Math.max(0, micro(m.budget) - spent)) };
  }
  const lastAt = (list, t) => { let v; for (const e of list) if (e.at <= t) v = e; else break; return v; };
  const breakerAt = (t) => lastAt(D.breaker, t)?.state ?? { state: "closed" };
  const modeAt = (t) => lastAt(D.vendor, t)?.mode ?? "honest";
  const rowsUntil = (t) => D.rows.filter((r) => ms(r.at) <= t);

  // ------------------------------------------------------------------ fetch: the firewall's API, read-only

  const READ_ONLY = { error: "This is a read-only replay of a recorded run: nothing here can change the firewall or spend." };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function answer(url, method) {
    if (url.pathname === "/admin/mode") return method === "GET" ? json({ mode: modeAt(now()), modes: MODES }) : json(READ_ONLY, 403);
    if (url.origin !== location.origin) return json({ error: "offline replay" }, 503);
    if (method !== "GET") return json(READ_ONLY, 403);
    const t = now();
    const p = url.pathname;
    if (p === "/policy") return json(D.policy);
    if (p === "/breaker") return json(breakerAt(t));
    if (p === "/approvals") return json(rowsUntil(t).filter((r) => r.outcome === "pending_human"));
    if (p === "/services") return json([]);
    if (p === "/ledger") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 1000);
      return json(rowsUntil(t).sort((a, b) => b.seq - a.seq).slice(0, limit));
    }
    if (p === "/mandates") return json(D.mandates.filter((m) => ms(m.createdAt) <= t).map((m) => mandateAt(m, t)));
    let m = /^\/mandates\/([^/]+)$/.exec(p);
    if (m) {
      const md = mandatesById.get(decodeURIComponent(m[1]));
      return md && ms(md.createdAt) <= t ? json(mandateAt(md, t)) : json({ error: "unknown mandate" }, 404);
    }
    m = /^\/intents\/([^/]+)$/.exec(p);
    if (m) {
      const r = rowsUntil(t).find((x) => x.intentId === decodeURIComponent(m[1]));
      return r ? json(r) : json({ error: "unknown intent" }, 404);
    }
    return json({ error: "not found" }, 404);
  }

  window.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), location.href);
    return answer(url, String(init.method ?? req?.method ?? "GET").toUpperCase());
  };

  // ------------------------------------------------------------------ EventSource: the recording as /events

  const sources = new Set();
  class ReplayEventSource extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.onerror = null;
      sources.add(this);
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.emit("hello", { breaker: breakerAt(now()) });
      }, 30);
    }
    emit(type, data) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
    close() { this.readyState = 2; sources.delete(this); }
  }
  window.EventSource = ReplayEventSource;

  // Timeline events in order; for equal times a decision goes out before the mandate update it causes.
  const events = [];
  for (const r of D.rows) events.push({ at: ms(r.at), type: "decision", data: () => r });
  for (const r of D.rows) {
    const md = mandatesById.get(r.mandateId);
    if (md && SPENT.has(r.outcome)) events.push({ at: ms(r.at), type: "mandate", data: (t) => mandateAt(md, t) });
  }
  for (const md of D.mandates) {
    events.push({ at: ms(md.createdAt), type: "mandate", data: (t) => mandateAt(md, t) });
    if (md.closedAt) events.push({ at: ms(md.closedAt), type: "mandate", data: (t) => mandateAt(md, t) });
  }
  for (const b of D.breaker) events.push({ at: b.at, type: "breaker", data: () => b.state });
  events.sort((a, b) => a.at - b.at);

  // app.js polls the demo vendor's mode every 5 s; poll every second here so the vendor panel keeps up.
  window.setInterval = (fn, delay, ...args) => realSetInterval(fn, delay === 5000 ? 1000 : delay, ...args);

  // The dashboard wants an admin token before it connects. There is no firewall here, so any value will do.
  try { sessionStorage.setItem("asf.token", "replay"); } catch { /* storage unavailable */ }

  // ------------------------------------------------------------------ player controls

  function reanchor() { anchorP = playP(); anchorReal = realNow(); }
  function setPlaying(v) { reanchor(); playing = v; render(); }
  function seek(target, autoplay) {
    const h = new URLSearchParams(location.hash.slice(1));
    h.set("at", String(target));
    h.set("x", String(speed));
    if (autoplay) h.set("play", "1"); else h.delete("play");
    location.hash = h.toString();
    location.reload();
  }

  let lastT = now();
  function tick() {
    const t = now();
    for (const e of events) {
      if (e.at <= lastT) continue;
      if (e.at > t) break;
      for (const s of sources) if (s.readyState === 1) s.emit(e.type, e.data(t));
    }
    lastT = Math.max(lastT, t);
    if (playing && playP() >= totalP) setPlaying(false);
    render();
  }

  // ------------------------------------------------------------------ the replay bar

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const safe = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : undefined);
  const timeOf = (t, opts) => new Date(t).toLocaleTimeString("en-GB", { hour12: false, ...opts });
  const usd = (v) => `$${v}`;

  const ui = {};
  function build() {
    const m = D.meta;
    const start = new Date(m.startAt);
    const day = start.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const span = `${timeOf(m.startAt, { hour: "2-digit", minute: "2-digit" })}–${timeOf(m.endAt, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}`;
    const links = [
      safe(m.repoUrl) && el("a", { href: m.repoUrl, target: "_blank", rel: "noopener noreferrer" }, "Source on GitHub ↗"),
      safe(m.videoUrl) && el("a", { href: m.videoUrl, target: "_blank", rel: "noopener noreferrer" }, "Demo video ↗"),
    ];

    ui.play = el("button", { class: "btn btn-primary rp-play", type: "button", onclick: () => (playP() >= totalP ? seek("start", true) : setPlaying(!playing)) });
    ui.speeds = SPEEDS.map((x) => el("button", { class: "seg", type: "button", "aria-pressed": "false", title: `${x}× speed`, onclick: () => { reanchor(); speed = x; render(); } }, `${x}×`));

    // Takes grouped into consecutive runs of the same pass (dry pass, live pass, a later retake…).
    const groups = [];
    for (const t of D.takes) {
      if (groups.at(-1)?.pass !== t.pass) groups.push({ pass: t.pass, label: t.passLabel, takes: [] });
      groups.at(-1).takes.push(t);
    }
    ui.takeBtns = new Map();
    const groupEls = groups.map((g) => el("div", { class: "rp-group", role: "group", "aria-label": g.label },
      el("span", { class: "rp-group-label" }, g.label),
      g.takes.map((t) => {
        const b = el("button", { class: "seg rp-take", type: "button", "aria-pressed": "false", title: `Scene ${t.scene ?? "?"}: ${t.title}${t.retake ? " (retake)" : ""}`, onclick: () => seek(t.id, true) }, t.short);
        ui.takeBtns.set(t.id, b);
        return b;
      })));
    ui.endBtn = el("button", { class: "seg rp-take", type: "button", "aria-pressed": "false", title: "Jump to the end of the recording", onclick: () => seek("end", false) }, "End");

    ui.clock = el("time", { class: "rp-clock" });
    ui.fill = el("div", { class: "rp-fill" });
    ui.track = el("div", {
      class: "rp-track", role: "slider", tabindex: "0", "aria-label": "Position in the recording", "aria-valuemin": "0", "aria-valuemax": "100",
      onclick: (e) => {
        const r = ui.track.getBoundingClientRect();
        seek(Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * totalP), playing);
      },
    }, ui.fill, D.takes.map((t) => el("span", { class: "rp-tick", style: `left:${(toP(t.start) / totalP) * 100}%` })));
    ui.caption = el("div", { class: "rp-caption", "aria-live": "polite" });

    const bar = el("section", { class: "rp", "aria-label": "Replay" },
      el("div", { class: "rp-top" },
        el("span", { class: "rp-badge" }, el("span", { class: "rp-dot", "aria-hidden": "true" }), "Replay"),
        el("p", { class: "rp-what" },
          "A recorded run on ", el("b", null, "Arc testnet"), `, ${day}, ${span}. `,
          "Every decision below really happened, made by the firewall in front of an AI agent",
          m.explorerLinks ? "; paid rows link to their transaction on the Arc explorer. " : ". ",
          "This page is static: no wallet, no keys, nothing here can spend."),
        el("nav", { class: "rp-links" }, links)),
      el("div", { class: "rp-controls" },
        ui.play,
        el("div", { class: "rp-speed", role: "group", "aria-label": "Speed" }, ui.speeds),
        el("div", { class: "rp-takes" }, groupEls, ui.endBtn),
        ui.clock),
      ui.track,
      ui.caption);
    document.body.prepend(bar);

    // Admin controls are hidden by replay.css; say why next to each one.
    const note = (text) => el("p", { class: "rp-note" }, text);
    document.getElementById("breaker-why")?.append(note("On the live dashboard a human resets the breaker here. In this recording the next scene's runner reset it."));
    document.getElementById("approvals-empty")?.after(note(`Approve and Deny only work on the live dashboard. Payments over $${D.policy?.humanApprovalAbove ?? "?"} wait here for a human; none in this run did.`));
    document.getElementById("start-task")?.after(note("A human creates each task's mandate (here, the scene runner did). Creating, completing and revoking mandates is disabled in the replay."));
    document.querySelector(".vendor-url")?.after(note("The mode the scene runner had set on the shady vendor (premium-weather) at this point of the recording. Read-only."));
    render();
  }

  function currentTake(t) {
    let cur;
    for (const tk of D.takes) if (tk.start <= t) cur = tk;
    return cur;
  }

  function captionFor(t) {
    const m = D.meta;
    if (!playing && playP() >= totalP) {
      return [
        el("span", { class: "rp-scene" }, "End of the recording"),
        el("span", null, `${m.rows} decisions: ${m.approved} paid (${usd(m.spent)} in nanopayments), ${m.denied} denied. `),
        el("span", { class: "muted" }, "Press Play to watch it from the start, or pick a scene. Click a row in the decision log to see every check."),
      ];
    }
    const tk = currentTake(t);
    if (!tk) return [el("span", { class: "rp-scene" }, "Starting…")];
    const s = tk.summary;
    const result = [
      s.approved ? `${s.approved} paid (${usd(s.spent)})` : "nothing paid",
      s.denied ? `${s.denied} denied` : null,
    ].filter(Boolean).join(" · ");
    return [
      el("span", { class: "rp-scene" }, `Scene ${tk.scene ?? "?"} · ${tk.passLabel}${tk.retake ? " · retake" : ""}`),
      el("b", { class: "rp-title" }, tk.title),
      el("span", { class: "rp-look" }, tk.look),
      tk.baselineUrl ? el("span", { class: "rp-look" }, `${tk.baseline} `, el("a", { href: tk.baselineUrl, target: "_blank", rel: "noopener noreferrer" }, "the attacker's transaction ↗"), ".") : null,
      tk.note ? el("span", { class: "rp-look rp-live-note" }, tk.note) : null,
      el("span", { class: "rp-result" }, result, s.rules.map((r) => el("code", { class: "rule" }, r))),
    ];
  }

  let lastCaptionKey = "";
  function render() {
    if (!ui.play) return;
    const t = now(), p = playP();
    const atEnd = p >= totalP;
    ui.play.textContent = playing ? "❚❚ Pause" : atEnd ? "▶ Play from the start" : "▶ Play";
    ui.play.setAttribute("aria-label", playing ? "Pause" : "Play");
    ui.speeds.forEach((b, i) => b.setAttribute("aria-pressed", String(SPEEDS[i] === speed)));
    const tk = currentTake(t);
    for (const [id, b] of ui.takeBtns) b.setAttribute("aria-pressed", String(!atEnd && tk?.id === id));
    ui.endBtn.setAttribute("aria-pressed", String(atEnd && !playing));
    ui.clock.textContent = timeOf(t);
    ui.clock.dateTime = new Date(t).toISOString();
    const pct = (p / totalP) * 100;
    ui.fill.style.width = `${pct}%`;
    ui.track.setAttribute("aria-valuenow", String(Math.round(pct)));
    const key = `${atEnd && !playing ? "end" : tk?.id}`;
    if (key !== lastCaptionKey) {
      lastCaptionKey = key;
      ui.caption.replaceChildren(...captionFor(t).filter(Boolean));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
  realSetInterval(tick, 100);
})();
