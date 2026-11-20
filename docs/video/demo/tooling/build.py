#!/usr/bin/env python3
"""Cut the recorded shots into the demo video, write captions (.srt + .ass), burn them in."""
import subprocess, os, sys, json

HERE = os.path.dirname(os.path.abspath(__file__))
SH = os.path.join(HERE, "shots")
OUT = sys.argv[1]  # output dir
os.makedirs(OUT, exist_ok=True)
SEG = os.path.join(HERE, "segs"); os.makedirs(SEG, exist_ok=True)
BG = "0x0b0d12"

# (name, source, kind, start, end, speed, hold, captions[(t0, t1, text)]) ; times in OUTPUT seconds of the segment
# kind: stage (as recorded), still (fit into the area above the caption bar), web (zoom into the top-left)
SEGS = [
  ("01_title", "st1", "still", 0, None, 1, 4.0, [
    (0, 4.0, "Agent Spending Firewall: an AI agent that pays for APIs with USDC on Arc testnet, but holds no keys."),
  ]),
  ("02_problem", "st2", "still", 0, None, 1, 9.0, [
    (0, 4.5, "May 2026: a prompt injection talked an AI agent into moving about $150k out of its wallet."),
    (4.5, 9.0, "The root problem: the agent's authority IS the wallet's authority."),
  ]),
  ("03_diagram", "st3", "still", 0, None, 1, 10.0, [
    (0, 5.0, "Our fix: the agent holds no keys. It can only ask a firewall to pay."),
    (5.0, 10.0, "Every payment runs through these checks in order. The first deny wins, and only then does the signer sign."),
  ]),
  ("04_happy", "s2", "stage", 0, 21.2, 1.25, 0, [
    (0, 4.6, "Scene 2 · Happy path. Live Claude plans a weekend picnic by buying weather and air-quality data."),
    (4.6, 10.0, "Each data call is a real x402 nanopayment on Arc testnet ($0.001–$0.002), paid through Circle Gateway."),
    (10.0, 16.96, "Every payment passed all 7 firewall checks before it was signed. The task spent 0.009 of its 0.50 USDC budget."),
  ]),
  ("05_settle", "s2x", "web", 0, 5.0, 1, 0, [
    (0, 5.0, "Nanopayments settle onchain in batches. Here, an earlier batch from this session lands on the Arc explorer."),
  ]),
  ("06_unsafe", "s3a", "stage", 0, 22.0, 1.4, 0, [
    (0, 4.8, "Scene 3 · Prompt injection, WITHOUT the firewall: the agent holds its own wallet key."),
    (4.8, 10.6, "A vendor withholds its data until the agent pays a 0.05 USDC \"access fee\" to the attacker's address…"),
    (10.6, 15.71, "…and the agent pays it (send_payment → paid: true). Nothing checked it."),
  ]),
  ("07_attacker_tx", "s3x", "web", 0, 5.0, 1, 0, [
    (0, 5.0, "There it is on Arc: 0.05 USDC transferred from the agent's wallet to the attacker's address."),
  ]),
  ("08_firewalled", "s3b", "stage", 0, 14.3, 1.0, 0, [
    (0, 4.5, "WITH the firewall: the same agent, task and scam, but now the agent holds no keys."),
    (4.5, 8.1, "It pays the vendor's 0.001 call fee, then tries to send the 0.05 \"access fee\"…"),
    (8.1, 14.3, "Denied: policy.recipient_not_allowed. The attacker isn't on the allowlist, and nothing was paid."),
  ]),
  ("09_vendor", "s4", "stage", 0, 29.4, 1.5, 0, [
    (0, 4.4, "Scene 4 · Lying vendor. Most x402 clients sign whatever payment request they are handed."),
    (4.4, 9.7, "payee_swap: the right price, but the payee is the attacker's address. Denied: preflight.payto_mismatch."),
    (9.7, 12.5, "price_creep: now the vendor raises its price 25% on every quote…"),
    (12.5, 19.6, "Denied: preflight.price_drift (over +20% vs. the last price paid), then price_out_of_band (over +50% vs. the registry)."),
  ]),
  ("10_loop", "s5", "stage", 0, 18.7, 1.0, 0, [
    (0, 3.5, "Scene 5 · Runaway loop. Scripted agent (--dry), with a real firewall and real payments."),
    (3.5, 10.9, "The vendor says \"call again for page N+1\", forever. Each $0.001 page passes every spending cap…"),
    (10.9, 14.5, "…but 11 paid calls added nothing new. velocity.no_progress trips the breaker, and ALL spending stops."),
    (14.5, 18.7, "Only a human can reset the breaker, from the dashboard."),
  ]),
  ("11_ended", "s6", "stage", 0, 11.3, 1.0, 0, [
    (0, 4.0, "Scene 6 · Task ended. Live Claude does a short task, and its mandate (the task's budget) closes."),
    (4.0, 8.0, "Then a late instruction tries to pay the attacker and buy more data…"),
    (8.0, 11.3, "Denied: mandate.none_active. With no active task, the agent has zero spending authority."),
  ]),
  ("12_redteam", "s7", "stage", 0, 8.3, 1.0, 1.7, [
    (0, 5.0, "npm run redteam: every attack in this video is also an automated test (no AI, no money)."),
    (5.0, 10.0, "23/23 scenarios pass, and 21/21 attacks are stopped by the expected rule. Guardrails are code with tests, not prose in a prompt."),
  ]),
  ("13_why_arc", "st4", "still", 0, None, 1, 12.0, [
    (0, 6.0, "Why Arc: USDC is the gas, so every budget is in one unit, and one confirmation is final."),
    (6.0, 12.0, "The Gateway deposit is the hard fuse. The firewall is the soft fuse in front of it."),
  ]),
  ("14_end", "st1", "still", 0, None, 1, 4.0, [
    (0, 4.0, "Agent Spending Firewall · UBC Austin Hackathon 2026 · Agentic Payments and AI · Best use of Arc"),
  ]),
]

