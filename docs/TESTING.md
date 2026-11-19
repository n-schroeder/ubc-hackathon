# Testing the Agent Spending Firewall

There are three ways to check this project. Pick the one that matches what you have:

| Level | You need | Time | What it proves |
|---|---|---|---|
| [1. No keys at all](#level-1-no-keys-at-all) | Node.js and npm | ~2 min | Every check in the firewall, the 21 red-team attacks, the agent loop and the vendors, all run offline against a scripted rig. Plus a live dashboard with fake payments. |
| [2. Read the chain](#level-2-read-the-chain-no-install) | A browser (or `curl`) | ~5 min | Real activity on Arc testnet: the firewall wallet, its Gateway deposit, 44 nanopayments settled by Circle in batches, and the unsafe baseline paying the attacker. |
| [3. Full live run](#level-3-full-live-run) | Circle testnet API key + entity secret, testnet USDC from the faucet, Anthropic key (optional) | ~30 min | The whole demo, end to end, with your own wallets on Arc testnet. |

Everything is testnet only. No real money is involved at any level.

**Node.js version:** 22.13 or later, 24, or 26 (developed on 24; there's an `.nvmrc`). Node 22.12 and earlier fail: the ledger uses the built-in `node:sqlite` module, which Node 22 only ships without a flag from 22.13.

---

## Level 1: No keys at all

```bash
git clone https://github.com/n-schroeder/ubc-hackathon.git
cd ubc-hackathon
npm ci
npm test
npm run redteam
```

No `.env`, accounts, API keys or network access beyond `npm ci` are needed. Nothing is written outside `node_modules/`.

**What you should see:**

- `npm test` → `Test Files 13 passed (13)`, `Tests 164 passed (164)`, in about a second. This covers the money maths, config loading, every firewall check ([`checks.test.ts`](../packages/firewall/test/checks.test.ts)), the core pipeline (idempotency, fail-closed, approvals re-running checks, serialized decisions), the agent's tool loop and its refusal to start with wallet credentials, the scripted `--dry` model, the x402 vendors, the red-team suite, the onchain watchdog (webhook auth, unsigned-outflow detection), the static replay build and its secret scan, and a check that the README's safety-limits tables still match `config/`.
- `npm run redteam` → one line per attack, ending with `23/23 scenarios pass · 21/21 attacks stopped with the expected rule · <time> ms`. Each attack runs against a fresh firewall **over its real HTTP API**, using the real `config/policy.json` and `config/registry.json`. Only the payment rail (fake signer, scripted 402 quotes) and the LLM are scripted. Add `-- --details` to print each denial's reason.

Optional:

```bash
npm run typecheck          # tsc over all packages and scripts; prints nothing after npm's own header on success
```

### The dashboard, with no keys

```bash
npm run dashboard:dev
```

Open **http://127.0.0.1:4020/#token=dev**. This runs the real firewall HTTP API and check pipeline in-process with fake payments, fed by a stream of synthetic agent traffic: honest calls, injected transfers to the attacker, an unregistered service, and a runaway pagination burst every 90 s that trips the velocity breaker. Things to try:

- **Approval queue:** transfers between $0.25 and $1.00 wait for you. Approve or deny them.
- **Breaker:** when the runaway burst trips it, everything is denied with `breaker.open` until you press reset (it auto-resets after 45 s).
- **Vendor mode:** switch `premium-weather` to `payee_swap`, `overcharge` or `price_creep` and watch pre-flight deny it.

Ctrl-C stops it. Ports: 4020 (dashboard), 4022 (fake vendor control). Set `FIREWALL_PORT` / `DEV_VENDOR_PORT` if those are taken. The velocity limits are raised in this mode only, because the synthetic traffic is far busier than a real agent.

---

## Level 2: Read the chain (no install)

All of these are public. The explorer is https://explorer.testnet.arc.io (Arc testnet, chain id `5042002`). Short hashes link to the explorer.

### Addresses

| What | Address |
|---|---|
| Firewall wallet (Circle Developer-Controlled Wallet; no private key anywhere in this project) | [`0x115ac8ffb8241e1750ca19c26881f2a498c944b2`](https://explorer.testnet.arc.io/address/0x115ac8ffb8241e1750ca19c26881f2a498c944b2) |
| Unsafe baseline wallet (plain local key; the "without the firewall" agent) | [`0x477a60aCA7a95EFc29949A5A051d5D599a4d6F6B`](https://explorer.testnet.arc.io/address/0x477a60aCA7a95EFc29949A5A051d5D599a4d6F6B) |
| Attacker (demo, receive-only) | [`0x91D09630a50b78650170205Eb3020D9907c2853d`](https://explorer.testnet.arc.io/address/0x91D09630a50b78650170205Eb3020D9907c2853d) |
| Honest vendor payee (`weather-api`, `air-quality-api`) | [`0x0D21C234A68a6C00574d9360D7275896Ae00a5d1`](https://explorer.testnet.arc.io/address/0x0D21C234A68a6C00574d9360D7275896Ae00a5d1) |
| `premium-weather` payee | [`0x4eA9Bf9F49ffE8e6DAdEA3F38A2e837B7890a2F4`](https://explorer.testnet.arc.io/address/0x4eA9Bf9F49ffE8e6DAdEA3F38A2e837B7890a2F4) |
| Circle GatewayWallet contract | [`0x0077777d7EBA4688BDeF3E311b846F25870A19B9`](https://explorer.testnet.arc.io/address/0x0077777d7EBA4688BDeF3E311b846F25870A19B9) |

### Transactions

| What | Tx |
|---|---|
| Firewall wallet: USDC `approve` for Gateway | [`0xfa7f…068d`](https://explorer.testnet.arc.io/tx/0xfa7f588e9ca46acba1c7d9bcfe291ce12ce497cf61171b438791e615155e068d) |
| Firewall wallet: 5 USDC `deposit` into GatewayWallet | [`0x833a…7f0d`](https://explorer.testnet.arc.io/tx/0x833a4234fdf9814a3b0b1abb5f7da7e36c1e5db1309aa8fa34fccbd816737f0d) |
| Circle's `submitBatch` settling the first nanopayments (sender: Circle's batcher, to: GatewayWallet) | [`0xba85…4915`](https://explorer.testnet.arc.io/tx/0xba85940fcf603601afd41d575d905b8691fd7546c766f116b14e3335618c4915) |
| A later `submitBatch` settling 27 of the demo's nanopayments | [`0x9514…51e7`](https://explorer.testnet.arc.io/tx/0x9514463f4fd653fade4c2a9bc594e84f62da0807f793936c0acdb046778c51e7) |
| Baseline wallet: USDC `approve` + 2 USDC `deposit` into Gateway | [`0x6a7d…ea8d`](https://explorer.testnet.arc.io/tx/0x6a7dd91e63ec0c0718bb5ba4daedc972735306f52dcda43ce0ea8b26e173ea8d), [`0x2183…73a3`](https://explorer.testnet.arc.io/tx/0x21836f27d983e4df02cff56ebda932807a9b952d935bba07551108e2787473a3) |
| **Without the firewall:** the baseline agent, fed the paywall scam, paid the attacker 0.05 USDC | [`0xc12d…0d77`](https://explorer.testnet.arc.io/tx/0xc12dca57023aeef6b37747583896a49b1ff367defd9160e967f4c3a19df50d77) (and again in a later rehearsal: [`0x4cca…e244`](https://explorer.testnet.arc.io/tx/0x4cca01026d161fbfa45c94606ec11f8ef2280cb365549b703effd187f298e244)) |
| **With the firewall:** the same agent and task was denied `policy.recipient_not_allowed` | nothing onchain, which is the point. The firewall wallet has **no** transfer to the attacker; check its history above. |

### Nanopayments (Circle Gateway API, no key needed)

A nanopayment is not an ERC-20 transfer to the vendor. The firewall signs a Gateway authorization, the vendor's balance **inside Gateway** is credited, and Circle settles many authorizations onchain at once with `submitBatch`. So the vendor payee's token-transfer tab on the explorer is empty; the transfers themselves are visible in Circle's public Gateway API:

```bash
# Every nanopayment the firewall wallet made: amount (6-decimal units, 1000 = $0.001), payee, status, settling batch tx
curl -s 'https://gateway-api-testnet.circle.com/v1/x402/transfers?from=0x115ac8ffb8241e1750ca19c26881f2a498c944b2&pageSize=100'

# One transfer by id: the first $0.001 payment, settled in batch 0xba85…4915
curl -s https://gateway-api-testnet.circle.com/v1/x402/transfers/9c13c246-0989-42cf-8ec4-8de7ea700fa9

# Gateway balances (domain 26 = Arc testnet): the firewall's remaining deposit and the honest vendor's earnings.
# With your own wallets (level 3), `npm run wallets:balances` prints the Gateway balances for you.
curl -s -X POST https://gateway-api-testnet.circle.com/v1/balances -H 'content-type: application/json' \
  -d '{"token":"USDC","sources":[{"depositor":"0x115ac8ffb8241e1750ca19c26881f2a498c944b2","domain":26},{"depositor":"0x0D21C234A68a6C00574d9360D7275896Ae00a5d1","domain":26}]}'
```

At the time of writing, the first query returns 44 transfers, all `completed`: $0.001–$0.002 each, paid only to the two pinned payees in [`config/registry.json`](../config/registry.json), and settled in 5 batch transactions. Each transfer's `txHash` is a `submitBatch` you can open on the explorer. Use `from=`: other spellings, such as `fromAddress=`, are ignored and return unrelated transfers.

---

## Level 3: Full live run

This is the real demo with your own wallets. Payments are real testnet USDC on Arc.

### What you need

| | Where | Notes |
|---|---|---|
| Circle **testnet API key** | Circle developer console → API keys | The full `TEST_API_KEY:<id>:<secret>` string. |
| Circle **entity secret** | Circle developer console / Circle's Developer-Controlled Wallets quickstart | A 32-byte hex secret you generate and **register** with Circle (its ciphertext) before creating wallets. An unregistered secret makes `wallets:setup` fail. |
| **Testnet USDC** | https://faucet.circle.com, network **Arc Testnet** | For two addresses. Firewall wallet: about 6 USDC (5 go into Gateway, the rest pays gas, since USDC is gas on Arc). Baseline wallet: about 3 USDC (2 into Gateway, 0.05 per scam payment, gas). |
| **Anthropic API key** (optional) | Anthropic console | For the real Claude agent. A scene costs a few cents. Skip it by adding `--dry` to every scene, which uses a scripted model with the **same** firewall, vendors and real payments. |

### Steps

**1. Configure.**

```bash
cp .env.example .env
```

Fill in `TEST_API_KEY`, `ENTITY_SECRET`, `ANTHROPIC_API_KEY` (unless you'll only use `--dry`), and **`FIREWALL_ADMIN_TOKEN`** (any random string, e.g. `openssl rand -hex 16`). The admin token is what lets `demo:scene` and `npm run task` create mandates. Without it, the demo makes up a random token, and the scenes can't authenticate.

**2. Create the wallets.**

```bash
npm run wallets:setup
```

This creates a Circle wallet set and one Arc-testnet wallet for the firewall, generates a throwaway local key for the unsafe baseline, and **appends** `CIRCLE_WALLET_SET_ID`, `CIRCLE_FIREWALL_WALLET_ID`, `CIRCLE_FIREWALL_WALLET_ADDRESS`, `BASELINE_PRIVATE_KEY` and `BASELINE_ADDRESS` to `.env`. It prints both addresses. It is safe to re-run: values already in `.env` are reused.

**3. Fund both addresses** from https://faucet.circle.com (Arc Testnet). Then check:

```bash
npm run wallets:balances   # both addresses with their wallet USDC and their Gateway balance (0 until step 4)
```

**4. Deposit into Circle Gateway.** Nanopayments are paid from a Gateway balance, not from the wallet directly.

```bash
npm run gateway:deposit
```

This uses the firewall wallet, signing through Circle. If its Gateway balance is under 1 USDC, it approves and deposits 5 USDC (printing both explorer links), then waits for Gateway to see the deposit. Pass a different amount with `npm run gateway:deposit -- 3`. Once the demo is up (step 5), `npm run check:vendors` makes one real payment end to end through the firewall, which confirms your Circle setup.

```bash
npm run baseline:deposit
```

This deposits 2 USDC into Gateway from the baseline wallet. It's only needed for scene 3's "without the firewall" half, where the baseline pays the vendor directly.

**5. Start the demo** (terminal 1):

```bash
npm run demo
```

This starts the firewall and both vendors and prints `Agent Spending Firewall demo is up.` with the dashboard link (`http://127.0.0.1:4020/#token=<your FIREWALL_ADMIN_TOKEN>`). Open it. It uses ports 4020 (firewall + dashboard), 4021 (honest vendor) and 4022 (shady vendor).

**6. Play the scenes** (terminal 2). Add `--dry` to any of them to skip the LLM:

```bash
npm run demo:scene -- 2    # happy path: nanopayments flow, the mandate budget ticks down
npm run demo:scene -- 3    # prompt injection: the baseline pays the attacker; the firewalled agent is denied policy.recipient_not_allowed
npm run demo:scene -- 4    # lying vendor: preflight.payto_mismatch, then preflight.price_drift (or price_out_of_band)
npm run demo:scene -- 5    # runaway loop: a velocity.* rule trips the breaker (left open on purpose; reset it on the dashboard)
npm run demo:scene -- 6    # task ended: a late payment finds mandate.none_active
```

Each scene prints the firewall's decisions and whether they matched what the scene expected. With the real model, a step can come out differently, for example Claude declining the scam on its own. The scene says so; rerun it, or use `--dry` for the deterministic version. Every approved payment appears on the dashboard with an explorer link (a nanopayment shows its Gateway transfer id until Circle batches it onchain, typically 2–16 minutes, and then the link appears in place), and you can check it as in level 2 with your own firewall address.

**7. Your own task** (optional):

```bash
npm run task -- "What's the air quality in Denver right now?"
npm run task -- --unsafe "<task>"    # the baseline: raw key, no firewall
```

### Things to know about a live run

- **Payees are this project's addresses.** The vendors run on your machine, but `config/registry.json` pins their payees to the receive-only demo addresses above, so your nanopayments are credited there. That's harmless on testnet. To pay yourself instead, change the `payTo` values and run `npm run docs:limits`; otherwise `npm test` fails its README drift check.
- **The ledger persists** in `data/firewall.db` (gitignored), and the $5.00 daily budget is a rolling 24 h window over it. If you rehearse a lot and start seeing `policy.daily_budget`, point `FIREWALL_DB` at a fresh path in `.env` and restart `npm run demo`.
- **The agent never sees your wallet credentials.** `npm run task` and `demo:scene` start it with a scrubbed environment, and it refuses to start if it finds any (a red-team scenario checks this).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No such built-in module: node:sqlite` | Node older than 22.13. Upgrade (`nvm use` picks 24 from `.nvmrc`). |
| `No …/.env` | Run `cp .env.example .env` in the repo root. Every script reads the repo-root `.env`, whichever directory you run it from. |
| `Missing TEST_API_KEY in .env` (or another variable) | That step needs level-3 credentials; see `.env.example`. Levels 1 and 2 never need them. |
| `FIREWALL_ADMIN_TOKEN is not set in .env` | Add one to `.env` and restart `npm run demo`, so the demo and the scenes share the same token. |
| `firewall, … did not come up within 30 s` / `EADDRINUSE` | Something else is on port 4020, 4021 or 4022. Stop it, or set `FIREWALL_PORT`, `VENDOR_HONEST_PORT` or `VENDOR_SHADY_PORT` in `.env`. The registry's vendor URLs (`localhost:4021` / `:4022` in `config/registry.json`) follow the vendor settings when loaded, so `config/registry.json` needs no edit. |
| `gateway:deposit` deposit never shows up in Gateway | The wallet has no USDC for gas, or the faucet transfer hasn't landed. Check `npm run wallets:balances`. |
