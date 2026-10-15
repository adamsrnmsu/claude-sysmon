export type Samples = {
  mem: number[]
  rx: number[]
  tx: number[]
  memUsedGb: number
  memTotalGb: number
  tokens: number[]
  window: number
}

declare module 'claude-code' {
  interface PluginState {
    sysmon: { samples: Samples }
  }
}
