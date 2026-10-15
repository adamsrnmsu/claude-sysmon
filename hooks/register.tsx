import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Samples } from '../types'

const PANE = 'sysmon'
const TITLE = '>_ SYSMON :: gibson-01'
const KEEP = 240
const ROWS = 4 // text rows per graph; each braille cell is 4 dots tall
const EMPTY: Samples = { mem: [], rx: [], tx: [], memUsedGb: 0, memTotalGb: 0, tokens: [], window: 0 }
const samples = atom({ plugin: 'sysmon', key: 'samples' } as const, EMPTY)

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

export const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export const rate = (bps: number) =>
  bps >= 1 << 20 ? `${(bps / (1 << 20)).toFixed(1)} MB/s`
  : bps >= 1 << 10 ? `${(bps / (1 << 10)).toFixed(1)} KB/s`
  : `${Math.round(bps)} B/s`

const last = (xs: number[]) => xs[xs.length - 1] ?? 0

export const register: Register = on => {
  let prevNet: { rx: number; tx: number; at: number } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sysmon', description: 'Open the live memory and network graphs' })
    void $.ui.open({ id: PANE, title: TITLE })

    const total = Number((await $.process.run(['sysctl', '-n', 'hw.memsize'])).stdout.trim())
    $.clock.every(1000, () => {
      void (async () => {
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
        prevNet = cur
        await update($, samples, s => ({
          ...s,
          mem: [...s.mem, (used / total) * 100].slice(-KEEP),
          rx: [...s.rx, rx].slice(-KEEP),
          tx: [...s.tx, tx].slice(-KEEP),
          memUsedGb: used / 2 ** 30,
          memTotalGb: total / 2 ** 30,
        }))
      })().catch(() => undefined) // ponytail: a failed sample is skipped silently; surface via $.ui.status if it matters
    })

    return next(e)
  })

  // Context tokens after each main-thread turn: watch the session fill and compactions drop it
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const { context } = await $.session.usage()
      await update($, samples, s => ({
        ...s,
        tokens: [...(s.tokens ?? []), context.tokens ?? 0].slice(-KEEP),
        window: context.window,
      }))
    }
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sysmon' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Sysmon online.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // State outlives hot reloads; fill fields an older version of this mod did not store
    const s = { ...EMPTY, ...(await read($, samples)) }
    const cols = Math.max(10, e.props.bodyColumns || 60)
    const peak = (xs: number[]) => Math.max(1024, ...xs.slice(-cols * 2))

    const graph = (label: string, value: string, xs: number[], max: number, color: string) => (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color={color} bold>{`▌${label} `}</Text>
          <Text color="#00ff41">{value}</Text>
        </Text>
        {braille(xs, max, ROWS, cols).map(line => <Text color={color}>{line}</Text>)}
      </Box>
    )

    if (s.mem.length === 0) return <Text color="#00ff41" dimColor>establishing uplink...</Text>

    return (
      <Box flexDirection="column">
        {graph('MEM', `${last(s.mem).toFixed(0)}% :: ${s.memUsedGb.toFixed(1)}/${s.memTotalGb.toFixed(0)} GB`, s.mem, 100, '#00ff41')}
        {graph('RX ', `${rate(last(s.rx))} :: peak ${rate(peak(s.rx))}`, s.rx, peak(s.rx), '#00ffff')}
        {graph('TX ', `${rate(last(s.tx))} :: peak ${rate(peak(s.tx))}`, s.tx, peak(s.tx), '#ff00ff')}
        {s.tokens.length > 0 &&
          graph('TOK', `${kTok(last(s.tokens))}/${kTok(s.window)} :: ${s.tokens.length} turns`, s.tokens, s.window, '#ffd000')}
      </Box>
    )
  })
}
