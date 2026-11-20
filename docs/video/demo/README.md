# Demo video

`agent-spending-firewall-demo.mp4` (2:43, 1920×1080, 30 fps, H.264, silent): a captioned screen recording of the real `npm run demo` dashboard and the real `npm run demo:scene` runs. There is no voiceover and no generated footage. The captions are burned in and also ship as [`agent-spending-firewall-demo.srt`](agent-spending-firewall-demo.srt).

The mp4 is gitignored (`*.mp4`) because of its size. Rebuild it with the command at the bottom of this file, or get the uploaded copy linked from the Devpost entry.

## Scenes (SPEC §8, in order)

| Time | Scene | Footage |
|---|---|---|
| 0:00 | 1 · The problem | Title, the Bankr/Grok incident, and the agent → firewall → signer diagram (`docs/video/stills.html`) |
| 0:23 | 2 · Happy path | Live Claude does the picnic task; its x402 nanopayments are approved (0.009 of a 0.50 USDC budget); the explorer shows a Gateway settlement batch |
| 0:45 | 3 · Prompt injection (P1) | **Without** the firewall, live Claude pays the 0.05 USDC "access fee" to the attacker, and the explorer shows the transfer. **With** the firewall, the same scam is denied with `policy.recipient_not_allowed` |
| 1:20 | 4 · Lying vendor (P2) | `payee_swap` → `preflight.payto_mismatch`; `price_creep` → `preflight.price_drift`, then `preflight.price_out_of_band` |
| 1:40 | 5 · Runaway loop (P3) | `velocity.no_progress` trips the breaker after 11 paid calls that added nothing; a human resets it from the dashboard |
| 2:01 | 6 · Task ended (P4) | Live Claude finishes a task; a late instruction to pay → `mandate.none_active` |
| 2:17 | 7 · Tested, not prompted | `npm run redteam`: 23/23 scenarios pass, and the expected rule stops all 21/21 attacks |
| 2:27 | 8 · Why Arc | USDC is the gas, finality in one block, two fuses |

Notes:
- **Scene 5 uses the scripted agent** (`--dry`), so the loop is deterministic. Its firewall and its payments are real. This is labelled on screen ("SCRIPTED AGENT (--dry)") and in the caption. Scenes 2, 3, 4 and 6 use live Claude Sonnet; every take was a first take.
- **Scene 3 is a hard cut, not a split screen.** It shows WITHOUT the firewall, then the attacker's transfer on the Arc explorer, then WITH the firewall. The unsafe run moved 0.05 testnet USDC to the attacker address, tx `0x33591fa823f6d4001f25bdd4794bc20335014b4d7b4131bdd182e5658581266c`.
- The terminal output is sped up in places (scene 2 runs at 1.25×, the unsafe half of scene 3 at 1.4×, and scene 4 at 1.5×) to cut the model's think time. Nothing is reordered. Scene 5 freezes for 2.5 s on the tripped breaker, and scene 6 holds its last frame for 3.2 s, so the captions can be read.

## How it was recorded

The machine runs Wayland and has no screen-capture tool, so the video is recorded headlessly:

- `tooling/server.mjs` serves a 1920×1080 "stage" page (`tooling/stage.html`) on :4030. The stage shows the live dashboard in an iframe on the left and an xterm.js terminal on the right. The terminal streams a real command (`npm run demo:scene -- N`) that runs in a pty (`tooling/ptyrun.py`). A 128 px bar at the bottom is kept free for captions.
- `tooling/rec.mjs <spec>` drives headless Chrome (`--remote-debugging-port=9333`) over CDP and screencasts the stage to `tooling/shots/<name>/raw.mkv`. The specs are in `tooling/specs/`. The stills and the Arc explorer pages are captured the same way.
- `tooling/build.py <outdir>` holds the cut list and every caption (`SEGS`). It cuts and speeds up each shot, writes the `.srt` and an `.ass`, burns in the captions with ffmpeg, and encodes with libopenh264.

Rebuild from the raw shots, which are gitignored and live only on the recording machine:

```sh
python3 docs/video/demo/tooling/build.py docs/video/demo
```
