import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { Beat, Power, Samples } from '../types'

const PANE = 'sysmon'
const KEEP = 240
const ROWS = 4 // most text rows per graph; each braille cell is 4 dots tall
const GREEN = '#00ff41'
const RED = '#ff0033'
const ORANGE = '#ff8800'
const CLAY = '#d97757'
const PINK = '#ff79c6'
const HAT = '#b0b0ff'
const EMPTY: Samples = {
  mem: [], rx: [], tx: [], memUsedGb: 0, memTotalGb: 0, tokens: [], window: 0,
  tps: [], limits: [], costUsd: 0, startedAt: 0, now: 0, running: 0, power: null, attn: [], prompt: '',
  sessions: 0, busy: 0, peerRunning: 0,
}
const samples = atom({ plugin: 'sysmon', key: 'samples' } as const, EMPTY)
const LIMIT_LABEL: Record<string, string> = { five_hour: '5H ', seven_day: '7D ', spend_limit: '$$ ' }
// The engine's notification types that mean the session sits waiting on the person
const WAITING = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog'])

// Activity Monitor's "Memory Used": app (active) + wired + compressed pages
export const parseVmStat = (out: string) => {
  const pageSize = Number(/page size of (\d+)/.exec(out)?.[1] ?? 4096)
  const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0)
  return (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize
}

// Total bytes in/out across every non-loopback interface (one <Link#> row each)
export const parseNetstat = (out: string) => {
  let rx = 0
  let tx = 0
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (!f[2]?.startsWith('<Link#') || f[0]?.startsWith('lo')) continue
    // Link rows with no MAC have one column fewer; count from the end
    rx += Number(f[f.length - 5]) || 0
    tx += Number(f[f.length - 2]) || 0
  }
  return { rx, tx }
}

// `pmset -g batt` and `pmset -g therm`; null on a Mac with no battery
export const parsePmset = (batt: string, therm: string): Power | null => {
  const m = /(\d+)%;\s*([^;]+);/.exec(batt)
  if (!m) return null
  const speed = Number(/CPU_Speed_Limit\s*=\s*(\d+)/.exec(therm)?.[1] ?? 100)
  // "No thermal warning level has been recorded" carries no digit, so it never matches
  const level = Number(/(?:thermal|performance) warning level[^\d\n]*(\d+)/i.exec(therm)?.[1] ?? 0)
  return { percent: Number(m[1]), state: m[2]!.trim(), throttled: speed < 100 || level > 0 }
}

// Braille line chart: 2 samples per cell, consecutive points joined vertically
export const braille = (values: number[], max: number, rows: number, cols: number) => {
  const h = rows * 4
  const cells = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  const pts = values.slice(-cols * 2)
  const offset = cols * 2 - pts.length // right-align so the newest sample is at the edge
  const BITS = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]] as const
  let prev: number | undefined
  pts.forEach((v, i) => {
    const y = Math.round((Math.min(v, max) / (max || 1)) * (h - 1))
    const lo = Math.min(prev ?? y, y)
    const hi = Math.max(prev ?? y, y)
    const x = i + offset
    for (let d = lo; d <= hi; d++) {
      const top = h - 1 - d
      const row = cells[Math.floor(top / 4)]
      if (row) row[Math.floor(x / 2)]! |= BITS[x % 2]![top % 4]!
    }
    prev = y
  })
  return cells.map(row => row.map(b => String.fromCharCode(0x2800 + b)).join(''))
}

// ▼ under each turn whose context fell by 30% or more (a compaction or a /clear), aligned with braille()
export const drops = (values: number[], cols: number) => {
  const pts = values.slice(-cols * 2)
  const offset = cols * 2 - pts.length
  const row = new Array<string>(cols).fill(' ')
  pts.forEach((v, i) => {
    if (i > 0 && v < pts[i - 1]! * 0.7) row[Math.floor((i + offset) / 2)] = '▼'
  })
  return row.join('')
}

export const bar = (pct: number, width: number) => {
  const n = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * width)
  return '▓'.repeat(n) + '░'.repeat(width - n)
}

export const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  return m >= 1440 ? `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`
    : m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
    : `${m}m`
}

// Braille rows per graph: the room left after the text lines, shared out, 0 (the readout alone) to ROWS.
// Each graph also takes a row for its label. No room given (0): full height.
export const graphRows = (room: number, text: number, graphs: number) =>
  room > 0 ? Math.min(ROWS, Math.max(0, Math.floor((room - text) / graphs) - 1)) : ROWS

