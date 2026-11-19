# Demo video: script, shot list and pre-record checklist

This covers SPEC §8 (the demo plan) and the §2 requirement for a 2–3 minute video on YouTube or Google Drive.

**Target: 2:30, about 375 spoken words** (2.5 words a second, a calm pace). Record one take per scene and stitch them. The dashboard is on screen in every scene except 1, 7 and 8.

> **Name.** The narration says *Agent Spending Firewall*, the working name; the final name is still open (SPEC §9 item 12). If it changes, change it in scene 1's title card and scene 8's last line.
>
> **Dress rehearsal.** The rules and on-screen texts below come from the code and from `npm run redteam`. The rehearsal on Arc testnet is written up in [`rehearsal.md`](rehearsal.md): use its measured step times, its "Rough edges seen on camera" and its "Before recording" list alongside this script.

---

## Setup on screen

| Window | What | On camera? |
|---|---|---|
| Terminal 1 | `npm run demo` (firewall + dashboard + vendors). It prints the dashboard link. | **No.** Start it before you record. |
| Terminal 2 | `npm run demo:scene -- N …` | Yes, scenes 2–6 |
| Browser | The dashboard at `http://127.0.0.1:4020/`. The page removes `#token=…` from the address bar, so it's safe to show. | Yes, scenes 2–6 |
| Browser tab 2 | Arc testnet explorer (explorer.testnet.arc.io), opened from links | Scenes 2 and 3 |
| Stills | `docs/video/stills.html` (title, problem, diagram, why Arc) | Scenes 1 and 8 |
| Terminal 3 | `npm run redteam` | Scene 7 |

Layout for scenes 2–6: dashboard on the left (about two-thirds of the width), terminal 2 on the right. Or record full-screen dashboard and terminal separately and cut between them. The terminal's `firewall decisions for this task:` block, printed at the end of each step, is the cleanest close-up of the rule.

---

## Shot list and narration

Times are targets: they add up to 2:30. Words in **bold** are what to stress.

### 1. The problem · 0:00–0:18 (18 s)

- **On screen:** the stills page. The problem card (paraphrase of the incident, with its source line), then the diagram: agent (no keys) → firewall checks → signer → Arc / Gateway.
- **Command:** none.
- **Point at:** "the agent's authority *is* the wallet's authority", then the firewall box in the diagram.
- **Say (47 words):**
  > In May, a prompt injection written in Morse code drained about a hundred and fifty thousand dollars through an AI agent's wallet. The problem: the agent's authority *is* the wallet's authority. So we took the keys away. The agent **asks**. A firewall **decides**, and only then signs.

### 2. Happy path · 0:18–0:40 (22 s)

- **On screen:** dashboard. Rows arrive in the decision log as `x402 … approved`; the **Task mandates** budget bar fills; the spent stat ticks up. End on a row with an `Explorer 0x… ↗` link, click it, and show the batch tx on the explorer for a second.
- **Command:** `npm run demo:scene -- 2` (live or `--dry`, either works: no scam involved).
- **Explorer links:** a fresh run shows `Gateway <id>` in the proof column, not a link, because Circle batches nanopayments onchain 2–16 minutes later (SPEC F6). Use the rows from the **pre-warm run** (see the checklist) for the click. They are in the same log, a few rows down.
- **Point at:** `✓ 7/7 checks passed` in an expanded row; the mandate's budget bar.
- **Say (52 words):**
  > Here's the agent planning a picnic in three cities. Every forecast and air-quality reading is a **real nanopayment on Arc**, a tenth of a cent, paid through Circle Gateway. Each one passes **seven checks** before it's signed. The task's budget ticks down, and every payment links to its settlement on Arc.

### 3. Prompt injection (P1) · 0:40–1:05 (25 s)

