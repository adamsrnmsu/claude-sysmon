export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Power = { percent: number; state: string; throttled: boolean }

export type Samples = {
  mem: number[]
  rx: number[]
  tx: number[]
  memUsedGb: number
  memTotalGb: number
  tokens: number[]
  window: number
  tps: number[]
  limits: Limit[]
  costUsd: number
  startedAt: number
  now: number
  running: number
  power: Power | null
  attn: string[]
  prompt: string
  sessions: number
  busy: number
  peerRunning: number
}

// What each session's sysmon publishes for the others, in ~/.claude/sysmon/<sessionId>.json
export type Beat = { at: number; running: number; attn: string[]; prompt: string }

declare module 'claude-code' {
  interface PluginState {
    sysmon: { samples: Samples }
  }
}
