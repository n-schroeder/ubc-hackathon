# Putting the replay online (demo.nschroeder.dev)

The replay is a web page that looks exactly like the firewall dashboard, but plays back the rehearsal run from this afternoon instead of talking to a live firewall. Judges can click through every scene and every decision without installing anything. It has no server, wallet or keys behind it, so nothing on it can spend money.

You don't need to record or export anything: the recording is already in the repo at `docs/rehearsal/raw/` (`ledger.json` holds every decision and `mandates.json` holds the tasks). All 60 payments in it already link to their onchain transaction.

About 10 minutes.

## 1. Build it

In the main checkout (the one with your `.env`):

```bash
npm run build:site
```

It writes a folder called `site/`. Look for this in the output:

```
✔ built site/ (9 files, …)
  14 takes · 78 decisions (60 paid, 18 denied) · $0.066 spent · 60 explorer links
  secret scan: clean (11 .env values + key patterns, 9 files)
```

The secret scan checks every file in `site/` for anything from your `.env`. If it finds anything, it deletes `site/` and stops, so a finished build is safe to upload. That's why you build in the checkout that has the `.env`.

## 2. Look at it locally

```bash
python3 -m http.server -d site 8788
```

Open http://localhost:8788. It opens on the final state of the run. Press **Play from the start**, or click a scene number. Stop the server with Ctrl+C.

## 3. Upload to Cloudflare Pages

1. Log in to the Cloudflare dashboard. Go to **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
2. Give the project a name, e.g. `agent-firewall-replay`. Drag the `site/` folder onto the page and deploy.
3. Cloudflare gives you a `https://<name>.pages.dev` address. Open it and check it looks like step 2.

## 4. Point demo.nschroeder.dev at it

In the Pages project: **Custom domains** → **Set up a custom domain** → enter `demo.nschroeder.dev`.

- If `nschroeder.dev` is already managed by Cloudflare, it sets everything up for you.
- If not, it shows you a CNAME record (`demo` → `<name>.pages.dev`) to add wherever your domain's DNS is.

The address can take a few minutes to start working.

## 5. Later: add the video link

Once the demo video is uploaded, paste its link into `"videoUrl"` in [`packages/firewall/replay/notes.json`](../packages/firewall/replay/notes.json). Then run `npm run build:site` again, and in the Pages project click **Create new deployment** and upload `site/` again. The same steps apply to any other change.

---

## Background (optional)

**Changing the captions:** the text shown for each scene is in `packages/firewall/replay/notes.json`.

**Using a different recording:** `npm run build:site -- --data <folder>`. The folder needs `ledger.json` and `mandates.json`: the firewall's `GET /ledger?limit=1000` and `GET /mandates` responses (header `x-admin-token: $FIREWALL_ADMIN_TOKEN`, port 4020). A payment only gets its explorer link after Circle's Gateway settles it onchain in a batch, about 2 to 16 minutes after the payment, and the firewall fills the link in while it's running. So save the ledger a while after the run, or the build will say some paid rows have no link yet.

**Building on Cloudflare from Git instead of uploading:** build command `npm run build:site`, output directory `site`. That build has no `.env`, so only the generic key-pattern check runs. Uploading a build from your checkout is stricter.

**What's in `site/`:**

| File | What it is |
|---|---|
| `index.html` | The live dashboard's page, plus three lines that load the replay |
| `app.js`, `chart.js`, `util.js`, `styles.css` | The live dashboard's code, copied unchanged |
| `replay.js`, `replay.css` | Plays the recording back in place of the live firewall, and draws the replay bar |
| `replay-data.js` | The recording, trimmed to the fields the dashboard shows |
| `_headers` | Security headers Cloudflare sends with the page (it can't load or call anything outside the site) |

Two things are estimated, because the firewall doesn't record them: when each task was closed (just after its last decision), and when the velocity breaker was reset (just before the next scene, as the demo script does).
