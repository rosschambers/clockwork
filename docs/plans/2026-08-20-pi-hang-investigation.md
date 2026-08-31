# Investigation: pi sessions hitting the 15-minute watchdog with an empty transcript

**Date:** 2026-08-21 (investigation run overnight after the 2026-08-20 prism-drift render work)
**Scope:** INVESTIGATION ONLY. Nothing operational was changed — no service restart, no
unclaimed cards, no code edits. This document reports evidence and root cause; a separate
"Recommended fixes" section lists options but implements none.
**Symptom under investigation:** clockwork "pi" coding-agent sessions on the prism-drift
project (projectId `a2afe5dc-1459-4201-9a7d-90152b4ab7e9`), notably the "Render: layout
foundation" render cards, sometimes run the full 15-minute watchdog and produce a
0-byte-stdout transcript: `# exit 124`, `[clockwork: pi killed after 900000ms watchdog]`.

---

## TL;DR (bottom line up front)

- **Where it hangs:** NOWHERE in the "stuck" sense. Caught a hang **live** and proved the
  model (`llama-server-dense`, qwen3.8-27B, frame low port 8185) was **continuously
  decoding tokens at ~18–25 tok/s the whole time**, turn after turn, context growing
  2.2k → 16.6k+ tokens. pi held a healthy ESTABLISHED socket to the model, ~1% CPU, no
  godot child. It is a genuine long multi-turn agentic session, not a stall.
- **Model-slow vs true-hang:** **Model-slow / long-agentic-session.** Not a true hang. Same
  card finished in 3–4 min on two runs, then ran >15 min on the next — the variable is how
  many reasoning+tool turns the run takes, and the reasoning budget is effectively unbounded.
- **Why the transcript is empty:** SEPARATE bug in `invokePi`. pi **buffers all stdout and
  flushes only at process exit** (proven: first output byte arrived 65 s after start in a
  manual run, then every line at once). The worker reads stdout with
  `Bun.readableStreamToText`, which only resolves at EOF. When the watchdog `proc.kill()`s
  pi mid-session, that read never resolves, so `collected.out` stays `""`. **Every kill
  yields the identical 82-byte empty transcript regardless of how much work pi actually did.**
  The empty transcript therefore carries ZERO information about where pi was — it is a
  measurement artifact, not a clue.
- **Headline fix:** raise (and/or make streaming/incremental) the watchdog. It is primarily a
  timeout-too-low + can't-see-partial-progress problem, not a hung-tool problem.
- **Confidence:** High for the mechanism (empty transcript) and high that the observed live
  case is model-slow. Medium-high that model-slow explains the *majority* of the historical
  exit-124s (one was caught red-handed; the buffering artifact means the older ones can't be
  individually re-litigated, but the process/socket signature is the same class).

---

## Environment / how the pieces connect (verified, not assumed)

- Worker host: **studio** (`clockwork.service`, systemd --user, HOME `/home/<user>/.clockwork-home`).
- Model host: **frame**. `frame-arbiter.service` fronts several `llama-server-*` Vulkan
  instances. clockwork targets the **LOW** port for `dense`:
  `http://<model-host>:8185/v1` (provider `frame-dense-low`), model
  `Qwen3.8-27B-Uncensored-Q4_K_M.gguf`, `contextWindow: 262144`, `reasoning: true`.
  Source: `/home/<user>/.clockwork-home/.pi/agent/models.json` (read during investigation).
- The dense model backend logs as `llama-server-dense.service` on frame; the arbiter proxies
  8185 → the real backend. GPU is **Vulkan**, so there is no `nvidia-smi` (checked — absent);
  GPU activity was read from the server's own per-slot token-timing logs instead.

---

## What I tested (exact commands)

All run from host x1. `ssh studio` and `ssh frame` are tailnet hops.

1. **Read the worker source** — `src/worker.ts`, function `invokePi` (lines 123–177),
   `DEFAULT_PI_TIMEOUT_MS = 15 * 60 * 1000` (line 103), the spawn + read-until-EOF +
   watchdog logic.

