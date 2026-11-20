// Record a shot: drive headless Chrome over CDP, screencast frames, encode a CFR mp4.
// usage: node rec.mjs <shot.json>
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shot = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = resolve(here, "shots", shot.name);
rmSync(out, { recursive: true, force: true }); mkdirSync(resolve(out, "frames"), { recursive: true });

const list = await (await fetch("http://127.0.0.1:9333/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(list.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0; const pending = new Map(); const handlers = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
  else for (const h of handlers) h(msg);
});
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await cdp("Page.enable"); await cdp("Runtime.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

const frames = []; let t0 = null; const events = [];
handlers.push((msg) => {
  if (msg.method !== "Page.screencastFrame") return;
  const { data, metadata, sessionId } = msg.params;
  cdp("Page.screencastFrameAck", { sessionId });
  const ts = metadata.timestamp; if (t0 === null) t0 = ts;
  const f = `frames/${String(frames.length).padStart(6, "0")}.jpg`;
  writeFileSync(resolve(out, f), Buffer.from(data, "base64"));
  frames.push({ f, t: ts - t0 });
});
const now = () => (t0 === null ? 0 : Date.now() / 1000 - wallT0);
let wallT0 = null;
const mark = (label) => { events.push({ t: +now().toFixed(2), label }); console.log(`[${now().toFixed(1)}s] ${label}`); };

async function evalIn(expr, frame) {
  let contextId;
  if (frame) {
    const tree = await cdp("Page.getFrameTree");
    const child = (tree.frameTree.childFrames ?? []).find((c) => c.frame.url.includes(frame));
    if (!child) throw new Error("frame not found: " + frame);
    contextId = (await cdp("Page.createIsolatedWorld", { frameId: child.frame.id, worldName: "rec" })).executionContextId;
  }
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function frameOffset(frame) {
  if (!frame) return { x: 0, y: 0 };
  return evalIn(`(() => { const r = document.querySelector("iframe").getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
}
async function click(sel, frame) {
  const off = await frameOffset(frame);
  const r = await evalIn(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block:"nearest"}); const r = e.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`, frame);
  if (!r) throw new Error("no element " + sel);
  const x = off.x + r.x, y = off.y + r.y;
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(120);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function goto(url) {
  await cdp("Page.navigate", { url });
  for (let i = 0; i < 100; i++) { await sleep(100); const s = await evalIn("document.readyState"); if (s === "complete") break; }
}

const STAGE = "http://127.0.0.1:4030/";
if (shot.start) await goto(shot.start.startsWith("http") ? shot.start : STAGE + shot.start);
await sleep(shot.settle ?? 2500);
await cdp("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
wallT0 = Date.now() / 1000;
mark("start");

for (const s of shot.steps) {
  try {
    if (s.wait) await sleep(s.wait);
    if (s.goto) { mark("goto " + s.goto); await goto(s.goto.startsWith("http") ? s.goto : STAGE + s.goto); }
    if (s.click) { mark("click " + s.click); await click(s.click, s.frame); }
    if (s.eval) { const v = await evalIn(s.eval, s.frame); if (v !== undefined) console.log("eval →", JSON.stringify(v).slice(0, 300)); }
    if (s.run) {
      mark("run " + s.run);
      await fetch(STAGE + "run", { method: "POST", body: JSON.stringify({ cmd: s.run, show: s.show, cols: s.cols ?? 84, rows: s.rows ?? 40 }) });
      await sleep(500);
      for (let i = 0; i < (s.timeout ?? 240) * 4; i++) { const st = await (await fetch(STAGE + "status")).json(); if (!st.running) { mark("exit " + st.last?.exit); break; } await sleep(250); }
    }
    if (s.mark) mark(s.mark);
  } catch (e) { console.error("step failed", JSON.stringify(s), e.message); if (!s.optional) throw e; }
}
await sleep(shot.tail ?? 1500);
mark("end");
await cdp("Page.stopScreencast");
await sleep(300);
const endT = Date.now() / 1000 - wallT0;
writeFileSync(resolve(out, "events.json"), JSON.stringify(events, null, 1));
// concat list with durations (last frame held to the end)
let txt = "";
frames.forEach((fr, i) => { const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(endT, fr.t + 0.04); txt += `file '${fr.f}'\nduration ${(next - fr.t).toFixed(4)}\n`; });
txt += `file '${frames.at(-1).f}'\n`;
writeFileSync(resolve(out, "list.txt"), txt);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "list.txt", "-vf", "fps=30,format=yuvj420p", "-c:v", "mjpeg", "-q:v", "2", "raw.mkv"], { cwd: out });
console.log(`done ${shot.name}: ${frames.length} frames, ${endT.toFixed(1)}s`);
await cdp("Page.close").catch(() => {}); ws.close(); process.exit(0);
