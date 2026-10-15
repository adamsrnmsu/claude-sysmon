# sysmon

A hacker-style live pane for Claude Code: neon braille line graphs of memory use,
network download (RX) and upload (TX), and context tokens per turn.

```
▌MEM 75% :: 12.0/16 GB
⠀⠀⠀⠀⠀⠀⣀⣀⡠⠤⠤⠒⠒⠒⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉
▌RX  1.2 MB/s :: peak 4.5 MB/s
⠀⠀⡀⢀⠀⠀⢠⠃⢣⠀⡰⠁⠀⠑⢄⠀⠀⢀⠔⠁⠀⠀
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

## Limitations

- macOS only: it reads `vm_stat` and `netstat`. On Linux or Windows the graphs stay empty.
- Needs a Claude Code build with mods (plugin hooks modules), which are early access.
- Network speed is summed across every non-loopback interface, VPN tunnels included.
- A failed sample is skipped silently.
