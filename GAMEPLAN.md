# Gameplan: status audit and next work

*Written 2026-11-18, about 1 PM CST (TASK-13). Deadline **Fri Nov 20, 12:00 PM CST**; target **Fri 11 AM CST**. About 46 hours left.*

This file has two parts:

1. A status report: every section of [`docs/SPEC.md`](docs/SPEC.md) checked against the repo.
2. A prioritized list of proposed cards, for Noah to approve before any agent starts them.

None of the proposed cards have been created on the board. Nothing outside this file was changed.

---

## TL;DR

- **The MVP is built.** All 32 feature boxes (F1–F32) are done and verified at this commit:
  - `npm test` 124/124 (10 files).
  - `npm run typecheck` is clean.
  - `npm run redteam` 21/21 scenarios pass, and 19/19 attacks are stopped with the expected rule.
- **What's left is submission work, not features:**
  - Push the work to GitHub.
  - Rehearse the demo and write the video script.
  - Pick a name.
  - Record the video, make the repo public, fill in Devpost.
- **⚠ Urgent: GitHub is behind.** Local `main` is 11 commits ahead of `origin/main`.
  - The README, TESTING.md, devpost.md, the SPEC reconcile and the explorer-link work exist only locally, or in open PRs #7–#9.
  - TASK-9 and TASK-10 were never pushed at all.
  - If the repo went public now, judges would see the old README.
- **Recommended schedule (CST):**

| When | What | Who |
|---|---|---|
| Wed 1 PM → midnight | **Wave 1**: everything the video and submission need (G1–G8) | agents + 2 decisions from Noah |
| Thu 9 AM → 2 PM | **Wave 2**: optional polish that shows on camera (G9–G10), only if Wave 1 is green | agents |
| **Thu 2 PM** | **Demo freeze**: after this, only fixes found while recording reach `main` | — |
| Thu 2 PM → 9 PM | Final rehearsal, record and edit the video (TASK-11 part 1) | Noah |
| Thu 9 PM → Fri 10 AM | Repo public, recheck from a fresh clone, Devpost form (TASK-11 part 2) | Noah + G8 |
| **Fri ≤ 11 AM** | **Submit on Devpost.** 11–12 is buffer | Noah |
| Any time after the video is recorded | **Wave 3** stretch (G11–G15), on branches; none is needed to submit | agents |

  - The freeze is 7 hours earlier than SPEC §7's "MVP freeze Thu ~9 PM". The MVP is already done, so the freeze now protects recording time.

---

## Part 1: Status report

Legend: ✅ done · 🟡 partial · ❌ missing · ➖ not planned for this submission (stretch, or optional)

### §1 Overview

| Item | Status | Where |
|---|---|---|
| Pitch, "what it is", layer table | ✅ | Used in the README ("The problem", "Architecture") and `docs/devpost.md` |
| Track, award, stack | ✅ | `docs/devpost.md` "Tracks and awards to select", "Built with" |
| A1–A5 "Why Arc" lines | ✅ in text, 🟡 for video | README "How it uses Arc". There is no visual for video scene 8 yet (see G3) |

### §2 Hackathon requirements