export const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export const rate = (bps: number) =>
  bps >= 1 << 20 ? `${(bps / (1 << 20)).toFixed(1)} MB/s`
  : bps >= 1 << 10 ? `${(bps / (1 << 10)).toFixed(1)} KB/s`
  : `${Math.round(bps)} B/s`

const last = (xs: number[]) => xs[xs.length - 1] ?? 0

// Every reading past its red line, by key: the pane draws these red and the tick notifies on new ones
export const alarms = (s: Samples) => [
  ...(last(s.mem) >= 90 ? ['MEM'] : []),
  ...(s.window && last(s.tokens) / s.window >= 0.85 ? ['TOK'] : []),
  ...s.limits.filter(l => l.percentUsed >= 90).map(l => l.kind),
  ...(s.power && (s.power.throttled || (s.power.percent <= 15 && s.power.state === 'discharging')) ? ['PWR'] : []),
]

// Background jobs blocked on the person or failed. Reads Claude Code's own job
// files, which are not a documented interface and may change shape.
const jobAttention = async ($: EngineInterface) => {
  const dir = `${await $.env.get('HOME')}/.claude/jobs`
  const out: string[] = []
  for (const d of await $.fs.list(dir)) {
    if (d.kind !== 'dir') continue
    try {
      const j = JSON.parse(await $.fs.read(`${dir}/${d.name}/state.json`))
      if (j.state === 'blocked' || j.state === 'failed') out.push(`job ${j.state} :: ${j.name ?? d.name} :: ${j.detail ?? ''}`)
    } catch {} // no state file yet, or read mid-write; the next pass sees it
  }
  return out
}

// Every live session on the machine: Claude Code's registry (one file per process; undocumented)
// joined with the heartbeat each session's sysmon writes, which carries what the registry lacks
export const peers = async ($: EngineInterface, home: string, me: string, now: number) => {
  const reg = `${home}/.claude/sessions`
  const sessions: { pid: number; sessionId: string; name?: string; status?: string }[] = []
  for (const f of await $.fs.list(reg)) {
    if (!f.name.endsWith('.json')) continue
    try {
      sessions.push(JSON.parse(await $.fs.read(`${reg}/${f.name}`)))
    } catch {} // read mid-write; the next pass sees it
  }
  // A crashed process leaves its file behind: keep the sessions whose pid still runs
  const ps = await $.process.run(['ps', '-o', 'pid=', '-p', sessions.map(s => s.pid).join(',') || '1'])
  const alive = new Set(ps.stdout.split(/\s+/).filter(Boolean))
  const live = sessions.filter(s => alive.has(String(s.pid)))
  let running = 0
  const attn: string[] = []
  for (const s of live) {
    if (s.sessionId === me) continue
    try {
      const b: Beat = JSON.parse(await $.fs.read(`${home}/.claude/sysmon/${s.sessionId}.json`))
      if (now - b.at > 20_000) continue // its sysmon stopped, or is a version without heartbeats
      const name = s.name ?? s.sessionId.slice(0, 8)
      running += b.running
      if (b.prompt) attn.push(`session ${name} :: ${b.prompt}`)
      attn.push(...b.attn.map(line => `${line} @ ${name}`))
    } catch {} // no sysmon heartbeat from that session
  }
  return { sessions: live.length, busy: live.filter(s => s.status === 'busy').length, running, attn }
}

// Clawd, Claude Code's mascot: a row for a hat or a raised flower, then three of Clawd
const CLAWD = {
  idle: ['          ', ' ▐▛███▜▌  ', '▝▜█████▛▘ ', '  ▘▘ ▝▝   '],
  blink: ['          ', ' ▐█████▌  ', '▝▜█████▛▘ ', '  ▘▘ ▝▝   '],
  wave: ['          ', ' ▐▛███▜▌▗ ', '▝▜█████▛▘ ', '  ▘▘ ▝▝   '],
  wave2: ['          ', ' ▐▛███▜▌▝ ', '▝▜█████▛  ', '  ▘▘ ▝▝   '],
  step: ['          ', ' ▐▛███▜▌  ', '▝▜█████▛▘ ', '  ▝▝ ▘▘   '],
  reach: ['          ', ' ▐▛███▜▌  ', '▝▜█████▛  ', '  ▘▘ ▝▝   '],
  flower: ['          ', ' ▐▛███▜▌  ', '▝▜█████▛▘✿', '  ▘▘ ▝▝   '],
  bloom: ['        ✿ ', ' ▐▛███▜▌▐ ', '▝▜█████▛▘ ', '  ▘▘ ▝▝   '],
  hat: ['  ▄███▄   ', ' ▐▛███▜▌  ', '▝▜█████▛▘ ', '  ▘▘ ▝▝   '],
  tip: ['   ▄███▄  ', ' ▐▛███▜▌▝ ', '▝▜█████▛  ', '  ▘▘ ▝▝   '],
}
const WALK = 6 // cells Clawd wanders along the bottom
const HOME = 2