2. **Arbiter status (repeated):**
   `curl -s http://<model-host>:8099/status`
   → `{"lowInFlight":1,...}` steady across many polls during the live hang.

3. **Enumerate transcripts + exit codes:**
   ```
   ssh studio 'cd /home/<user>/.clockwork-data/transcripts/a2afe5dc-.../; \
     for d in */; do for f in "$d"attempt-*.txt; do \
       printf "%s\t%s bytes\t%s\n" "$f" "$(stat -c%s "$f")" "$(head -1 "$f")"; done; done'
   ```

4. **Convert exit-124 attempt timestamps to wall-clock** (the filename is `Date.now()` ms).

5. **Read the newest hang + its prior success** transcripts for card
   `4623019a-c52b-446b-81ce-c0f60096ba85`.

6. **Worker event log around a known hang window:**
   `ssh studio 'journalctl --user -u clockwork.service --since "2026-08-20 22:18:00" \
     --until "2026-08-20 22:46:00" --no-pager'`

7. **Catch a hang live** — repeatedly:
   `ssh studio 'ps aux | grep -w pi | grep -v grep'`,
   `ps --ppid <worker> -o pid,cmd`,
   `ps -o pid,stat,%cpu,rss,etime,cmd -p <pi>` sampled every 5 s,
   `ls -l /proc/<pi>/fd` (stdin/stdout/stderr + the model socket),
   `ss -tnp | grep <pi>` (the ESTABLISHED connection to frame:8185).

8. **Frame model side, live:**
   `ssh frame 'journalctl -u llama-server-dense.service --since "<t>" --no-pager'`
   — read per-slot `print_timing` (tok/s) and `launch_slot_ / release` turn boundaries.

9. **Streaming test (manual pi):**
   ```
   ssh studio 'cd /tmp; env HOME=/home/<user>/.clockwork-home pi -p --provider frame-dense-low \
     "Count slowly from 1 to 40, one number per line, with a short reflective sentence ..." \
     2>/dev/null | while IFS= read -r line; do echo "[$(date +%H:%M:%S)] $line"; done'
   ```

---

## Evidence

### E1 — Every exit-124 transcript is byte-identical and content-free

All exit-124 files are exactly **82 bytes**:

```
# exit 124

## stdout


## stderr

[clockwork: pi killed after 900000ms watchdog]
```

stdout empty **and stderr empty** (only the injected watchdog line). The worker drains
stderr *concurrently* and appends it on timeout (`worker.ts:174`), so an empty stderr means
pi wrote nothing to stderr before the kill — i.e. no error, no connection failure, no tool
diagnostic. Absence of any stderr argues *against* an early connection/auth/provider hang.

### E2 — The hang is intermittent on the SAME card, not content-deterministic

Worker log for card `6fbc7190` ("Render: layout foundation" family), one evening:

| Start (local) | Outcome | Duration |
|---|---|---|
| 22:21:20 | passed | 4m14s |
| 22:25:34 | passed | 2m50s |
| 22:28:24 | **watchdog / blocked → needsHuman** | **15m31s** |

Same card, same column prompt, same workspace — succeeds fast twice, then runs the full
watchdog. A content-specific deterministic hang (e.g. a bare godot with no display) cannot
produce that pattern; a variable-length agentic session can. exit-124s across the day are
spread (10:49, 12:23, 19:39, 20:00, 21:23, 21:40, 22:21, 22:43, 00:14) and land on multiple
different cards — not clustered, so not obviously Hugo-preemption-driven.

### E3 — Caught a hang LIVE: the model is busy the entire time

At 00:29:49 the worker started card `4623019a`; by 00:31 it was clearly a long run. Live
process inspection of the pi child (PID 2178328, parent = worker 2170569):

```
PID      STAT %CPU  RSS     ELAPSED  CMD
2178328  SNl  1.3   145628  01:13    pi     (sampled every 5s: CPU ~1%, RSS flat, NO children)
```

- **No godot child** at any sample — rules out a hung godot tool call for this occurrence.
- **~1% CPU, flat RSS** — pi itself is idle, blocked on I/O (waiting for the model), not
  spinning or leaking.