| Item | Status | Where / what's missing |
|---|---|---|
| Agent sends transactions or reads the chain | ✅ | README "Live evidence on Arc testnet" (batch tx `0xba85…4915`, baseline tx `0xc12d…0d77`) |
| README documents decision loop + safety limits | ✅ locally, ❌ on GitHub | README "The decision loop", "Safety limits"; `packages/shared/test/readme-limits.test.ts`. **Only in open PR #7 / local `main`** → G1 |
| Core onchain functionality on Arc | ✅ | `packages/firewall/src/signer.ts` `assertArc` (chain id `5042002`) |
| README lists the contracts used + how Arc is used | ✅ locally | README "How it uses Arc" → G1 |
| Name, description, team | 🟡 | Drafted in `docs/devpost.md`. The name isn't decided (§9 item 12) → G2, TASK-11 |
| Track + award + bounties selected on Devpost | 🟡 | Track and award known; bounties not checked → G7, TASK-11 |
| Written answers | ✅ locally | `docs/devpost.md` (TASK-9, **never pushed**) → G1 |
| Technologies / sponsor tools | 🟡 | Drafted in `docs/devpost.md`; still to enter on Devpost → TASK-11 |
| **Public** GitHub repo with source + setup | 🟡 | Setup instructions done (README "Setup", `docs/TESTING.md`). The repo is **PRIVATE** (`gh repo view`, 2026-11-18), and `origin/main` is 11 commits behind → G1, G8, TASK-11. History scanned in this audit: no `.env` file or key-like strings were ever committed |
| Working demo | ✅ | `scripts/demo.ts` (`npm run demo`), `scripts/demo-scene.ts` (`npm run demo:scene -- 2…6`), `scripts/dashboard-dev.ts` (no keys) |
| 2–3 min video | ❌ | Not recorded. There is no script, no stills for scenes 1/7/8, and no rehearsal since the scene runner landed → G3, G4, G5, TASK-11 |
| Architecture overview in README | ✅ locally | README "Architecture" → G1 |

### §3 Architecture

| Item | Status | Where |
|---|---|---|
| §3.1 components (agent, firewall, signer, ledger, vendors, dashboard, red-team, shared) | ✅ | `packages/{agent,firewall,vendors,redteam,shared}`, dashboard in `packages/firewall/public/` |
| §3.2 repo layout | ✅ | Matches. Extra: `docs/TESTING.md`, `docs/devpost.md` |
| §3.3 core types, bigint money | ✅ | `packages/shared/src/types.ts`, `money.ts` (+ `money.test.ts`) |
| §3.4 check pipeline | ✅ | `packages/firewall/src/pipeline.ts`, `checks/index.ts`. Split into `beforeQuote`/`afterQuote` arrays, as SPEC F3 notes |
| §3.5 agent tools (5) + the M7 rules | ✅ | `packages/agent/src/tools.ts`, `agent.ts`, `progress.ts`; `agent.test.ts` |
| §3.6 signer | ✅ | `packages/firewall/src/signer.ts` `CircleWalletSigner`. ➖ `LocalKeySigner` was not needed (M0) |
| §3.7 demo-only pieces (unsafe baseline, shady modes, inject paywall, credulous prompt) | ✅ | `packages/agent/src/unsafe.ts`, `packages/vendors/src/shady.ts`, agent system prompt in `agent.ts` |
| "Room for stretch" seams named in §6 (`MandateStore`, `VendorSource`) | 🟡 | No interfaces exist by those names. Mandates live in the `Store` class (`firewall/src/store.ts`) and the registry comes from `loadRegistry()` (`shared/src/config.ts`). The README and devpost "What's next" say "behind a store interface" / "read through one interface". That's loose but defensible; G6 tightens the wording |

### §4 Problems and solutions

| Problem | Status | Where |
|---|---|---|
| P1 prompt injection | ✅ | `checks/policy.ts`, `checks/escalation.ts`, agent has no keys (`agent/src/env.ts`) |
| P2 x402 blind signing | ✅ | `firewall/src/x402.ts`, `checks/preflight.ts`, `config/registry.json` |
| P3 velocity | ✅ | `checks/velocity.ts`, `checks/breaker.ts` |
| P4 mandates (offchain) | ✅ / ➖ onchain vault | `checks/mandate.ts`, `Firewall.createMandate`. Vault is S4.1 → G11 |
| P5 vendor steering | ✅ piece / ➖ full | `toListing` in `shared/src/config.ts`. ERC-8004 is S5.1 (Devpost "next" answer only) |

### §5 MVP feature list (F1–F32)

