export type Tier = 'simple' | 'standard' | 'hard' | 'long'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

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
   * How the model was decided: the Haiku classifier, the engine's built-in classifier
   * when Haiku gave no tier, the role fallback, a model Claude named, a `/router` mode
   * that sends everything to one model, or not routed (main, forks, workflow agents,
   * teammates, built-ins when routing is narrowed, everything under `/router off`).
   */
  via?: 'haiku' | 'builtin' | 'fallback' | 'explicit' | 'forced' | 'unrouted'
  model?: string
  /** The most effort this agent's requests may ask for; absent when the router leaves effort alone. */
  effort?: Effort
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
