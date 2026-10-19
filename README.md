# sysmon

A hacker-style live pane for Claude Code: neon braille line graphs of memory use,
network download (RX) and upload (TX), model output speed (TPS) and context tokens
per turn, with rate limits, cost, battery and an attention line for agents that
are waiting on you.

```
▌ATTN job blocked :: bennu PR :: approve the plan
▌UP  1h12m :: $4.12 :: $3.43/hr
▌AGT 5 running :: 3 sessions, 2 busy
▌5H  ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░ 62% :: resets 1h12m
▌PWR 82% discharging
⠀⠀⠀⠀⠀⠀⣀⣀⡠⠤⠤⠒⠒⠒⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉
▌MEM 75% :: 12.0/16 GB
⠀⠀⡀⢀⠀⠀⢠⠃⢣⠀⡰⠁⠀⠑⢄⠀⠀⢀⠔⠁⠀⠀
▌RX  1.2 MB/s :: peak 4.5 MB/s
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install sysmon --marketplace adamsrnmsu/claude-sysmon
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install sysmon --marketplace adamsrnmsu/claude-sysmon
```

## Use

`/sysmon` opens the pane. It also opens by itself when the terminal is at least
144 columns wide. Memory and network are sampled every second; the token graph
adds a point after each turn.

- **ATTN** (at most two lines): background jobs whose state is blocked or failed,
  and, across every session on the machine, subagents that are waiting or failed
  and sessions sitting on a permission or input prompt.
- **UP**: session uptime, cost so far and burn rate.
- **AGT**: running subagents summed across every session, and how many sessions
  are live and busy.
- **5H / 7D**: rate-limit windows and when they reset (subscriptions only).
- **PWR**: battery, and `THROTTLED` when macOS limits the CPU (hidden on desktops).
- **TPS**: streamed model output, estimated at 4 characters a token.
- **TOK**: a red `▼` marks each turn where the context fell 30% or more (a compaction or `/clear`).

Each graph's label sits under it as a caption.

Clawd stands at the bottom of the pane. It waves when something waits on you
and otherwise blinks, with a trick every so often: a wave, a nap, a flower
pulled out from behind its back, or a top hat. It hides when the pane is too
short to keep every graph's label.

A reading past its red line turns red and raises one notification as it crosses:
memory 90%, context 85%, a rate limit 90%, battery 15% while discharging, or throttling.

## Limitations

- macOS only: it reads `vm_stat` and `netstat`. On Linux or Windows the graphs stay empty.
- Needs a Claude Code build with mods (plugin hooks modules), which are early access.
- Network speed is summed across every non-loopback interface, VPN tunnels included.
- A failed sample is skipped silently.
- The job lines read Claude Code's own `~/.claude/jobs/*/state.json` files, which are
  not a documented interface; a Claude Code update can silently empty them.
- Cross-session counts come from Claude Code's `~/.claude/sessions/*.json` registry
  (undocumented) and a heartbeat each sysmon writes to `~/.claude/sysmon/<session>.json`
  every 5 seconds. A session without sysmon 0.3.0 or later counts toward sessions
  but not toward agents; a crashed session leaves a heartbeat file behind.
- Organization-managed installs skip the `classic.Notification` hook, so the
  permission-prompt line stays empty there.