| Group | Items | Status | Where |
|---|---|---|---|
| Firewall core | F1–F7 | ✅ | `firewall/src/{server,main,signer,pipeline,store,settlement}.ts`; `core.test.ts`, `checks.test.ts`, `settlement.test.ts` |
| Pre-flight | F8–F12 | ✅ | `config/registry.json`, `firewall/src/x402.ts`, `checks/preflight.ts`, `vendors/src/{honest,paywall,shady}.ts`; `vendors.test.ts` |
| Velocity | F13–F15 | ✅ | `checks/velocity.ts`, `checks/breaker.ts`, `POST /breaker/reset` |
| Mandates | F16–F18 | ✅ | `Firewall.createMandate`, `checks/mandate.ts`, `scripts/lib/task.ts` |
| Sanitization | F19 | ✅ | `shared/src/config.ts` `toListing`, `GET /services` |
| Agent | F20–F22 | ✅ | `agent/src/{agent,tools,unsafe}.ts`; live runs recorded in SPEC M7 |
| Dashboard | F23–F27 | ✅ | `firewall/public/{app,chart}.js`. F27's "start task" creates a mandate but doesn't launch the agent (by design) |
| Red-team | F28–F29 | ✅ | `packages/redteam` (21 scenarios). ➖ optional `redteam:live` not built → G15 |
| Submission | F30–F32 | ✅ locally | README, `.env.example`, `scripts/demo*.ts`, `docs/devpost.md`. Not on GitHub yet → G1 |

Small drift found:
- `docs/TESTING.md` still says "9 files, 115 tests", and so does SPEC §5's reconcile note. TASK-12 raised that to 10 files and 124 tests. TESTING.md is what outside testers compare against → G6.
- F6's "append-only" caveat (two in-place updates) is documented honestly in SPEC. No action.

### §6 Stretch features

| Item | Status | Notes |
|---|---|---|
| S4.1 allowance vault | ❌ | Highest value for the Arc award (a deployed contract), and the highest risk → G11 |
| S2.1 trust-on-first-use | ❌ | → G14 |
| S1.1 explain-this-denial view | ✅ mostly | Clicking a decision-log row expands a table of every check that ran, with rule, detail, **observed · limit**, and "tripped the breaker" (`app.js` `buildChecks`). Only camera polish is left → G9 |
| S1.2 policy as YAML + hot reload | ❌ | Not proposed: editing a limit live on camera is risky for little gain |
| S3.1 breaker half-open cool-down | ❌ | `types.ts` reserves `"half_open"` → G13 |
| S3.2 per-service value scoring | ❌ | Not proposed (agent tool + rule + tests, too much for the time left) |
| S6.1 hash-chained ledger anchored on Arc | ❌ | → G12 |
| S5.1 ERC-8004 trust layer | ➖ | Devpost "What would you build next?" only, as planned |

### §7 Milestones

| Milestone | Status | Where |
|---|---|---|
| M0 spikes | ✅ | `scripts/spikes/*`, SPEC §7 M0 notes |
| M1–M6 | ✅ | packages as above |
| M7 agent | ✅ | Live on Arc, 2026-11-18 (SPEC §7 M7) |
| M8 red-team | ✅ | `npm run redteam` |
| M9 dashboard | ✅ | `packages/firewall/public/` |
| M10 submission | 🟡 | README/TESTING/devpost done locally; not pushed, no video, repo private, Devpost not filled → G1–G8, TASK-11 |

### §8 Demo plan, scene by scene

