import { expect, mock, test } from 'claude-code/testing'

import { alarms, bar, braille, clawd, clawdRows, drops, dur, graphRows, parseNetstat, parsePmset, parseVmStat, peers, rate } from '../hooks/register'

const VM = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                                     4797.
Pages active:                                     10.
Pages wired down:                                  5.
Pages occupied by compressor:                      1.`

const NET = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                         50     0       9999       50     0       9999     0
en0        1500  <Link#6>    02:00:00:00:00:01  3103464     0 4000     834989     0  900     0
en0        1500  10.0.0        host.lan         3103464     - 4000     834989     -  900     -
utun0      1380  <Link#20>                         5     0        100        5     0         50     0`

test('parses macOS vm_stat and netstat output', async () => {
  expect(parseVmStat(VM)).toBe(16 * 4096)
  expect(parseNetstat(NET)).toEqual({ rx: 4100, tx: 950 })
  expect(rate(2.5 * 1024 * 1024)).toBe('2.5 MB/s')
  expect(rate(500)).toBe('500 B/s')
})

test('braille draws a right-aligned line joined between points', async () => {
  // flat at the bottom: only the bottom dot row lit (0x40 left + 0x80 right = 0x28C0)
  expect(braille([0, 0, 0, 0], 100, 1, 2)).toEqual(['⣀⣀'])
  // one sample right-aligned in a 2-cell chart, at the top: right column top dot (0x08)
  expect(braille([100], 100, 1, 2)).toEqual(['⠀⠈'])
  // a jump from bottom to top in one step fills the whole right column of the cell
  expect(braille([0, 100], 100, 1, 1)).toEqual([String.fromCharCode(0x2800 + 0x40 + 0x08 + 0x10 + 0x20 + 0x80)])
  expect(braille([0, 50, 100], 100, 2, 3)).toHaveLength(2)
})

