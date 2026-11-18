// Spend-rate chart: one series ($/min over a rolling 60 s window, sampled every second for the last
// five minutes), the policy's per-minute limit as a dashed line, and a marker wherever the breaker tripped.
// Hand-drawn SVG so the dashboard has no third-party code and works offline.
import { h, s, rate, clock } from "./util.js";

const M = { top: 16, right: 10, bottom: 22, left: 46 };

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

export function createSpendChart(root) {
  const svg = s("svg", { "aria-hidden": "true" });
  const gGrid = s("g");
  const area = s("path", { class: "area" });
  const line = s("path", { class: "series" });
  const gLimit = s("g");
  const gTrips = s("g");
  const cross = s("line", { class: "cross", visibility: "hidden" });
  const crossDot = s("circle", { class: "cross-dot", r: 4, visibility: "hidden" });
  svg.append(gGrid, area, line, gLimit, gTrips, cross, crossDot);
  const tip = h("div", { class: "tip", hidden: true });
  root.append(svg, tip);

  let width = root.clientWidth || 400;
  let height = root.clientHeight || 170;
  let last = null;
  let hoverX = null;

  new ResizeObserver(() => {
    width = root.clientWidth || width;
    height = root.clientHeight || height;
    if (last) draw(last);
  }).observe(root);

  svg.addEventListener("pointermove", (e) => {
    hoverX = e.clientX - svg.getBoundingClientRect().left;
    if (last) drawHover(last);
  });
  svg.addEventListener("pointerleave", () => {
    hoverX = null;
    if (last) drawHover(last);
  });

  function geometry(d) {
    const iw = Math.max(10, width - M.left - M.right);
    const ih = Math.max(10, height - M.top - M.bottom);
    const max = Math.max(d.limit * 1.35, ...d.series.map((p) => p.v * 1.12), 1000);
    const step = niceStep(max / 4);
    const yMax = Math.ceil(max / step) * step;
    const t0 = d.now - d.windowMs;
    const x = (t) => M.left + ((t - t0) / d.windowMs) * iw;
    const y = (v) => M.top + ih - (v / yMax) * ih;
    return { iw, ih, step, yMax, t0, x, y };
  }

  function draw(d) {
    last = d;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const g = geometry(d);

    gGrid.replaceChildren();
    for (let v = 0; v <= g.yMax + 1e-9; v += g.step) {
      gGrid.append(
        s("line", { class: "grid", x1: M.left, x2: width - M.right, y1: g.y(v), y2: g.y(v) }),
        s("text", { class: "axis", x: M.left - 8, y: g.y(v) + 4, "text-anchor": "end" }, v === 0 ? "$0" : `$${+(v / 1e6).toFixed(4)}`),
      );
    }
    for (let m = 0; m <= 5; m++) {
      const t = d.now - (5 - m) * 60_000;
      gGrid.append(s("text", { class: "axis", x: g.x(t), y: height - 4, "text-anchor": m === 0 ? "start" : m === 5 ? "end" : "middle" }, m === 5 ? "now" : `−${5 - m}m`));
    }

    const pts = d.series.map((p) => `${g.x(p.t).toFixed(1)},${g.y(p.v).toFixed(1)}`);
    line.setAttribute("d", pts.length ? `M${pts.join("L")}` : "");
    area.setAttribute("d", pts.length ? `M${g.x(d.series[0].t).toFixed(1)},${g.y(0)}L${pts.join("L")}L${g.x(d.series.at(-1).t).toFixed(1)},${g.y(0)}Z` : "");

    gLimit.replaceChildren();
    if (d.limit > 0) {
      const ly = g.y(d.limit);
      gLimit.append(
        s("line", { class: "limit", x1: M.left, x2: width - M.right, y1: ly, y2: ly }),
        s("text", { class: "limit-label", x: M.left + 6, y: ly - 5 }, `limit ${rate(d.limit)}/min`),
      );
    }

    gTrips.replaceChildren();
    // Newest first; a label is skipped when it would collide with the one to its right.
    let lastLabelX = Infinity;
    for (const t of [...d.trips].sort((a, b) => b - a)) {
      if (t < g.t0 || t > d.now) continue;
      const tx = g.x(t);
      const v = valueAt(d.series, t);
      gTrips.append(
        s("line", { class: "trip", x1: tx, x2: tx, y1: M.top, y2: g.y(0) }),
        s("circle", { class: "trip-dot", cx: tx, cy: g.y(v), r: 5 }),
      );
      if (lastLabelX - tx > 110) {
        const flip = tx > width - 100;
        gTrips.append(s("text", { class: "trip-label", x: tx + (flip ? -6 : 6), y: M.top + 2, "text-anchor": flip ? "end" : "start" }, "breaker tripped"));
        lastLabelX = tx;
      }
    }
    drawHover(d);
  }

  function drawHover(d) {
    if (hoverX === null || !d.series.length) {
      cross.setAttribute("visibility", "hidden");
      crossDot.setAttribute("visibility", "hidden");
      tip.hidden = true;
      return;
    }
    const g = geometry(d);
    const t = g.t0 + ((hoverX - M.left) / g.iw) * d.windowMs;
    let best = d.series[0];
    for (const p of d.series) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    const px = g.x(best.t), py = g.y(best.v);
    for (const [k, v] of Object.entries({ x1: px, x2: px, y1: M.top, y2: g.y(0) })) cross.setAttribute(k, v);
    crossDot.setAttribute("cx", px);
    crossDot.setAttribute("cy", py);
    cross.setAttribute("visibility", "visible");
    crossDot.setAttribute("visibility", "visible");
    tip.replaceChildren(h("b", null, `${rate(best.v)}/min`), h("span", { class: "muted" }, ` · ${clock(new Date(best.t).toISOString())}`));
    tip.style.left = `${Math.min(Math.max(px, 70), width - 70)}px`;
    tip.style.top = `${Math.max(py - 8, 24)}px`;
    tip.hidden = false;
  }

  return { draw };
}

function valueAt(series, t) {
  let best = series[0];
  for (const p of series) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best ? best.v : 0;
}