| # | Scene | Status | Where / gap |
|---|---|---|---|
| 1 | The problem | ❌ | No title card or diagram image for video. The README has an ASCII diagram only → G3 |
| 2 | Happy path | ✅ scripted | `npm run demo:scene -- 2`. **Gap:** nanopayment explorer links appear only after Circle batches the transfer (2–16 min, median ~8.5; SPEC F6). A fresh run shows transfer ids, not links → the video script must pre-warm (G4) |
| 3 | Prompt injection | ✅ scripted | `demo:scene -- 3` (steps `unsafe`, `firewalled`). It runs one step after the other, not split screen, so the split is done in editing (G4), or G10 |
| 4 | Lying vendor | ✅ scripted | `demo:scene -- 4` (`payee_swap`, `price_creep`) |
| 5 | Runaway loop | 🟡 | `demo:scene -- 5` trips the breaker. **Mismatch:** §8's caption is `VELOCITY $0.052/min > $0.05/min`, but premium-weather costs $0.001/call. The per-minute rule would need 50+ calls a minute; `velocity.no_progress` (10 paid calls, no progress, see `agent/src/progress.ts`) or `velocity.duplicate` fires long before that. On the chart, the rate line stays far below the dashed limit. Needs a rehearsal and a caption decision → G4, G5 |
| 6 | Task ended | ✅ scripted | `demo:scene -- 6` |
| 7 | Tested, not prompted | ✅ | `npm run redteam` output is screenshot-ready |
| 8 | Why Arc | ❌ | No visual → G3 |
| — | Narration / shot list / timing to 2:30 | ❌ | → G4 |
| — | Live dress rehearsal since the scene runner landed | ❌ | No record of scenes 2–6 run back to back live → G5 |

### §9 Needed from you

| # | Item | Status |
|---|---|---|
| 1–3 | Circle account, testnet USDC, Anthropic key | ✅ |
| 4 | GitHub access | ✅ (`gh` logged in). Making the repo public → TASK-11 |
| 5 | Foundry | ➖ only if G11 is approved |
| 6–11 | Policy numbers, tolerance, unknown services, breaker numbers, P2 in MVP, demo task | ✅ accepted 2026-11-17 (item 9 said the demo would lower thresholds so the breaker trips on camera. That was never done; see G5) |
| 12 | **Project name** | ❌ **open** → G2 |
| 13 | Office-hours questions | 🟡 Q1–Q2 answered by the M0 spikes; Q3–Q5 still open (only matter for the "next" answer) |
| 14 | Record the video | ❌ → TASK-11 |
| 15 | Submit on Devpost | ❌ → TASK-11 |
| 16 | Closing ceremony Sat | planned |

### §10 Engineering rules (spot-checked)

| Rule | Status | Evidence |
|---|---|---|
| 1 Agent never loads credentials | ✅ | `agent/src/env.ts` `assertNoCredentials`, `agent.test.ts`, red-team scenario |
| 2 bigint money | ✅ | `shared/src/money.ts`, `money.test.ts` |
| 3 Every decision logged | ✅ | `store.ts` ledger, denials included |
| 4 Every guardrail has a red-team test | ✅ | 19 attack scenarios, each asserting its rule id |
| 5 Fail closed | ✅ | `core.test.ts` "fails closed when a check throws", "…when the vendor's 402 can't be read" |
| 6 Testnet only | ✅ | `signer.ts` `assertArc` |
| 7 No secrets in git | ✅ | `.gitignore` has `.env`; this audit scanned all of history for `.env` files and key-like strings and found none |
| 8 Verify SDK details | ✅ | Spikes in `scripts/spikes/` |
| 9 Keep the spec current | ✅ | TASK-10 reconcile; small drift noted above → G6 |

### §11 Glossary

✅ No action.

---

## Part 2: Proposed cards (for Noah to approve)

Each card is small enough for one agent session. "⚠ RISK" marks anything that could endanger recording or submission. Effort is a rough estimate of agent time.

### Wave 1: Wed afternoon and night. Everything the video and submission need