test('samples every second and draws three graphs in the pane', async ($, on) => {
  const clock = mock.clock(on)
  let rx = 4000
  on('process.run', ($, e) => {
    const cmd = e.argv[0]
    if (cmd === 'sysctl') return { value: { exitCode: 0, stdout: String(16 * 4096 * 2), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'vm_stat') return { value: { exitCode: 0, stdout: VM, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    rx += 2048
    return { value: { exitCode: 0, stdout: NET.replace(' 4000 ', ` ${rx} `), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'sysmon', surface, component: 'Pane', requestId: 'sysmon', props: {} as never })
    expect(await ui.find({ type: 'Text', text: /MEM.*50% :: / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /RX.*2\.0 KB\/s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /TX.*0 B\/s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /TOK/ })).toBeUndefined()
    // each label is a caption under its braille, the last graph's too
    const texts = (await ui.findAll({ type: 'Text' })).filter(t => t.props.color === '#ff00ff').map(t => t.text)
    expect(texts[texts.length - 1]).toMatch(/^▌TX/)
    expect(texts[0]).toMatch(/^[\u2800-\u28ff]+$/)
    expect(await ui.find({ type: 'Text', text: /▐▛███▜▌/ })).toBeDefined() // Clawd
    await ui.unmount()
  }
})

test('records context tokens after each main-thread turn', async ($, on) => {
  const clock = mock.clock(on)
  let tokens = 20000 // session.start reads usage once (40k) before the two turns
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: e.argv[0] === 'sysctl' ? '131072' : e.argv[0] === 'vm_stat' ? VM : NET, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: (tokens += 20000), window: 200000 } } }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const turn = { answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' as const }
  await $.turn.complete({ ...turn, turnId: 't1' })
  await $.turn.complete({ ...turn, turnId: 't2' })
  await $.turn.complete({ ...turn, turnId: 'sub', agentId: 'a1' })
  const ui = await $.ui.mount({ plugin: 'sysmon', surface: 'terminal', component: 'Pane', requestId: 'sysmon', props: {} as never })
  expect(await ui.find({ type: 'Text', text: /TOK.*80\.0k\/200\.0k :: 2 turns/ })).toBeDefined()
  await ui.unmount()
})

test('parses pmset battery and thermal state', async () => {
  const batt = ` -InternalBattery-0 (id=7405667)\t82%; discharging; 3:12 remaining present: true`
  const calm = `Note: No thermal warning level has been recorded\n\tCPU_Speed_Limit \t= 100`
  expect(parsePmset(batt, calm)).toEqual({ percent: 82, state: 'discharging', throttled: false })
  expect(parsePmset(batt, '\tCPU_Speed_Limit \t= 70')?.throttled).toBe(true)
  expect(parsePmset(batt, 'Thermal warning level set to 2.')?.throttled).toBe(true)
  expect(parsePmset(`Now drawing from 'AC Power'`, calm)).toBeNull() // a desktop Mac
})

test('formats bars, durations, compaction marks and red lines', async () => {
  expect(bar(50, 4)).toBe('▓▓░░')
  expect(bar(140, 2)).toBe('▓▓')
  expect(dur(72 * 60000)).toBe('1h12m')
  expect(dur(26 * 3600000)).toBe('1d2h')
  // 100k then 30k is a compaction: its mark lands in the right cell of a 2-cell row
  expect(drops([100, 120, 100, 30], 2)).toBe(' ▼')
  expect(drops([100, 90, 80], 2)).toBe('  ')
  expect(graphRows(0, 5, 5)).toBe(4) // no room given: full height
  expect(graphRows(60, 5, 5)).toBe(4) // tall pane: capped
  expect(graphRows(25, 5, 5)).toBe(3) // 5 text + 5 graphs of (label + 3) = 25
  expect(graphRows(12, 5, 5)).toBe(0) // too short: label readouts only
  expect(braille([1, 2], 2, 0, 3)).toEqual([])
  const calm = { mem: [50], rx: [], tx: [], memUsedGb: 0, memTotalGb: 0, tokens: [100], window: 1000, tps: [], limits: [{ kind: 'five_hour', percentUsed: 40 }], costUsd: 0, startedAt: 0, now: 0, running: 0, power: null, attn: [], prompt: '', sessions: 0, busy: 0, peerRunning: 0 }
  expect(alarms(calm)).toEqual([])
  expect(alarms({ ...calm, mem: [95], tokens: [900], limits: [{ kind: 'five_hour', percentUsed: 92 }], power: { percent: 10, state: 'discharging', throttled: false } }))
    .toEqual(['MEM', 'TOK', 'five_hour', 'PWR'])
})

test('shows limits, power, agents and the attention lines', async ($, on) => {
  const clock = mock.clock(on)
  const run = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    const [cmd, , sub] = e.argv
    if (cmd === 'sysctl') return run('131072')
    if (cmd === 'vm_stat') return run(VM)
    if (cmd === 'hostname') return run('gibson\n')
    if (cmd === 'pmset') return run(sub === 'batt' ? '\t12%; discharging; 0:40 remaining' : '\tCPU_Speed_Limit \t= 100')
    return run(NET)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  const titles: string[] = []
  on('ui.open', (_$, e) => (titles.push(e.title ?? ''), { value: { isPlaced: true as const } }))
  const notes: string[] = []
  on('ui.notify', (_$, e) => (notes.push(e.text), { value: { isSent: true as const, channel: 'terminal_bell' } }))
  on('session.usage', () => ({
    value: { startedAt: 3000 - 2 * 3600000, context: { tokens: 0, window: 200000 }, cost: { usd: 3 }, rateLimits: [{ kind: 'five_hour', percentUsed: 62, resetsAt: new Date(72 * 60000).toISOString() }] },
  }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: 'scan logs', type: 'Explore', status: 'running' as const },
      { id: 'a2', description: 'plan approval', type: 'Plan', status: 'waiting' as const, name: 'planner' },
    ],
  }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.list', () => ({ value: [{ name: 'j1', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }, { name: 'j2', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', (_$, e) => ({
    value: e.path.includes('j1') ? JSON.stringify({ state: 'blocked', name: 'bennu PR', detail: 'approve the plan' }) : JSON.stringify({ state: 'working' }),
  }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(titles[0]).toBe('>_ SYSMON :: gibson')
  expect(notes).toEqual(['PWR in the red']) // once, not every tick

  const ui = await $.ui.mount({ plugin: 'sysmon', surface: 'terminal', component: 'Pane', requestId: 'sysmon', props: {} as never })
  expect(await ui.find({ type: 'Text', text: /ATTN.*agent waiting :: planner/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ATTN.*job blocked :: bennu PR :: approve the plan/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /UP.*2h00m :: \$3\.00 :: \$1\.50\/hr/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /AGT.*1 running/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5H.*62%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PWR.*12% discharging/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /TPS/ })).toBeDefined()
  await ui.unmount()
})

test('sums agents and attention across live sessions from registry and heartbeats', async ($, on) => {
  const clock = mock.clock(on)
  const files: Record<string, unknown> = {
    '/h/.claude/sessions/1.json': { pid: 1, sessionId: 'me', name: 'this one', status: 'busy' },
    '/h/.claude/sessions/2.json': { pid: 2, sessionId: 'aaa', name: 'bennu', status: 'busy' },
    '/h/.claude/sessions/3.json': { pid: 3, sessionId: 'bbb', name: 'docs', status: 'idle' },
    '/h/.claude/sessions/9.json': { pid: 9, sessionId: 'dead', name: 'crashed', status: 'busy' },
    '/h/.claude/sysmon/aaa.json': { at: 0, running: 2, attn: ['agent waiting :: planner'], prompt: 'Claude needs your permission to use Bash' },
    '/h/.claude/sysmon/bbb.json': { at: -60_000, running: 7, attn: [], prompt: '' }, // stale: its sysmon stopped
  }
  const run = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) =>
    e.argv[0] === 'sysctl' ? run('131072') : e.argv[0] === 'vm_stat' ? run(VM) : e.argv[0] === 'ps' ? run('    1\n    2\n    3\n', 1) : run(NET))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('env.get', () => ({ value: '/h' }))
  on('session.id', () => ({ value: 'me' }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'scan', type: 'Explore', status: 'running' as const }] }))
  on('fs.list', (_$, e) => ({
    value: e.path?.endsWith('sessions') ? ['1', '2', '3', '9'].map(n => ({ name: `${n}.json`, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) : [],
  }))
  on('fs.read', (_$, e) => {
    if (!(e.path in files)) throw new Error('ENOENT')
    return { value: JSON.stringify(files[e.path]) }
  })
  const written: Record<string, string> = {}
  on('fs.write', (_$, e) => ((written[e.path] = e.text), { value: undefined }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)

  const ui = await $.ui.mount({ plugin: 'sysmon', surface: 'terminal', component: 'Pane', requestId: 'sysmon', props: {} as never })
  expect(await ui.find({ type: 'Text', text: /AGT.*3 running :: 3 sessions, 2 busy/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ATTN.*session bennu :: Claude needs your permission/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ATTN.*agent waiting :: planner @ bennu/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /crashed|docs/ })).toBeUndefined()
  await ui.unmount()
  expect(JSON.parse(written['/h/.claude/sysmon/me.json']!)).toMatchObject({ running: 1, attn: [], prompt: '' })
})

test('Clawd reacts to alarms and prompts and idles with an antic now and then', async () => {
  const calm = { mem: [50], rx: [], tx: [], memUsedGb: 0, memTotalGb: 0, tokens: [], window: 0, tps: [0], limits: [], costUsd: 0, startedAt: 0, now: 0, running: 0, power: null, attn: [], prompt: '', sessions: 0, busy: 0, peerRunning: 0 }
  expect(clawd({ ...calm, mem: [95] }).say).toBe('!!')
  expect(clawd({ ...calm, prompt: 'Claude needs your permission' }).say).toBe('hey')
  expect(clawd({ ...calm, tps: [40] }).say).toBe('...')
  expect(clawd({ ...calm, now: 21_000 }).say).toBe('hi') // second cycle: a wave
  expect(clawd({ ...calm, now: 10_000 })).toEqual({ pose: 'blink', dx: 1, say: '' })
  expect(clawd({ ...calm, now: 11_000 })).toEqual({ pose: 'idle', dx: 1, say: '' })
  // every frame is the same width, so the text rows beside it never shift
  const widths = new Set(Array.from({ length: 80 }, (_, t) => clawdRows({ ...calm, now: t * 1000 })).flat().map(l => l.length))
  expect(widths.size).toBe(1)
})
