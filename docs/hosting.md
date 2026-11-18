# Hosting the static replay (demo.nschroeder.dev)

`npm run build:site` turns a recorded demo run into `site/`, a read-only replay of the firewall dashboard. It shows the same page and code as the live dashboard. A small script stands in for the firewall's API, so the recorded decisions play back in order, with scene buttons, captions and speed control. There is no server, wallet or key behind it, and nothing on it can spend. Cloudflare Pages serves the folder as is.

About 10 minutes, start to finish.

## 1. Get the recording

The build reads two files from `docs/rehearsal/`. Both are the firewall's own JSON, saved while it is still running after the rehearsal (TASK-16):

```bash
TOKEN=$(grep ^FIREWALL_ADMIN_TOKEN .env | cut -d= -f2)
curl -s -H "x-admin-token: $TOKEN" 'localhost:4020/ledger?limit=1000' > docs/rehearsal/ledger.json
curl -s -H "x-admin-token: $TOKEN" 'localhost:4020/mandates'          > docs/rehearsal/mandates.json
```

Re-export the ledger **after Gateway has settled the batch** (a few minutes to an hour after the run). Until then, paid rows have no onchain transaction, so the replay can't link them to the explorer. The build prints how many rows have links.

## 2. Build in the main checkout

Build in the checkout that has `.env`. The build scans every file it writes for the values in `.env` (and for key-shaped strings). If anything matches, it deletes `site/` and prints only the env variable's name, never its value. Without `.env` it warns that only the pattern check ran.

```bash
npm run build:site                                   # docs/rehearsal/ → site/
npm run build:site -- --data path/to/run --out site  # another recording
```

Check the output: one take per scene and pass (`dry-2 … live-6`), `secret scan: clean`, and the explorer-link count.

## 3. Preview locally

```bash
python3 -m http.server -d site 8788    # http://localhost:8788
```

It opens on the end state, paused. Press **Play from the start**, or pick a scene button. Click a decision-log row to see every check. Admin actions (approve, reset breaker, vendor mode) are read-only here, and each has a note saying so.

## 4. Publish on Cloudflare Pages

**Direct upload (recommended while the repo is private):**

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
2. Name the project (e.g. `agent-firewall-replay`) and drag in the `site/` folder. Cloudflare gives you a `*.pages.dev` URL. Check it there first.
3. To update it later: rebuild, then **Create new deployment** on the same project and upload `site/` again.

**Or connect Git (once the repo is public):** build command `npm run build:site`, output directory `site`. Cloudflare's build has no `.env`, so only the pattern check runs there. Since the recording is committed and holds no secrets, that's acceptable, but direct upload from the checkout with `.env` is stricter.

`site/_headers` sets a strict Content-Security-Policy (`connect-src 'self'`, no inline scripts, no framing). That's another guarantee the page can't reach a real firewall or vendor.

## 5. Custom domain

Pages project → **Custom domains** → **Set up a custom domain** → `demo.nschroeder.dev`. If `nschroeder.dev` is already on Cloudflare DNS, it adds the CNAME itself. Otherwise add `CNAME demo → <project>.pages.dev` at your DNS host. The certificate takes a few minutes.

## 6. After the video is up

Put the video link in `videoUrl` in [`packages/firewall/replay/notes.json`](../packages/firewall/replay/notes.json), then rebuild and re-upload. An empty `videoUrl` hides the link. The same file holds the captions for each scene and the unsafe-baseline transaction hashes shown in scene 3.

## What's in site/

| File | What it is |
|---|---|
| `index.html` | The live dashboard's `index.html` plus three tags (replay CSS, recording, replay script). The build stops if those anchor lines move. |
| `app.js`, `chart.js`, `util.js`, `styles.css` | Copied unchanged from `packages/firewall/public/` |
| `replay.js`, `replay.css` | The replay layer: a fake `fetch`/`EventSource` over the recording, a virtual clock, and the replay bar |
| `replay-data.js` | The recording: sanitized ledger rows (only the fields the dashboard renders), mandates, policy, breaker and vendor-mode events, takes |
| `_headers` | Cloudflare Pages response headers (CSP, no-referrer, nosniff) |

Two things are estimated, because the firewall doesn't record them: when each mandate was closed (just after its last decision), and when the breaker was reset (1 s before the next scene, as `scripts/demo-scene.ts` does).