**G1. Sync GitHub with local `main`** · priority **high** · covers §2 (public repo, README requirements), F30–F32 · deps: none · ~10 min
Local `main` is 11 commits ahead of `origin/main` and 0 behind, so pushing is a plain fast-forward. GitHub should then show PRs #7 (TASK-7), #8 (TASK-8) and #9 (TASK-12) as merged, because their branches will be contained in `main`. TASK-9 (devpost.md), TASK-10 (SPEC reconcile) and this TASK-13 land too. After the push, check that `origin/main` has `README.md` "Safety limits", `docs/devpost.md` and `docs/TESTING.md`.
*Needs Noah:* it pushes to `main`, and your workflow is that you merge. Either run `! git push origin main` from the main checkout yourself, or approve an agent doing it. Do this before any card below opens a PR against `main`.

**G2. Decide the project name, then rename** · priority **high** · covers §2 (project name), §9 item 12 · deps: Noah's decision · ~20 min after the decision
Noah picks a name. `docs/devpost.md` has options at the top: *Agent Spending Firewall*, *Fuse*, *Mandate*, *Paywall Firewall*, *Second Signature*. If the name changes, an agent updates:
- the README title and first paragraph,
- the SPEC title,
- `docs/devpost.md`, `docs/TESTING.md`,
- the dashboard `<title>` and `<h1>` (`packages/firewall/public/index.html`),
- and the `banner`/log strings that print the name.

It leaves package names (`@asf/*`) alone. `npm test` must stay green.
Decide by Wed evening: G3's stills show the name, and so does the recording.

**G3. Video stills for scenes 1 and 8 (and a title card)** · priority **high** · covers §8 scenes 1 and 8, A1–A4 · deps: G2 (for the name; it can start with a placeholder) · ~1.5 h
A single static HTML page (`docs/video/stills.html`, no build, open locally) with full-screen cards that Noah screen-records:
1. Title card: name and one-line pitch.
2. The problem. A paraphrase of the Bankr/Grok incident with a source line, not a fake headline screenshot, plus "the agent's authority *is* the wallet's authority."
3. A diagram: agent (no keys) → firewall checks → signer → Arc / Gateway, with the four attacks marked where they're stopped.
4. "Why Arc": A1 USDC is gas, A2 one-block finality, A3 two fuses (Gateway deposit plus firewall), A4 batching makes pre-signing the only checkpoint.

Keyboard arrows step through the cards. Readable at 1080p.

