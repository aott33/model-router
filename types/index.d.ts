export type Tier = 'simple' | 'standard' | 'hard' | 'long'

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One subagent (or the main loop, id "main") as the bill pane shows it. */
export type AgentRow = {
  id: string
  label: string
  agentType: string
  tier?: Tier
  /**
   * How the model was decided: the classifier, the role fallback, a model Claude
   * named, or not routed (main, forks, workflow agents, built-ins when routing is off).
   */
  via?: 'haiku' | 'fallback' | 'explicit' | 'unrouted'
  model?: string
  /** What this agent would have run on without the router: the parent's model, or its own when unrouted. */
  baselineModel?: string
  tokens: Tokens
  /** USD at the price of the model that actually answered each step. */
  cost: number
  startedAt: number
}

export type RouterLedger = {
  rows: Record<string, AgentRow>
  /** What the Haiku classifier calls themselves cost. */
  classifierCost: number
  routed: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': { ledger: RouterLedger }
  }
}