// What Clawd does this second: reacts to the pane's state, else an antic now and then.
// Pure in s.now, so the pane's own once-a-second redraw animates it.
export const clawd = (s: Samples): { pose: keyof typeof CLAWD; dx: number; say: string } => {
  const t = Math.floor(s.now / 1000)
  const odd = t % 2 === 1
  if (alarms(s).length) return { pose: odd ? 'step' : 'idle', dx: odd ? HOME - 1 : HOME + 1, say: '!!' }
  if (s.prompt || s.attn.length) return { pose: odd ? 'wave2' : 'wave', dx: HOME, say: 'hey' }
  if (last(s.tps) > 0) return { pose: odd ? 'step' : 'idle', dx: HOME, say: '...' }
  const beat = t % 20 // ponytail: antics on a fixed 20s cycle; randomize if it feels too regular
  if (beat < 4) {
    switch (Math.floor(t / 20) % 6) {
      case 0: return { pose: odd ? 'step' : 'idle', dx: [3, 4, 6, 4][beat]!, say: '' }
      case 1: return { pose: odd ? 'wave2' : 'wave', dx: HOME, say: 'hi' }
      case 2: return { pose: 'blink', dx: HOME, say: beat % 2 ? 'zZ' : 'z' }
      case 3: return { pose: (['reach', 'flower', 'bloom', 'bloom'] as const)[beat]!, dx: HOME, say: beat > 1 ? 'ta-da' : '' }
      case 4: return { pose: odd ? 'tip' : 'hat', dx: HOME, say: odd ? 'fancy' : '' }
      default: return { pose: 'idle', dx: beat < 2 ? 0 : WALK, say: '?' }
    }
  }
  return { pose: t % 5 === 0 ? 'blink' : 'idle', dx: HOME, say: '' }
}

// Clawd's rows as colored runs, a fixed width so nothing beside them shifts
export const clawdRows = (s: Samples) => {
  const { pose, dx, say } = clawd(s)
  const hatted = pose === 'hat' || pose === 'tip'
  return CLAWD[pose].map((line, i) => {
    const row = `${' '.repeat(dx)}${line} ${i === 1 ? say : ''}`.padEnd(WALK + 16)
    return row.split(/(✿)/).filter(Boolean).map(text => ({
      text,
      color: text === '✿' ? PINK : hatted && i === 0 ? HAT : CLAY,
    }))
  })
}

let hot = new Set<string>()

// Every write goes through here, so a reading that crosses its red line notifies once, whatever wrote it
const put = async ($: EngineInterface, fn: (s: Samples) => Samples): Promise<Samples> => {
  let next = EMPTY
  // State outlives hot reloads; fill fields an older version of this mod did not store
  await update($, samples, s => (next = fn({ ...EMPTY, ...s })))
  const now = alarms(next)
  const fresh = now.filter(k => !hot.has(k))
  hot = new Set(now)
  if (fresh.length) void $.ui.notify(`${fresh.map(k => LIMIT_LABEL[k]?.trim() ?? k).join(', ')} in the red`, { title: 'SYSMON' }).catch(() => undefined)
  return next
}

