import { expect, mock, test } from 'claude-code/testing'

import { braille, parseNetstat, parseVmStat, rate } from '../hooks/register'

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
    await ui.unmount()
  }
})

test('records context tokens after each main-thread turn', async ($, on) => {
  const clock = mock.clock(on)
  let tokens = 40000
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