- **Socket to the model is healthy:**
  `ss -tnp` → `ESTAB 0 0 <worker-host-ip>:56260 <model-host-ip>:8185 users:(("pi",pid=2178328,fd=21))`
  tx_queue = rx_queue = 0 (nothing stuck in kernel buffers; a live, quiet, in-flight request).
- `/proc/<pi>/fd`: fd0 → `/dev/null` (stdin ignored — rules out a stdin block), fd1 & fd2 →
  sockets (Bun "pipe"), fd21 → the model socket.
- Arbiter `lowInFlight` sat at **1** continuously throughout.

### E4 — Frame confirms continuous token generation (the model is the "slow" part)

`llama-server-dense` logs for this exact session show a **chain of turns on slot 0**, each
decoding tokens, context growing every turn:

```
00:29:49 release task 207848 (n_tokens=2275)  -> launch 208133
00:29:59 release task 208133 (n_tokens=2901)  -> launch 208201
00:30:07 release task 208201 (n_tokens=3149)  -> launch 208263
00:30:17 release task 208263 (n_tokens=4077)  -> launch 208318
00:31:00 release task 208318 (n_tokens=10097) -> launch 208503
00:31:15 release task 208503 (n_tokens=10656) -> launch 208610
00:32:12 release task 208610 (n_tokens=16649) -> launch 208888 ...
```

Per-turn timing lines, e.g. task 208610:
`eval time = 11432.55 ms / 287 tokens (25.10 tok/s)`, and streaming decode samples
`n_decoded=100 tg=18.20 t/s … n_decoded=605 tg=20.05 t/s`. The model is **actively decoding
at 18–25 tok/s the whole time.** `reasoning-budget: activated, budget=2147483647` — the
reasoning budget is effectively unbounded, and the model is a reasoning model, so it can burn
very long stretches thinking between/within tool turns. This is a genuine multi-turn agentic
session, not a stalled connection.

### E5 — pi BUFFERS stdout; it does not stream (this is why the transcript is empty)

Manual run, timestamped per line:

```
START            00:33:34.502
[00:34:39] 1 — The first step; everything begins as a single point.
[00:34:39] 2 — ...
[00:34:39] 3 — ...   (all 12 lines share the SAME 00:34:39 timestamp)
FIRST-CHUNK-DONE 00:34:39.152
```

**65 seconds of silence, then the whole turn at once.** pi emits nothing on stdout until the
model turn completes, then flushes. A trivial "say DONE" prompt returned one line, exit 0,
near-instantly — so pi works; it just doesn't stream partial output.

