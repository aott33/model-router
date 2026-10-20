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
  /** True when the task was judged risky and sent to at least the hard tier. */
  risky?: boolean
  /** The fullest rate-limit window, in percent, when it pushed this agent a tier down. */
  pressure?: number
  /** The most effort this agent's requests may ask for; absent when the router leaves effort alone. */
  effort?: Effort
  /** What this agent would have run on without the router: the parent's model, or its own when unrouted. */
  baselineModel?: string
  /**
   * True when `baselineModel` is a guess: the call named no model, the type is not a router
   * role, and the type had not yet been seen running unrouted, so the parent's model stood in.
   */
  baselineGuessed?: boolean
  tokens: Tokens
  /** The part of `tokens` from requests over Haiku 5.5's long-prompt threshold, which price higher there. */
  longTokens?: Tokens
  /** USD at the price of the model that actually answered each step. */
  cost: number
  startedAt: number
  /** When the agent last finished; absent while it runs. The band above the prompt fades it out after this. */
  finishedAt?: number
  /** Why it got its model, in one line: what the classifier said and each rule that moved it. */
  why?: string
  /** The session's spend as a share of its budget, in percent, when the budget moved it down. */
  budget?: number
  /** How many times it was moved up a model mid-run after struggling. */
  rescued?: number
}

/** One rate-limit window as the engine reports it. */
export type LimitWindow = { kind: string; percentUsed: number; resetsAt?: string }

/** The main conversation's turn now running: the bill as it stood when it began. */
export type TurnMark = { startedAt: number; cost: number; base: number; agents: number }

/** The last finished turn of the main conversation, for the pane's receipt line. */
export type TurnReceipt = { ms: number; agents: number; cost: number; saved: number }

/** What the engine measures for the whole session, and the turn receipt. */
export type RouterMeter = {
  /** Claude Code's own session cost: every priced response, the router's classifier calls not included. */
  engineCost?: number
  limits: LimitWindow[]
  turn?: TurnMark
  lastTurn?: TurnReceipt
}

/** The pane's view: which agent row is expanded to show why it got its model. */
export type RouterView = { expanded?: string }

export type RouterLedger = {
  rows: Record<string, AgentRow>
  /** What the Haiku classifier calls themselves cost. */
  classifierCost: number
  routed: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      ledger: RouterLedger
      mode: 'on' | 'off' | 'haiku' | 'sonnet' | 'opus' | undefined
      meter: RouterMeter
      view: RouterView
    }
  }
}