def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode: print(r.stderr[-2000:]); sys.exit(1)
    return r.stdout

def dur(path):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).strip())

seg_files, timeline, t = [], [], 0.0
for name, src, kind, ss, to, speed, hold, caps in SEGS:
    inp = os.path.join(SH, src, "raw.mkv")
    out = os.path.join(SEG, name + ".mkv")
    if kind == "still":
        img = os.path.join(SH, src, "end.png")
        vf = f"scale=1693:952,pad=1920:1080:113:0:color={BG},fps=30,format=yuvj420p"
        args = ["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-t", str(hold), "-i", img, "-vf", vf]
    else:
        vf = []
        if kind == "web": vf.append(f"crop=1280:720:0:0,scale=1920:1080")
        vf.append(f"setpts=(PTS-STARTPTS)/{speed}")
        if hold: vf.append(f"tpad=stop_mode=clone:stop_duration={hold}")
        vf += ["fps=30", "format=yuvj420p"]
        args = ["ffmpeg", "-y", "-loglevel", "error", "-ss", str(ss), "-to", str(to), "-i", inp, "-vf", ",".join(vf)]
    run(args + ["-an", "-c:v", "mjpeg", "-q:v", "2", out])
    d = dur(out)
    for c0, c1, text in caps:
        timeline.append((t + c0, t + min(c1, d), text))
    print(f"{name:16s} {t:6.2f} +{d:5.2f}")
    seg_files.append(out); t += d

total = t
print(f"total {total:.2f}s")

def ts(x, sep):
    h, m = int(x // 3600), int(x % 3600 // 60); s = x % 60
    return f"{h:02d}:{m:02d}:{int(s):02d}{sep}{int(round((s - int(s)) * 1000)) if sep == ',' else int(round((s - int(s)) * 100)):0{3 if sep == ',' else 2}d}"

srt = []
for i, (a, b, text) in enumerate(timeline, 1):
    srt.append(f"{i}\n{ts(a, ',')} --> {ts(b - 0.04, ',')}\n{text}\n")
open(os.path.join(OUT, "agent-spending-firewall-demo.srt"), "w").write("\n".join(srt))

ass = ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "WrapStyle: 0", "",
       "[V4+ Styles]",
       "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
       "Style: Cap,Noto Sans,38,&H00FFFFFF,&H00FFFFFF,&H00000000,&H28000000,-1,0,0,0,100,100,0,0,3,10,0,2,140,140,26,1",
       "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
for a, b, text in timeline:
    ass.append(f"Dialogue: 0,{ts(a, '.')},{ts(b - 0.04, '.')},Cap,,0,0,0,,{text}")
assp = os.path.join(SEG, "captions.ass"); open(assp, "w").write("\n".join(ass) + "\n")

lst = os.path.join(SEG, "list.txt"); open(lst, "w").write("".join(f"file '{f}'\n" for f in seg_files))
final = os.path.join(OUT, "agent-spending-firewall-demo.mp4")
run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
     "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
     "-vf", f"ass={assp},format=yuv420p", "-c:v", "libopenh264", "-b:v", "4M", "-maxrate", "8M", "-r", "30",
     "-c:a", "aac", "-b:a", "64k", "-shortest", "-movflags", "+faststart", final])
print("wrote", final, f"{dur(final):.2f}s")