Cross-referenced with the worker code: `invokePi` reads stdout via
`Bun.readableStreamToText(proc.stdout).then(t => collected.out = t)` — that promise only
resolves at **EOF (process exit)**. The watchdog does `proc.kill()` then resolves the race;
the return runs immediately with `collected.out` still `""`. Therefore **any** watchdog kill
— whether pi did 0 turns or 50 turns of real work — produces the identical 82-byte empty
transcript. The empty transcript is a *measurement artifact of buffered-read + kill*, and
proves nothing about where pi was. (This directly answers the brief's "buffers all output,
flushes at exit" branch: it is that branch, confirmed.)

---

## Root cause

Two independent facts combine into the reported symptom:

1. **Primary (the "hang"): long variable-length agentic sessions on a slow local reasoning
   model exceed the 15-minute watchdog.** The qwen3.8-27B dense model at ~18–25 tok/s, with
   an unbounded reasoning budget and a growing multi-turn tool conversation, sometimes needs
   more than 900 s of *genuine, continuous* generation to finish a render card. The same card
   finishing in 3 min on one run and >15 min on the next is explained entirely by how many
   reasoning/tool turns that particular run takes. Evidence: E2, E3, E4. This is **model-slow,
   not a true hang** — there is no stuck process, no dead socket, no hung godot child in the
   observed case.

2. **Secondary (the "empty transcript"): `invokePi` cannot capture partial output on kill,
   because pi buffers stdout to EOF and the worker reads to EOF.** So a legitimately-working
   session that gets watchdog-killed looks *identical* to a session that hung on line 1. This
   is what made the problem look like an "early hang / produced NOTHING" when in fact the
   process was busy the whole time. Evidence: E1, E5, and `worker.ts:159–176`.

**Not the cause (ruled out for the observed live hang):**
- Not a hung godot tool call — no godot child process at any sample (E3). (A hung godot
  remains a *possible separate* failure mode on other occurrences — it cannot be excluded for
  historical runs because of the empty-transcript artifact — but it is not what happened in
  the case caught live, and the intermittent-same-card pattern in E2 is not godot-shaped.)
- Not a stdin block — fd0 → `/dev/null` (E3); the earlier stdin fix (`stdin: "ignore"`) holds.
- Not connection/auth/provider resolution — the socket to 8185 is ESTABLISHED and the model
  is streaming tokens (E3, E4); zero stderr (E1).
- Not obviously Hugo preemption — hangs are spread across the day and across cards, and the
  live hang ran with `lowInFlight:1` and continuous decode with no preemption/cancel events
  in the arbiter log for the window (E2, E4). Cannot be *fully* excluded as an occasional
  contributor, but it is not the driver.

---

## Recommended fixes (NOT implemented — for decision)

Ordered by leverage. These are options, not instructions.

1. **Raise the watchdog and/or make it activity-based (highest leverage, addresses the
   primary cause).** 900 s is simply too low for a slow local reasoning model on a
   multi-turn render card. Options:
   - Bump `DEFAULT_PI_TIMEOUT_MS` (e.g. 30–45 min) for these render columns, or make it
     per-column configurable.
   - Better: convert the hard wall-clock watchdog into an **idle/inactivity** watchdog — reset
     the timer whenever new bytes arrive on stdout/stderr, so a session that is making
     progress is never killed, but a genuinely silent-for-N-minutes session still is. (Pairs
     naturally with fix 2.)

2. **Stream pi output and persist incrementally so a kill keeps partial work (addresses the
   secondary cause / the empty transcript).** Read `proc.stdout` as a stream and append to the
   transcript as chunks arrive (or capture `collected.out` from a running accumulator rather
   than only the resolved-at-EOF text). Then even a watchdog-killed session yields a real
   transcript, which (a) lets the C4 verdict-extraction fallback rescue partial work instead of
   recording "empty", and (b) makes the *next* investigation trivial. NOTE: pi buffers per
   *turn*, so streaming gives you completed turns, not token-by-token — still hugely better
   than nothing. If pi supports a `--mode json`/streaming or NDJSON output mode, prefer that.

3. **Bound the reasoning budget / turn count for background cards.** The model.json sets
   `budget=2147483647` (unbounded). Capping reasoning tokens or max agentic turns per session
   would tighten the long tail that overruns the watchdog, at some quality cost. Consider only
   if 1+2 prove insufficient.

4. **Keep the godot-timeout hygiene rule (defensive, not the observed cause).** The
   "timeout-wrap godot, run `godot --import` before headless quit, never a GUI godot without a
   display" rule should stay — a hung godot is a plausible *other* watchdog trigger that the
   empty transcript would hide. Once fix 2 lands, a future hang caused by a hung tool will be
   visible in the partial transcript and can be diagnosed properly rather than guessed at.

**Do NOT** treat this as "just raise the timeout" alone. Without fix 2 you remain blind: every
future kill still writes an empty transcript and the next person repeats this entire
investigation. Fixes 1 and 2 together are the real remedy — 1 stops killing work that would
have finished, 2 makes any remaining kill diagnosable.

---

## Confidence

- **Mechanism of the empty transcript (buffered read + kill):** very high — proven by the
  65-second-then-flush streaming test plus the code path.
- **Live hang is model-slow, not a stuck process:** very high — proven by continuous token
  decode on frame + healthy socket + ~1% CPU + no godot child, all sampled during the hang.
- **Model-slow explains the majority of historical exit-124s:** medium-high — one caught
  red-handed; the buffering artifact prevents per-incident re-litigation of the older ones,
  and an occasional hung-godot or preemption case cannot be fully excluded.