**G4. Video narration script and shot list** · priority **high** · covers §8 (all scenes), §2 video · deps: none (fold in G5's findings when they land) · ~1 h
Write `docs/video-script.md`, timed to 2:30 (about 350–380 spoken words). For each §8 scene it gives:
- what's on screen,
- the exact command (`npm run demo:scene -- N [--dry]`),
- the words to say,
- the on-screen rule text to point at,
- the target seconds.

It also includes:
- **A pre-record checklist:**
  - check the Gateway balance (`npm run wallets:balances`) and the Anthropic credit,
  - run scene 2 about 15 minutes before recording so its explorer links have settled,
  - set the vendor to honest and reset the breaker,
  - set the browser zoom, use a clean terminal, set `NO_COLOR` or not.
- **When to use `--dry` versus the live model.** The live model declines the scam about 3 times in 5 (SPEC M7), so the plan is to record live takes until one works, with `--dry` as the fallback.
- **How to stitch scene 3 side by side** in editing.
- **A fix to the scene 5 caption** so it matches the rule that actually fires (see G5).

Don't change code.

**G5. Live dress rehearsal on Arc testnet** · priority **high** · covers §8 scenes 2–6, F31 · deps: G1 (rehearse what's on `main`) · ~1 h
Run `npm run demo`, then scenes 2–6 back to back, once with `--dry` and once live. Record in `docs/rehearsal.md`:
- which rule fired in each step,
- run times,
- how long the explorer links took to appear,
- Gateway balance before and after,
- Anthropic cost,
- any rough output that would look bad on camera.

Specifically settle scene 5: which rule trips (`no_progress`/`duplicate` versus `per_minute`), and whether the spend-rate chart reads well. Then propose one of:
- (a) keep the rule that fires and fix the §8 caption (recommended: "paid 10 times, learned nothing" is the stronger story), or
- (b) a demo-only `config/policy.demo.json` override with a lower `perMinute`. That's a code change, ⚠ RISK, so open a separate card.

Fix only script copy and typos. File cards for anything else.
*Needs Noah's OK:* it moves testnet funds. Expect about 0.05 USDC of Gateway nanopayments, plus 0.05 USDC paid to the attacker by each `unsafe` take, and about $0.20–0.30 of Anthropic credit. The agent's worktree also needs the main checkout's `.env` (symlink it; never copy it into git).

**G6. Fix doc drift before going public** · priority **medium** · covers §2 (repo), F30, F32, §10 rule 9 · deps: G1 · ~20 min
- `docs/TESTING.md`: "9 files, 115 tests" → the current numbers (10 / 124).
- SPEC §5's reconcile note: update the same counts.
- README and devpost "What's next": change "behind a store interface" / "read through one interface" to what's true (the `Store` class; `loadRegistry()`), or name the interface that would be added.
- SPEC §6 "Room in the MVP" for S4.1 and S5.1: same correction.

Docs only. `npm test` green (the readme-limits test reads the README).

**G7. Check Devpost for extra bounties** · priority **medium** · covers §2 ("any bounties selected") · deps: none · ~20 min
Read the hackathon's Devpost prizes and rules pages (ubc-hackathon-2026.devpost.com). For each prize this project could qualify for, list its requirements and whether we meet them. Update `docs/devpost.md` "Tracks and awards to select". Flag any requirement that needs Noah: an extra form field, a sponsor-specific tag or video mention, an extra repo item. If a bounty needs work, propose a card. Don't build it.

**G8. Fresh-clone check against GitHub** · priority **high** · covers §2 (public repo with setup instructions) · deps: G1, G6 · ~30 min, then 10 min again on Friday
Run it now with `gh repo clone` (works while private):
- clone into a scratch dir and follow `docs/TESTING.md` Level 1 and Level 2 word for word,
- check every relative link in the README, TESTING and devpost (files exist),
- check every explorer and Circle API link responds.

Fix anything broken (docs only). Re-run the quick version right after Noah makes the repo public (Thu night or Fri morning), logged out (`git clone https://…`). That second run confirms judges can see it.

### Wave 2: Thu 9 AM → 2 PM CST. Optional polish for the camera (merge only if green and rehearsed by the 2 PM freeze)

**G9. Make denials readable on camera (S1.1 polish)** · priority **low** · covers S1.1, judging "product & UX", §8 scenes 3–6 · deps: G1, G5 (only if the rehearsal shows denials are hard to read on video) · ~1 h · ⚠ RISK (low): it changes the dashboard that's on camera
The check table already exists, but you have to click to open it. Options:
- auto-expand the newest denied row,
- highlight the check that decided it,
- make the rule and the observed vs. limit large enough to read at 1080p.

UI only (`packages/firewall/public/`), no API change. Before merging, re-run scenes 3–6 against it. If it isn't merged by the 2 PM freeze, drop it.

**G10. Side-by-side scene 3** · priority **low** · covers §8 scene 3 ("split screen") · deps: G4 (only if the script says editing can't do it) · ~1 h · ⚠ RISK (low)
Let `demo:scene -- 3 --only unsafe` and `--only firewalled` run at the same time in two terminals. Today each step resets the shady vendor to `honest` when it ends, which would cut off the other step mid-run. For example, add a `--keep-mode` flag, or reset only when the scene started the mode. Skip this card if G4 decides to stitch scene 3 in editing.

### Wave 3: stretch, only after the video is recorded. Nothing here is needed to submit

These follow SPEC §6's rule: start only after the demo is recorded. Each one builds on its own branch and merges only if `npm test` and `npm run redteam` stay green. If any of them isn't done by **Fri 9 AM**, it stays unmerged and is mentioned only in "What's next".

**G11. Onchain allowance vault on Arc (S4.1), standalone** · priority **medium (Noah's call)** · covers S4.1, P4 onchain, "Best use of Arc" · deps: video recorded; Foundry (§9 item 5) · ~half a day · ⚠ RISK (high if wired into the payment path)
The only stretch that adds a **deployed contract address** for the Arc award. To keep it safe, build it **beside** the demo path, not in it:
- a ~50-line Solidity vault with `open(mandateId, budget)` / `close(mandateId)`,
- Foundry tests,
- a deploy script for Arc testnet,
- a script that opens and closes one mandate onchain,
- the address and tx links in the README "How it uses Arc".

Wiring it into `Firewall.createMandate` is a later card, not this one.
*Needs Noah:* installing Foundry, and moving testnet USDC to fund the vault.

**G12. Hash-chained ledger, anchored on Arc (S6.1)** · priority **low** · covers S6.1, F6 · deps: video recorded · ~3 h · ⚠ RISK (medium): touches the `store.ts` schema
Each ledger row stores `prevHash`. Add a `npm run ledger:verify`, and a script that anchors the latest hash on Arc in one tx (a 0-value self-transfer with the hash in calldata, or a tiny contract). Add the README evidence row. Red-team: a tampered row fails verification.

**G13. Breaker auto cool-down (S3.1)** · priority **low** · covers S3.1, F15 · deps: video recorded · ~1.5 h · ⚠ RISK (medium): changes the breaker the video shows
`open → half_open` after a timeout. Half-open allows a trickle; a trip in half-open re-opens it. Add tests, and a red-team scenario for re-tripping.

**G14. Trust-on-first-use for new services (S2.1)** · priority **low** · covers S2.1, P2 · deps: video recorded · ~2 h · ⚠ RISK (medium): changes a pipeline rule's outcome
`preflight.unknown_service` → escalate. Approving it pins price and `payTo` in the registry (status `pinned`). Add tests, and a red-team scenario asserting the second call to a swapped payee is still denied.

**G15. `redteam:live` (F29 optional)** · priority **low** · covers F29 · deps: video recorded · ~1 h
Run 2–3 scenarios through the real agent: injection, payee swap, late payment. Report the rule hit, accepting "model declined" as a pass-with-note. Costs Anthropic credit.

### Not proposed, and why

- **S1.2 YAML policy + hot reload:** editing limits live on camera adds risk and shows nothing new.
- **S3.2 value scoring:** a new agent tool plus a rule plus tests is too much for the time left. The "no progress" rule already catches the slow drain.
- **S5.1 ERC-8004:** first needs confirmation that registries exist on Arc testnet (§9 item 13 Q5). It stays the "next" answer.
- **`LocalKeySigner`:** M0 made `CircleWalletSigner` work; a second signer adds nothing to the demo.

---

## Recommended order

1. **Now (Noah):** approve the cards. Decide G1 (push `main`) and G2 (the name), and give the OK for G5's testnet spend.
2. **Wed afternoon (agents, in parallel):** G1 → then G3, G4, G6, G7 at the same time; G5 once G1 is in.
3. **Wed night:** G8. Fold G5's findings into G4. G2's rename once the name is decided.
4. **Thu morning:** G9 and G10, only if the rehearsal and script call for them. **Freeze at 2 PM.**
5. **Thu 2–9 PM (Noah, TASK-11):** final rehearsal with G4's checklist, record, edit, upload.
6. **Thu night → Fri 10 AM (Noah, TASK-11):** make the repo public, G8 quick re-run, fill in Devpost from `docs/devpost.md`, add the video link. **Submit by 11 AM.**
7. **Only if time is left after recording:** Wave 3, each on its own branch. Nothing from Wave 3 merges after Fri 9 AM.