- **On screen:** split screen, built in editing (see [Scene 3 in editing](#scene-3-side-by-side-in-editing)).
  - **Left, WITHOUT:** terminal 2 running the `unsafe` step. The agent pays `0.05` to the attacker; its `← send_payment` result line carries the explorer link. Cut to the explorer tab showing the 0.05 USDC transfer to `0xATTACKER`.
  - **Right, WITH:** the dashboard during the `firewalled` step. A red `transfer 0.05 → 0x…` row with `denied`, then green rows from `weather-api` as it falls back.
- **Command:** `npm run demo:scene -- 3` (plays `unsafe`, then `firewalled`). Retakes: `--only unsafe` or `--only firewalled`.
- **Point at (right):** `policy.recipient_not_allowed` and `recipient 0x…… is not on the allowlist`.
- **Say (65 words):**
  > Now, prompt injection. A vendor withholds its data until we send a five-cent "access fee" to an attacker. On the left, the same agent holding its own key. It **pays**: there's the transfer on Arc. On the right, firewalled. Same agent, same task, same scam. It tries, and it's **denied: recipient not on the allowlist**. It falls back to the honest vendor and finishes.

### 4. Lying vendor (P2) · 1:05–1:27 (22 s)

- **On screen:** dashboard. The **Demo vendor** panel switches to `payee_swap`, and a red row appears; then it switches to `price_creep`, one green row, and a red row.
- **Command:** `npm run demo:scene -- 4` (plays `payee_swap`, then `price_creep`).
- **Point at:**
  - `preflight.payto_mismatch`: `payTo 0x…… ≠ pinned 0x…… for premium-weather`
  - `preflight.price_drift`: `price $0.00125 is more than +20% over the last paid $0.001 for premium-weather`
  - Note: §8's caption says "price exceeds +50% band" (`preflight.price_out_of_band`). With price creep the **drift** rule fires first: the 25% raise is still inside the band. The narration below says what actually fires.
- **Say (53 words):**
  > Vendors can lie too. Most x402 clients sign whatever the payment request says. Here, premium-weather quotes the right price but **swaps in the attacker's address**: denied, it doesn't match the pinned payee. Then it **raises its price** twenty-five percent a call: denied, price drift. All of it checked **before** the signature.

### 5. Runaway loop (P3) · 1:27–1:52 (25 s)

- **On screen:** dashboard. A run of green `premium-weather $0.001` rows (pages 1, 2, 3, …), then a red row, and the **Circuit breaker** panel flips from `CLOSED` to `OPEN` with its rule and detail. Then click **Reset breaker** on camera; the panel goes back to `CLOSED`.
- **Command:** `npm run demo:scene -- 5`. It leaves the breaker open on purpose for the human reset.
- **Which rule fires:** at $0.001 a call the per-minute rule ($0.05/min) would need 50+ calls a minute, so it doesn't fire. The pages differ (`&page=2`, `&page=3`, …), so `velocity.duplicate` doesn't fire either. What fires is **`velocity.no_progress`**. The agent harness counts distinct resources bought, ignoring page parameters (`packages/agent/src/progress.ts`), so after the first page every page reports the same progress. With `noProgressLimit` 10, the breaker trips on the 12th call, after 11 paid ($0.011):
  - `velocity.no_progress`: `11 paid calls in a row added nothing new to the task (still 1 resource bought); limit 10`
  - A live model that re-requests the *same* page instead trips **`velocity.duplicate`** (`6 identical requests (premium-weather/…) within 60s; limit 5`). If that's the take you use, swap the alternate line below.
- **Don't point at the spend-rate chart.** The rate peaks around $0.011/min, far below the dashed $0.05/min line, so it doesn't "climb to the limit". Point at the breaker panel.
- **Say (56 words):**
  > Death by a thousand nanopayments. This vendor says "call again for page two", forever. Each call is a tenth of a cent, under every cap. But the firewall watches **progress**, not just dollars: the agent **paid ten more times and learned nothing new**. The breaker trips, all spending stops, and only a **human** can reset it.
  - *Alternate (`velocity.duplicate` take):* "…the agent **bought the same page six times in a minute**. The breaker trips…"

### 6. Task ended (P4) · 1:52–2:07 (15 s)

- **On screen:** the mandate in **Task mandates** goes from active to closed (the panel empties to "No active mandate: the agent has zero spending authority"). Then the terminal shows the late `send_payment` and `call_paid_api` tries, and two red rows appear on the dashboard.
- **Command:** `npm run demo:scene -- 6`.
- **Point at:** `mandate.none_active`: `mandate … is completed: zero spending authority`, and the empty-panel text.
- **Say (33 words):**
  > When the task ends, so does its authority. The task finishes, its mandate closes, and a late instruction tries to pay the attacker anyway. **Denied: no active mandate.** Zero spending authority, by default.

### 7. Tested, not prompted · 2:07–2:17 (10 s)

- **On screen:** terminal 3, `npm run redteam`, scrolled so the P1–P4 groups and the summary line show.
- **Command:** `npm run redteam` (no keys, about 0.3 s).
- **Point at:** `23/23 scenarios pass · 21/21 attacks stopped with the expected rule`.
- **Say (31 words):**
  > Every attack you just saw is also a red-team test: nineteen attacks, nineteen stopped, each by the rule we expect. Guardrails are **code with tests**, not prose in a prompt.

### 8. Why Arc · 2:17–2:30 (13 s)

- **On screen:** the "Why Arc" still (A1–A3), then the title card for the last second.
- **Command:** none.
- **Point at:** each line as it's said.
- **Say (37 words):**
  > Why Arc? **USDC is gas**, so every budget is in one unit. **One block is final**, so "spent" means spent. And the Gateway deposit is the **hard fuse**; the firewall is the soft one. Agent Spending Firewall.

**Total: about 374 words.** Read it aloud against a timer once before recording. If it runs long, cut from scene 2 first ("and every payment links to its settlement on Arc") and scene 3 ("It falls back to the honest vendor and finishes").

---

## Live model vs. `--dry`

The firewall's decisions are the same either way. What changes is whether the agent *tries* the bad thing.

- **Live (default):** real Claude. In M7's five live injection runs it paid or tried to pay in 2 and declined in 3 (SPEC M7). It can also stop following pages in scene 5, or skip premium-weather in scene 4. The runner says so when it happens: `⚠ the model didn't try to pay the access fee this time…`.
- **`--dry`:** a scripted model (`packages/agent/src/dry.ts`). It always goes for the bait. The firewall, the vendors and the payments are still real. No Anthropic credit.

**Plan:**
1. Scenes 2 and 6: live. They don't depend on the model taking bait.
2. Scenes 3, 4 and 5: record **live takes first**, up to 3 per step. Use the first take where the runner prints `✅ blocked as expected`.
3. If no live take works after 3 tries, record with `--dry`.
4. **Be honest about `--dry` on screen.** Leave the runner's `model: SCRIPTED (--dry)` line visible in the terminal shot, or add a lower-third: "scripted agent · real firewall, real payments". Don't say "Claude decided to pay" over a `--dry` take. The narration above never names the model, so it works for both.
5. Scene 3's `unsafe` step needs the agent to pay too. A live take that declines is the honest "sometimes the model catches it" case, but the video needs the paying one: same plan, `--only unsafe` and `--dry` if needed.

Each live scene costs about $0.03 of Anthropic credit (SPEC M7). Budget about $1 for retakes.

---

## Scene 3 side by side in editing

The runner plays `unsafe` and then `firewalled`, one after the other: each step resets the shady vendor to `honest` when it ends, so running them in two terminals at the same time would break the second one. So the split screen is built in the editor (G10 is not needed).

1. Record the `unsafe` step: terminal 2 full-screen, then switch to the explorer tab when the transfer link prints. Command: `npm run demo:scene -- 3 --only unsafe`.
2. Record the `firewalled` step: dashboard plus terminal 2. Command: `npm run demo:scene -- 3 --only firewalled`.
3. In the editor, put the clips side by side (left: unsafe, right: firewalled), each cropped to about 960 px wide. Label them **WITHOUT FIREWALL** (red) and **WITH FIREWALL** (green) at the top.
4. Line up the two "decision" moments: the attacker transfer link on the left and the red `denied` row on the right should land on the same beat ("…and it's denied"). Speed up the model's thinking time in both clips (2–4×) so the scene fits 25 s; don't speed up the payment or the denial.
5. If the split is too cramped to read, fall back to a hard cut: 10 s of WITHOUT, then 15 s of WITH, with the same labels.

---

## Pre-record checklist

Do this in order, about 30 minutes before recording.

**Code and config**
- [ ] On `main`, up to date. `npm ci` and `npm test` pass.
- [ ] `.env` has `FIREWALL_ADMIN_TOKEN` and `ANTHROPIC_API_KEY`, plus the Circle and baseline values from `wallets:setup`.

**Funds and credit**
- [ ] `npm run wallets:balances`. Firewall wallet: some onchain USDC for gas. Baseline wallet: at least `0.05 × (unsafe takes) + gas`, say 0.5 USDC.
- [ ] Gateway balances (nanopayments come out of these, not the wallet). Use the `curl … /v1/balances` command in `docs/TESTING.md` § "Gateway balances", with the firewall address and the baseline address (`BASELINE_ADDRESS` in `.env`) as depositors. Firewall ≥ 0.5 USDC; baseline ≥ 0.1. Top up with `npm run spike:pay` / `npm run baseline:deposit` if low.
- [ ] Anthropic console: at least $1 of credit.

**Start and pre-warm (T–15 min)**
- [ ] Optional: start on a fresh ledger so the log shows only today's runs, without deleting the old one: `FIREWALL_DB=data/video.db npm run demo` (terminal 1, off camera). Use the same `FIREWALL_DB` for the whole session.
- [ ] Open the printed dashboard link. Check that the connection dot is green and the address bar shows no token.
- [ ] **About 15 minutes before recording scene 2, run `npm run demo:scene -- 2` once (pre-warm).** Its rows show `Gateway <id>` at first and turn into `Explorer 0x… ↗` links as Circle batches them (2–16 min, median about 8.5; SPEC F6). Keep terminal 1 running. If you restart it, the settlement watcher picks unsettled rows back up. Don't start recording scene 2 until at least one pre-warm row has its explorer link.

**Reset state between scenes**
- [ ] **Demo vendor** panel shows `honest`. The runner resets it after every step, even on Ctrl-C; if it's stuck, click `honest` in the panel.
- [ ] **Circuit breaker** shows `CLOSED`. After scene 5, click **Reset breaker** (on camera, as part of the scene). Scene 6 resets it anyway if you forget.

**Screen**
- [ ] Recording at 1920×1080. Browser full-screen (F11), zoom about 125% so rule names are readable; bookmarks bar hidden; other tabs closed. Dark or light theme, the same in every scene (`#theme=dark` in the dashboard link pins it).
- [ ] Terminal: a clean profile, font 18–20 pt, at least 120 columns so the decision lines don't wrap, short prompt, `clear` before each take. Keep colours on (red/green denials read well); use `NO_COLOR=1` only if your theme makes them hard to read.
- [ ] Notifications off (Do Not Disturb). Nothing on screen shows `.env`, terminal 1, or the dashboard link with its token.
- [ ] Mic check: read scene 1 aloud and play it back.

**After recording**
- [ ] Put the vendor back to `honest` and close the breaker.
- [ ] Upload to YouTube (unlisted) or Google Drive (anyone with the link can view), and check the link in a private window.