export const register: Register = on => {
  let prevNet: { rx: number; tx: number; at: number } | undefined
  let chars = 0 // streamed text and thinking since the last tick
  let title = '>_ SYSMON'
  let beat = '' // this session's heartbeat file

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sysmon', description: 'Open the live memory and network graphs' })
    const host = (await $.process.run(['hostname', '-s']).catch(() => undefined))?.stdout.split('\n')[0]?.trim()
    title = `>_ SYSMON :: ${host || 'localhost'}`
    void $.ui.open({ id: PANE, title })
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    const me = await $.session.id().catch(() => '')
    if (home && me) beat = `${home}/.claude/sysmon/${me}.json`

    const usage = await $.session.usage().catch(() => undefined)
    if (usage) {
      await put($, s => ({
        ...s,
        startedAt: usage.startedAt,
        limits: usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
        costUsd: usage.cost?.usd ?? 0,
      }))
    }

    const total = Number((await $.process.run(['sysctl', '-n', 'hw.memsize'])).stdout.trim())
    const sample = async () => {
      const [vm, net] = await Promise.all([
        $.process.run(['vm_stat']),
        $.process.run(['netstat', '-ib']),
      ])
      const used = parseVmStat(vm.stdout)
      const now = await $.clock.now()
      const cur = { ...parseNetstat(net.stdout), at: now }
      const secs = prevNet ? Math.max((now - prevNet.at) / 1000, 0.001) : 0
      // A counter that went backwards (interface reset) reads as 0, not a negative spike
      const rx = prevNet ? Math.max(cur.rx - prevNet.rx, 0) / secs : 0
      const tx = prevNet ? Math.max(cur.tx - prevNet.tx, 0) / secs : 0
      const tps = prevNet ? chars / 4 / secs : 0 // ponytail: ~4 chars a token; the stop chunk's usage is exact but lands once per step
      chars = 0
      prevNet = cur
      await put($, s => ({
        ...s,
        mem: [...s.mem, (used / total) * 100].slice(-KEEP),
        rx: [...s.rx, rx].slice(-KEEP),
        tx: [...s.tx, tx].slice(-KEEP),
        tps: [...s.tps, tps].slice(-KEEP),
        memUsedGb: used / 2 ** 30,
        memTotalGb: total / 2 ** 30,
        now,
      }))
    }
    // Slower sources, each on its own so one failing leaves the others standing
    const slow = async () => {
      const now = await $.clock.now()
      const [batt, therm, agents, jobs, others] = await Promise.all([
        $.process.run(['pmset', '-g', 'batt']).then(r => r.stdout, () => ''),
        $.process.run(['pmset', '-g', 'therm']).then(r => r.stdout, () => ''),
        $.agent.list().catch((): AgentInfo[] => []),
        jobAttention($).catch((): string[] => []),
        home ? peers($, home, me, now).catch(() => undefined) : undefined,
      ])
      const running = agents.filter(a => a.status === 'running' || a.status === 'pending').length
      const mine = agents.filter(a => a.status === 'waiting' || a.status === 'failed')
        .map(a => `agent ${a.status} :: ${a.name ?? a.description}`)
      const s = await put($, s => ({
        ...s,
        power: parsePmset(batt, therm),
        running,
        sessions: others?.sessions ?? 0,
        busy: others?.busy ?? 0,
        peerRunning: others?.running ?? 0,
        attn: [...mine, ...(others?.attn ?? []), ...jobs],
      }))
      const out: Beat = { at: now, running, attn: mine, prompt: s.prompt }
      if (beat) void $.fs.write(beat, JSON.stringify(out)).catch(() => undefined)
    }
    let tick = 0
    $.clock.every(1000, () => {
      void sample().catch(() => undefined) // ponytail: a failed sample is skipped silently; surface via $.ui.status if it matters
      if (tick++ % 5 === 0) void slow().catch(() => undefined)
    })

    return next(e)
  })

  // A clean exit takes its heartbeat with it; a crash leaves one that goes stale in 20s
  on('session.end', async ($, e, next) => {
    if (beat) await $.process.run(['rm', '-f', beat]).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Rate-limit windows and cost, pushed by the engine whenever they move
  on('session.measure', async ($, e, next) => {
    await put($, s => ({
      ...s,
      limits: e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
      costUsd: e.cost?.usd ?? s.costUsd,
    }))
    return next(e)
  }).catch(($, e, next) => next(e))

  // Count what the model streams (every loop's) for the tok/s graph; the chunks pass through untouched
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    for await (const c of stream) {
      if (c.kind === 'text' || c.kind === 'thinking') chars += c.text.length
      yield c
    }
    return await stream.result
  })

  // This session waiting on the person: a permission prompt, or idle at the prompt
  on('classic.Notification', async ($, e, next) => {
    if (WAITING.has(e.notification_type)) await put($, s => ({ ...s, prompt: e.message }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    await put($, s => ({ ...s, prompt: '' }))
    return next(e)
  }).catch(($, e, next) => next(e))

  // Context tokens after each main-thread turn: watch the session fill and compactions drop it
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const { context } = await $.session.usage()
      await put($, s => ({
        ...s,
        tokens: [...s.tokens, context.tokens ?? 0].slice(-KEEP),
        window: context.window,
        prompt: '', // a turn that finished is no longer held on a permission prompt
      }))
    }
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sysmon' }, async $ => {
    await $.ui.open({ id: PANE, title })
    return { text: 'Sysmon online.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = { ...EMPTY, ...(await read($, samples)) }
    const cols = Math.max(10, e.props.bodyColumns || 60)
    const peak = (xs: number[], floor: number) => Math.max(floor, ...xs.slice(-cols * 2))
    const hot = alarms(s)
    const tint = (key: string, color: string) => (hot.includes(key) ? RED : color)

    const row = (label: string, value: string, color: string) => (
      <Text wrap="truncate">
        <Text color={color} bold>{`▌${label} `}</Text>
        <Text color={color === RED ? RED : GREEN}>{value}</Text>
      </Text>
    )

    if (s.mem.length === 0) return <Text color={GREEN} dimColor>establishing uplink...</Text>

    const attn = [...(s.prompt ? [`this session :: ${s.prompt}`] : []), ...s.attn]
    const shown = attn.length > 2 ? [attn[0]!, `+${attn.length - 2} more :: ${attn[1]}`] : attn
    const up = s.startedAt ? s.now - s.startedAt : 0
    const burn = up > 60_000 ? ` :: $${(s.costUsd / (up / 3_600_000)).toFixed(2)}/hr` : ''
    const ctxColor = tint('TOK', '#ffd000')
    const marks = drops(s.tokens, cols)
    const showMarks = s.tokens.length > 0 && marks.includes('▼')
    const room = e.props.scroll?.bodyRows ?? 0
    const graphs = s.tokens.length > 0 ? 5 : 4
    const head = shown.length + 2 + s.limits.length + (s.power ? 1 : 0) + (showMarks ? 1 : 0)
    // Clawd's 4 rows at the bottom, only where every graph's label still fits
    const pet = cols >= 24 && (room === 0 || room - head - 4 >= graphs)
    const rows = graphRows(room, head + (pet ? 4 : 0), graphs)
    // The label reads as a caption under its braille
    const graph = (label: string, value: string, xs: number[], max: number, color: string, under?: string) => (
      <Box flexDirection="column">
        {braille(xs, max, rows, cols).map(line => <Text color={color}>{line}</Text>)}
        {under && <Text color={RED}>{under}</Text>}
        {row(label, value, color)}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {shown.map(line => row('ATTN', line, RED))}
        {row('UP ', `${dur(up)} :: $${s.costUsd.toFixed(2)}${burn}`, GREEN)}
        {row('AGT', `${s.running + s.peerRunning} running${s.sessions ? ` :: ${s.sessions} sessions, ${s.busy} busy` : ''}`, GREEN)}
        {s.limits.map(l => row(LIMIT_LABEL[l.kind] ?? l.kind,
          `${bar(l.percentUsed, 20)} ${l.percentUsed}%${l.resetsAt ? ` :: resets ${dur(Date.parse(l.resetsAt) - s.now)}` : ''}`,
          tint(l.kind, '#00ffff')))}
        {s.power && row('PWR', `${s.power.percent}% ${s.power.state}${s.power.throttled ? ' :: THROTTLED' : ''}`, tint('PWR', ORANGE))}
        {graph('MEM', `${last(s.mem).toFixed(0)}% :: ${s.memUsedGb.toFixed(1)}/${s.memTotalGb.toFixed(0)} GB`, s.mem, 100, tint('MEM', GREEN))}
        {graph('RX ', `${rate(last(s.rx))} :: peak ${rate(peak(s.rx, 1024))}`, s.rx, peak(s.rx, 1024), '#00ffff')}
        {graph('TX ', `${rate(last(s.tx))} :: peak ${rate(peak(s.tx, 1024))}`, s.tx, peak(s.tx, 1024), '#ff00ff')}
        {graph('TPS', `~${Math.round(last(s.tps))} tok/s :: peak ~${Math.round(peak(s.tps, 10))}`, s.tps, peak(s.tps, 10), ORANGE)}
        {s.tokens.length > 0 &&
          graph('TOK', `${kTok(last(s.tokens))}/${kTok(s.window)} :: ${s.tokens.length} turns`, s.tokens, s.window, ctxColor,
            showMarks ? marks : undefined)}
        {pet && clawdRows(s).map(runs => (
          <Text wrap="truncate">{runs.map(r => <Text color={r.color}>{r.text}</Text>)}</Text>
        ))}
      </Box>
    )
  })
}
