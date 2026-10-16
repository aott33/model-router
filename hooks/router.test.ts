import { describe, expect, mock, test } from 'claude-code/testing'

import {
  asksForLongRun,
  capEffort,
  CLASSIFIER_SYSTEM,
  classifyKey,
  clampTier,
  costOf,
  explainTier,
  familyOf,
  looksRisky,
  parseMode,
  parseRisky,
  budgetUsd,
  parseTier,
  rescueReason,
  rescueTier,
  routeTier,
  tierOfModel,
  windowGauge,
} from './lib/pricing'

/** Billionths of a dollar, so float sums compare exactly. */
const nano = (usd: number) => Math.round(usd * 1e9)

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

const USAGE = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function spawnInput(over: Record<string, unknown> = {}) {
  return {
    tool_use_id: 'tu1',
    prompt: 'Rename the variable fooBar to fooBaz in src/a.ts',
    description: 'rename fooBar',
    subagentType: 'model-router:builder',
    provider: { plugin: 'model-router', tier: 'user' as const },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...over,
  }
}

describe('pure routing rules', () => {
  test('pricing families', async () => {
    expect(familyOf('claude-haiku-4-5-20251001')).toBe('haiku4')
    expect(familyOf('claude-haiku-5-5')).toBe('haiku5')
    expect(familyOf('haiku')).toBe('haiku5')
    expect(familyOf('claude-mythos-5-1')).toBe('fable')
    // Fable is 10x Haiku 4.5 per token, input and output
    const t = { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }
    expect(costOf(t, 'fable') / costOf(t, 'haiku4')).toBe(10)
  })

  test('Haiku 5.5 costs five times as much above a 100K-token prompt', async () => {
    const small = { input: 50_000, output: 1000, cacheRead: 50_000, cacheWrite: 0 }
    const big = { input: 50_000, output: 1000, cacheRead: 50_001, cacheWrite: 0 }
    // 50K x $0.10 + 50K x $0.01 + 1K x $0.50 = $0.006
    expect(nano(costOf(small, 'haiku5'))).toBe(6_000_000)
    // 50K x $0.50 + 50,001 x $0.05 + 1K x $2.50 = $0.03000005
    expect(nano(costOf(big, 'haiku5'))).toBe(30_000_050)
  })

  test('Sonnet 5.5 cache reads are $0.10 per million', async () => {
    expect(nano(costOf({ input: 0, output: 0, cacheRead: 1e6, cacheWrite: 0 }, 'sonnet'))).toBe(100_000_000)
  })

  test('tiers and caps', async () => {
    expect(parseTier('Hard.')).toBe('hard')
    expect(parseTier('dunno')).toBe(undefined)
    // An explanation first: the verdict is the last line.
    expect(parseTier('Not hard: the steps are spelled out.\n\nstandard')).toBe('standard')
    expect(clampTier('long', 'runner')).toBe('standard')
    expect(clampTier('simple', 'architect')).toBe('standard')
    expect(clampTier('simple', undefined)).toBe('simple')
    // third argument: whether the task asked for a long run
    expect(clampTier('long', 'builder', false)).toBe('hard')
    expect(clampTier('long', 'builder', true)).toBe('long')
    expect(tierOfModel('opus')).toBe('hard')
    expect(tierOfModel('claude-haiku-4-5')).toBe('simple')
  })

  test('long only when the task asks for a long or unattended run', async () => {
    expect(asksForLongRun('migrate all services unattended overnight')).toBe(true)
    expect(asksForLongRun('Start a long-running build of every package')).toBe(true)
    expect(asksForLongRun('keep going until every test passes')).toBe(true)
    expect(asksForLongRun('run this in the background')).toBe(false)
    expect(asksForLongRun('rename x')).toBe(false)
    expect(asksForLongRun('in the long run this saves time')).toBe(false)
  })

  test('effort is only ever lowered', async () => {
    expect(capEffort('high', 'low')).toBe('low')
    expect(capEffort('low', 'medium')).toBe('low')
    expect(capEffort('xhigh', undefined)).toBe('xhigh')
    expect(capEffort(4096, 'low')).toBe(4096)
    expect(capEffort(undefined, 'low')).toBe(undefined)
    expect(parseMode(' Sonnet ')).toBe('sonnet')
    expect(parseMode('fable')).toBe(undefined)
  })
})

/** Records the effort each request reaches the engine with; register it before the test's first `$` call. */
function captureEffort(on: any) {
  const seen: { effort?: unknown } = { effort: 'unset' }
  on('turn.step', async function* (_$: unknown, e: any) {
    seen.effort = e.effort
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as never }
  })
  return seen
}

/** Runs one request of agent `agentId` through the plugin. */
async function step($: any, agentId: string, effort: string | undefined) {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId, effort })
  for await (const _ of s) {
    // drain
  }
  await s.result
}

describe('agent.spawn', () => {
  test('Haiku says simple, the builder runs on Haiku 5.5', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'a1' }
    })
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe('claude-haiku-5-5')
  })

  test('the runner is capped at Sonnet even when Haiku says long', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'long', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'a2' }
    })
    await $.agent.spawn(spawnInput({ subagentType: 'model-router:runner' }))
    expect(spawnedOn).toBe('claude-sonnet-5-5')
  })

  test('long goes to Opus for a task that does not ask for a long run', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'long', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'l1' }
    })
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe('claude-opus-5-5')
  })

  test('running in the background is not a long run', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'long', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'l2' }
    })
    await $.agent.spawn(spawnInput({ background: true }))
    expect(spawnedOn).toBe('claude-opus-5-5')
  })

  test('a task that asks for an unattended run goes to Fable', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'long', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'l3' }
    })
    await $.agent.spawn(spawnInput({ prompt: 'Run the whole migration unattended overnight', description: 'migration' }))
    expect(spawnedOn).toBe('claude-fable-5-1')
  })

  test('a failed classifier falls back to the role default', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: {
      isAnswered: false as const,
      reason: 'api-error' as const,
      status: 529,
      error: 'overloaded' as const,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'a3' }
    })
    await $.agent.spawn(spawnInput({ subagentType: 'model-router:architect' }))
    expect(spawnedOn).toBe('claude-opus-5-5')
  })

  test('a model the caller named is kept', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined
    let classified = false
    on('model.complete', async () => {
      classified = true
      return { value: { isAnswered: true as const, text: 'simple', usage: USAGE } }
    })
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'a4' }
    })
    await $.agent.spawn(spawnInput({ model: 'opus' }))
    expect(spawnedOn).toBe('opus')
    expect(classified).toBe(false)
  })

  test('forks are left alone', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined = 'unset'
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: 'claude-opus-5-5', agentId: 'a5' }
    })
    await $.agent.spawn(spawnInput({ fork: true, subagentType: 'fork' }))
    expect(spawnedOn).toBe(undefined)
  })

  test('teammates are left alone and not classified', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined = 'unset'
    let classified = false
    on('model.complete', async () => {
      classified = true
      return { value: { isAnswered: true as const, text: 'long', usage: USAGE } }
    })
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: 'claude-opus-5-5', agentId: 'a6', teammateId: 'scout@team' }
    })
    await $.agent.spawn(spawnInput({ isTeammate: true, background: true, name: 'scout' }))
    expect(spawnedOn).toBe(undefined)
    expect(classified).toBe(false)
  })
})

describe('risk floor and rate limits: pure rules', () => {
  test('routeTier', async () => {
    expect(routeTier('simple', 'builder', false, { risky: true })).toBe('hard')
    // the risk floor goes past the runner's cap
    expect(routeTier('simple', 'runner', false, { risky: true })).toBe('hard')
    expect(routeTier('hard', 'builder', false, { underPressure: true })).toBe('standard')
    expect(routeTier('long', 'builder', true, { underPressure: true })).toBe('hard')
    expect(routeTier('long', 'builder', true)).toBe('long')
    // role floors hold under pressure
    expect(routeTier('standard', 'architect', false, { underPressure: true })).toBe('standard')
    // risk wins over pressure
    expect(routeTier('hard', 'builder', false, { risky: true, underPressure: true })).toBe('hard')
    expect(routeTier('simple', 'builder', false, { underPressure: true })).toBe('simple')
  })

  test('the act is risky, not the subject', async () => {
    expect(parseRisky('hard risky')).toBe(true)
    expect(parseRisky('standard')).toBe(false)
    expect(parseRisky('Commits locally, so no risky flag.\n\nlong')).toBe(false)
    expect(parseRisky('Drops a production table.\n\nsimple risky')).toBe(true)
  })

  test('a cached verdict is keyed on the rubric that gave it', async () => {
    const task = { agentType: 'Explore', description: 'find callers', prompt: 'find callers of usd' }
    expect(classifyKey(task)).toContain(CLASSIFIER_SYSTEM)
    expect(classifyKey(task)).toContain(task.prompt)
    expect(looksRisky('Deploy the new build to production')).toBe(true)
    expect(looksRisky('run DROP TABLE users on the shared db')).toBe(true)
    expect(looksRisky('git push --force origin main')).toBe(true)
    expect(looksRisky('Add a refund endpoint that calls Stripe')).toBe(false)
    expect(looksRisky('Write tests for the production config loader')).toBe(false)
    expect(looksRisky('Rename the deploy script')).toBe(false)
  })
})

/** Answers `$.session.usage()` with one five-hour window at `percent`. */
function limitsAt(on: any, percent: number) {
  on('session.usage', async () => ({
    value: { startedAt: 0, context: {} as never, rateLimits: [{ kind: 'five_hour', percentUsed: percent }] },
  }))
}

describe('risk floor and rate limits', () => {
  test('a risky simple task runs on Opus', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple risky', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'r1' }
    })
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe('claude-opus-5-5')
  })

  test('without a classifier, a destructive act still gets the floor', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: {
      isAnswered: false as const,
      reason: 'api-error' as const,
      status: 529,
      error: 'overloaded' as const,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } }))
    on('model.classify', async () => ({ value: 'simple' }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'r2' }
    })
    await $.agent.spawn(spawnInput({ subagentType: 'model-router:runner', prompt: 'Deploy the release to production now' }))
    expect(spawnedOn).toBe('claude-opus-5-5')
  })

  test('the risk floor can be turned off', { options: { riskFloor: false } }, async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple risky', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'r3' }
    })
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe('claude-haiku-5-5')
  })

  test('past 80% of a rate-limit window, a hard task runs on Sonnet', async ($, on) => {
    mock.clock(on)
    limitsAt(on, 85)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'hard', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'p1' }
    })
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe('claude-sonnet-5-5')
  })

  test('an unattended run goes to Opus, not Fable, under rate-limit pressure', async ($, on) => {
    mock.clock(on)
    limitsAt(on, 85)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'long', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'p5' }
    })
    await $.agent.spawn(spawnInput({ prompt: 'Run the whole migration unattended overnight', description: 'migration' }))
    expect(spawnedOn).toBe('claude-opus-5-5')
  })

  test('below the threshold, nothing changes', async ($, on) => {
    mock.clock(on)
    limitsAt(on, 79)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'hard', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'p2' }
    })
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe('claude-opus-5-5')
  })

  test('with the setting off, rate limits are ignored', { options: { limitPressure: 'off' } }, async ($, on) => {
    mock.clock(on)
    limitsAt(on, 99)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'hard', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'p3' }
    })
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe('claude-opus-5-5')
  })

  test('a risky task keeps Opus under rate-limit pressure', async ($, on) => {
    mock.clock(on)
    limitsAt(on, 95)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'standard risky', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'p4' }
    })
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe('claude-opus-5-5')
  })
})

describe('effort', () => {
  test('a simple task asks for low effort', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'e1' }))
    const seen = captureEffort(on)
    await $.agent.spawn(spawnInput())
    await step($, 'e1', 'high')
    expect(seen.effort).toBe('low')
  })

  test('the first request gets low effort even when it arrives before the spawn answers', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    let entered!: () => void
    const spawnEntered = new Promise<void>(r => (entered = r))
    let release!: () => void
    const spawnReleased = new Promise<void>(r => (release = r))
    on('agent.spawn', async (_$, e) => {
      entered()
      await spawnReleased
      return { model: e.model ?? '', agentId: 'race1' }
    })
    const seen = captureEffort(on)
    const spawning = $.agent.spawn(spawnInput())
    await spawnEntered
    // The agent's first request, sent while the spawn hook is still waiting on `next`.
    const stepping = step($, 'race1', 'high')
    release()
    await Promise.all([spawning, stepping])
    expect(seen.effort).toBe('low')
  })

  test('a hard task keeps the effort it had', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'hard', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'e2' }))
    const seen = captureEffort(on)
    await $.agent.spawn(spawnInput())
    await step($, 'e2', 'xhigh')
    expect(seen.effort).toBe('xhigh')
  })

  test('a model without effort is not given one', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'e3' }))
    const seen = captureEffort(on)
    await $.agent.spawn(spawnInput())
    await step($, 'e3', undefined)
    expect(seen.effort).toBe(undefined)
  })

  test('an Agent call that sets its own effort keeps it', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'e4' }))
    on('tool.call', { tool: 'Agent' }, async () => ({ result: 'started' as never }))
    const seen = captureEffort(on)
    // In a session the spawn runs inside the Agent call; here it follows it.
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tu9', description: 'rename', prompt: 'rename x', effort: 'high' } as never)
    await $.agent.spawn(spawnInput({ tool_use_id: 'tu9' }))
    await step($, 'e4', 'high')
    expect(seen.effort).toBe('high')
  })
})

describe('/router modes', () => {
  test('off leaves spawns alone and asks no classifier', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    let spawnedOn: string | undefined = 'unset'
    let classified = false
    on('model.complete', async () => {
      classified = true
      return { value: { isAnswered: true as const, text: 'simple', usage: USAGE } }
    })
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: 'claude-opus-5-5', agentId: 'm1' }
    })
    await $.command.run({ command: 'router', args: 'off' } as never)
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe(undefined)
    expect(classified).toBe(false)
  })

  test('sonnet sends every routed spawn to Sonnet 5.5 without classifying', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    let spawnedOn: string | undefined
    let classified = false
    on('model.complete', async () => {
      classified = true
      return { value: { isAnswered: true as const, text: 'simple', usage: USAGE } }
    })
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'm2' }
    })
    await $.command.run({ command: 'router', args: 'sonnet' } as never)
    await $.agent.spawn(spawnInput({ subagentType: 'model-router:runner' }))
    expect(spawnedOn).toBe('claude-sonnet-5-5')
    expect(classified).toBe(false)
  })

  test('a mode saved in an earlier session is used', async ($, on) => {
    mock.clock(on)
    mock.store(on, { mode: 'haiku' })
    let spawnedOn: string | undefined
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'm3' }
    })
    await $.agent.spawn(spawnInput({ subagentType: 'model-router:architect' }))
    expect(spawnedOn).toBe('claude-haiku-5-5')
  })
})

describe('classifier fallback', () => {
  test('when Haiku 4.5 fails, the built-in classifier picks the tier', async ($, on) => {
    mock.clock(on)
    let spawnedOn: string | undefined
    on('model.complete', async () => ({ value: {
      isAnswered: false as const,
      reason: 'api-error' as const,
      status: 404,
      error: 'not_found' as never,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } }))
    on('model.classify', async () => ({ value: 'hard' }))
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'c1' }
    })
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe('claude-opus-5-5')
  })
})

/** Answers every model request with 2k tokens in and 1k out, on `model`. */
function answerSteps(on: any, model: string) {
  on('turn.step', async function* (_$: unknown, e: any) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn' as never,
      usage: { ...USAGE, input_tokens: 2000, model },
    }
  })
}

function mountPane($: any, bodyColumns = 70) {
  return $.ui.mount({
    plugin: 'model-router',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'model-router',
    props: { title: 'Model router', isFocused: false, bodyColumns, placement: 'dock' } as never,
  })
}

/** What the engine draws in the band and how it ends a turn, beneath the plugins. */
function engineBeneath(on: any) {
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Box', children: [] }))
  on('turn.complete', async (_$: unknown, e: any) => ({ text: e.answer }))
  on('session.end', async (_$: unknown, e: any) => ({ sessionId: e.sessionId }))
}

function mountBand($: any) {
  return $.ui.mount({
    plugin: 'model-router',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80 } as never,
  })
}

/** Ends a run of subagent `agentId`, as its loop's turn.complete does. */
function complete($: any, agentId: string) {
  return $.turn.complete({ agentId, turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
}

describe('bill', () => {
  test('a routed step is priced on Haiku 5.5 and against the builder on Sonnet', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'a1' }))
    answerSteps(on, 'claude-haiku-5-5')
    await $.agent.spawn(spawnInput())
    await step($, 'a1', undefined)

    // 2k in + 1k out: Haiku 5.5 $0.0007, Sonnet 5.5 (the builder's registered model) $0.014;
    // the Haiku 5.5 classifier call adds $0.0006, so $0.0013 against $0.014 is 91% saved
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: 'Model router · on' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Spent\s+<\$0\.01$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Unrouted\s+\$0\.01\s+saved 91%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'rename fooBar' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^easy$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Haiku$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1 agent · 1 routed · classifier <\$0\.01$/ })).toBeDefined()
    // no risky or lowered row, so no legend for them
    expect(await ui.find({ type: 'Text', text: /risky/ })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /rate limits/ })).toBe(undefined)
    await ui.unmount()
  })

  test('with no subagents the pane says how to get one', async ($, on) => {
    mock.clock(on)
    const ui = await mountPane($)
    expect(
      await ui.find({ type: 'Text', text: 'No subagents yet. Ask Claude to use an agent and it shows up here.' }),
    ).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Agent$/ })).toBe(undefined)
    await ui.unmount()
  })

  test('the header follows /router on the same mounted pane', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    const ui = await mountPane($)
    await $.command.run({ command: 'router', args: 'sonnet' } as never)
    expect(await ui.find({ type: 'Text', text: 'Model router · sonnet' })).toBeDefined()
    await $.command.run({ command: 'router', args: 'on' } as never)
    expect(await ui.find({ type: 'Text', text: 'Model router · on' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Model router · sonnet' })).toBe(undefined)
    await ui.unmount()
  })

  test('the pane draws the stored mode when the state is empty, without writing state', async ($, on) => {
    mock.clock(on)
    mock.store(on, { mode: 'sonnet' })
    const written: string[] = []
    on('state.set', async (_$, e: any, next) => {
      written.push(e.key)
      return next(e)
    })
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: 'Model router · sonnet' })).toBeDefined()
    // The draw read the store; it wrote nothing (state.set is refused while a draw runs).
    expect(written).toEqual([])
    await ui.unmount()
  })

  test('a narrow pane keeps the money columns whole and truncates the agent name', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'n1' }))
    answerSteps(on, 'claude-haiku-5-5')
    await $.agent.spawn(spawnInput({ description: 'rename every fooBar reference across the whole monorepo' }))
    await step($, 'n1', undefined)
    const ui = await mountPane($, 40)
    // Sonnet 5.5 $0.014 unrouted, Haiku 5.5 $0.0007 routed plus $0.0006 for the classifier: 91% saved
    expect(await ui.find({ type: 'Text', text: /^Unrouted\s+\$0\.01\s+saved 91%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Unrouted$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$0\.01$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^<\$0\.01$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Cost$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Model$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Tier$/ })).toBeDefined()
    // the agent name is cut with an ellipsis, not the money columns
    expect(await ui.find({ type: 'Button', text: /…$/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /whole monorepo/ })).toBe(undefined)
    // the pane fits the 40 columns (2 of them the gutter), each row adds up to the pane, and only Agent is flexible
    const pane = await ui.drawn() as any
    const table = pane.children.find((c: any) => c.type === 'Box' && c.children?.some((r: any) => r.props?.flexDirection === 'row'))
    expect(pane.props.width).toBeLessThanOrEqual(40 - 2)
    // table rows: the header directly, each agent's inside its own column Box
    const rows = table.children.flatMap((r: any) => (r.props?.flexDirection === 'row' ? [r] : (r.children ?? []).filter((c: any) => c.props?.flexDirection === 'row')))
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row.children.reduce((sum: number, cell: any) => sum + cell.props.width, 0)).toBe(pane.props.width)
      for (const cell of row.children.slice(1)) expect(cell.props.flexShrink).toBe(0)
    }
    await ui.unmount()
  })

  test('a risky row shows hard! and the legend explains it', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple risky', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'k1' }))
    answerSteps(on, 'claude-opus-5-5')
    await $.agent.spawn(spawnInput())
    await step($, 'k1', undefined)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^hard!$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '! risky: sent to Opus at least' })).toBeDefined()
    await ui.unmount()
  })
})

describe('baseline for built-in agents', () => {
  test('a routed Explore is compared with the model Explore was seen running on', async ($, on) => {
    mock.clock(on)
    mock.store(on, { agentModels: { Explore: 'claude-haiku-5-5' } })
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'standard', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'x1' }))
    answerSteps(on, 'claude-sonnet-5-5')
    await $.agent.spawn(spawnInput({ subagentType: 'Explore', description: 'find callers' }))
    await step($, 'x1', undefined)
    const ui = await mountPane($)
    // Sonnet 5.5 $0.014 against Haiku 5.5 $0.0007, not the parent's Opus $0.028
    expect(await ui.find({ type: 'Text', text: /^Unrouted\s+<\$0\.01\s+\d+% more$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$0\.03$/ })).toBe(undefined)
    await ui.unmount()
  })

  test('the model an unrouted Explore ran on becomes its baseline', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'standard', usage: USAGE } }))
    let n = 0
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? 'claude-haiku-5-5', agentId: `y${++n}` }))
    answerSteps(on, 'claude-sonnet-5-5')
    await $.command.run({ command: 'router', args: 'off' } as never)
    await $.agent.spawn(spawnInput({ subagentType: 'Explore', description: 'find callers' }))
    await $.command.run({ command: 'router', args: 'on' } as never)
    await $.agent.spawn(spawnInput({ subagentType: 'Explore', description: 'find callees' }))
    await step($, 'y2', undefined)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^Unrouted\s+<\$0\.01/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$0\.03$/ })).toBe(undefined)
    await ui.unmount()
  })

  test('an Explore with no learned model shows a guessed Unrouted cost', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'standard', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'g1' }))
    answerSteps(on, 'claude-sonnet-5-5')
    await $.agent.spawn(spawnInput({ subagentType: 'Explore', description: 'find callers' }))
    await step($, 'g1', undefined)
    const ui = await mountPane($)
    // the parent's Opus $0.028 stands in for Explore's unknown model
    expect(await ui.find({ type: 'Text', text: /^~\$0\.03$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: "~ guessed: this agent type's own model isn't known yet" })).toBeDefined()
    await ui.unmount()
  })

  test('an Explore with a learned model is not marked as a guess', async ($, on) => {
    mock.clock(on)
    mock.store(on, { agentModels: { Explore: 'claude-haiku-5-5' } })
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'standard', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'x1' }))
    answerSteps(on, 'claude-sonnet-5-5')
    await $.agent.spawn(spawnInput({ subagentType: 'Explore', description: 'find callers' }))
    await step($, 'x1', undefined)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^~/ })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /guessed/ })).toBe(undefined)
    await ui.unmount()
  })
})

describe('baseline for router roles', () => {
  test('a routed role is compared with Sonnet, its registered model, not the parent Opus', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'standard', usage: USAGE } }))
    let n = 0
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: `b${++n}` }))
    answerSteps(on, 'claude-sonnet-5-5')
    await $.agent.spawn(spawnInput())
    await step($, 'b1', undefined)
    let ui = await mountPane($)
    // the builder's step: Sonnet $0.014 against Sonnet $0.014; on Opus it would be $0.028
    expect(await ui.findAll({ type: 'Text', text: /^\$0\.01$/ })).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: /^Unrouted\s+\$0\.01/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$0\.03$/ })).toBe(undefined)
    await ui.unmount()

    await $.agent.spawn(spawnInput({ subagentType: 'model-router:fixer', description: 'fix login' }))
    await step($, 'b2', undefined)
    ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^Unrouted\s+\$0\.03/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$0\.03$/ })).toBe(undefined)
    await ui.unmount()
  })
})

describe('band above the prompt', () => {
  test('a routed subagent has a line until 30 seconds after it finishes', async ($, on) => {
    const clock = mock.clock(on)
    engineBeneath(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'a1' }))
    answerSteps(on, 'claude-haiku-5-5')
    await $.agent.spawn(spawnInput())
    await step($, 'a1', undefined)
    const ui = await mountBand($)
    expect(await ui.find({ type: 'Text', text: /⇄ builder: rename fooBar → Haiku · / })).toBeDefined()
    await complete($, 'a1')
    await clock.advance(29_000)
    expect(await ui.find({ type: 'Text', text: /⇄ builder: rename fooBar/ })).toBeDefined()
    await clock.advance(2_000)
    expect(await ui.find({ type: 'Text', text: /⇄/ })).toBe(undefined)
    await ui.unmount()
  })

  test('SubagentStop finishes the line too', async ($, on) => {
    const clock = mock.clock(on)
    engineBeneath(on)
    on('classic.SubagentStop', async () => ({}))
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'a1' }))
    answerSteps(on, 'claude-haiku-5-5')
    await $.agent.spawn(spawnInput())
    await step($, 'a1', undefined)
    const ui = await mountBand($)
    await $.classic.SubagentStop({
      agent_id: 'a1',
      agent_type: 'model-router:builder',
      agent_transcript_path: '',
      stop_hook_active: false,
    } as never)
    await clock.advance(29_000)
    // a turn.complete for the same run does not restart the fade
    await complete($, 'a1')
    await clock.advance(2_000)
    expect(await ui.find({ type: 'Text', text: /⇄/ })).toBe(undefined)
    await ui.unmount()
  })

  test('an unrouted subagent has no line', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)
    on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: 'f1' }))
    answerSteps(on, 'claude-opus-5-5')
    await $.agent.spawn(spawnInput({ fork: true, subagentType: 'fork' }))
    await step($, 'f1', undefined)
    const ui = await mountBand($)
    expect(await ui.find({ type: 'Text', text: /⇄/ })).toBe(undefined)
    await ui.unmount()
  })
})

describe('/clear', () => {
  test('a row wiped while its agent runs is written again from the spawn', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'a1' }))
    answerSteps(on, 'claude-haiku-5-5')
    await $.agent.spawn(spawnInput())
    // what /clear does to $.state, as far as the ledger goes
    await $.command.run({ command: 'router', args: 'reset' } as never)
    await step($, 'a1', undefined)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Button', text: 'rename fooBar' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^easy$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'subagent' })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /1 routed/ })).toBeDefined()
    await ui.unmount()
    const band = await mountBand($)
    expect(await band.find({ type: 'Text', text: /⇄ builder: rename fooBar → Haiku/ })).toBeDefined()
    await band.unmount()
  })
})

describe('status line', () => {
  test('updates when a subagent finishes and resets on /clear', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)
    const seen: (string | undefined)[] = []
    on('ui.status', async (_$, e) => {
      seen.push(e.text)
      return { value: undefined }
    })
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'a1' }))
    answerSteps(on, 'claude-haiku-5-5')
    await $.agent.spawn(spawnInput())
    await step($, 'a1', undefined)
    await complete($, 'a1')
    expect(seen.at(-1)).toContain('$')
    expect(seen.at(-1)).toContain('saved')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
    expect(seen.at(-1)).toBe(undefined)
  })

  test('says how much more when routing cost more than the baseline', async ($, on) => {
    mock.clock(on)
    mock.store(on, { agentModels: { Explore: 'claude-haiku-5-5' } })
    engineBeneath(on)
    const seen: (string | undefined)[] = []
    on('ui.status', async (_$, e) => {
      seen.push(e.text)
      return { value: undefined }
    })
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'standard', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'x1' }))
    answerSteps(on, 'claude-sonnet-5-5')
    await $.agent.spawn(spawnInput({ subagentType: 'Explore', description: 'find callers' }))
    await step($, 'x1', undefined)
    await complete($, 'x1')
    // Sonnet 5.5 against Explore's own Haiku 5.5 costs more, so no negative "saved"
    expect(seen.at(-1)).toMatch(/\(\d+% more\)/)
    expect(seen.at(-1)).not.toContain('saved')
  })

  test('with only the main conversation billed, says no agents are routed instead of 0% saved', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)
    const seen: (string | undefined)[] = []
    on('ui.status', async (_$, e) => {
      seen.push(e.text)
      return { value: undefined }
    })
    answerSteps(on, 'claude-opus-5-5')
    await step($, undefined as never, undefined)
    await $.turn.complete({ turnId: 'm1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    expect(seen.at(-1)).toMatch(/^\$\d+\.\d+ · no agents routed yet$/)
    expect(seen.at(-1)).not.toContain('saved')
  })
})

describe('0.6.0 rules', () => {
  test('the main conversation pays for hour-long cache writes, subagents for five minutes', async () => {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6 }
    expect(nano(costOf(t, 'sonnet'))).toBe(2_500_000_000)
    expect(nano(costOf(t, 'sonnet', '1h'))).toBe(4_000_000_000)
  })

  test('rate-limit pressure keeps builders and fixers on Sonnet or above', async () => {
    expect(routeTier('standard', 'builder', false, { underPressure: true })).toBe('standard')
    expect(routeTier('hard', 'builder', false, { underPressure: true })).toBe('standard')
    expect(routeTier('standard', 'fixer', false, { underPressure: true })).toBe('standard')
    // easy work the classifier already put on Haiku stays there
    expect(routeTier('simple', 'builder', false, { underPressure: true })).toBe('simple')
    expect(routeTier('standard', 'runner', false, { underPressure: true })).toBe('simple')
    expect(routeTier('standard', undefined, false, { underPressure: true })).toBe('simple')
  })

  test('each agent says why it got its tier', async () => {
    const base = { role: 'builder', risky: false, allowLong: false }
    expect(explainTier({ ...base, source: 'haiku', asked: 'standard', final: 'standard' })).toBe('classifier: normal')
    expect(explainTier({ ...base, source: 'haiku', asked: 'long', final: 'standard', role: 'runner' })).toBe(
      'classifier: long → normal (runner capped at normal, long work not asked for)',
    )
    expect(explainTier({ ...base, source: 'haiku', asked: 'simple', final: 'hard', role: 'runner', risky: true })).toBe(
      'classifier: easy risky → hard (risk floor)',
    )
    expect(explainTier({ ...base, source: 'fallback', asked: 'standard', final: 'simple', role: undefined, pressure: 82 })).toBe(
      'no classifier answer, agent default: normal → easy (limits 82%: one tier down)',
    )
  })

  test('rate-limit gauges', async () => {
    const now = Date.parse('2026-10-13T10:00:00Z')
    expect(windowGauge({ percentUsed: 82, resetsAt: '2026-10-13T11:20:00Z' }, now)).toBe('████░ 82%  resets in 1h20')
    expect(windowGauge({ percentUsed: 13 }, now)).toBe('█░░░░ 13%')
    expect(windowGauge({ percentUsed: 5, resetsAt: '2026-10-13T10:42:00Z' }, now)).toBe('░░░░░ 5%  resets in 42m')
    expect(windowGauge({ percentUsed: 5, resetsAt: '2026-10-13T09:00:00Z' }, now)).toBe('░░░░░ 5%')
    // a weekly window reads in days, not 144 hours
    expect(windowGauge({ percentUsed: 11, resetsAt: '2026-10-19T11:00:00Z' }, now)).toBe('█░░░░ 11%  resets in 6d 1h')
  })
})

function mountOn($: any, surface: string, bodyColumns: number) {
  return $.ui.mount({
    plugin: 'model-router',
    surface,
    component: 'Pane',
    requestId: 'model-router',
    props: { title: 'Model router', isFocused: false, bodyColumns, placement: 'dock' } as never,
  })
}

describe('0.6.0 pane', () => {
  test('pressing an agent\'s number shows why it got its model', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'a1' }))
    answerSteps(on, 'claude-haiku-5-5')
    await $.agent.spawn(spawnInput())
    await step($, 'a1', undefined)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /classifier: easy/ })).toBe(undefined)
    // the surface prints the hotkey itself: the label is the name, the number its hotkey
    const row = (await ui.find({ key: 'row-a1' })) as any
    expect(row.props.label).toBe('rename fooBar')
    expect(row.props.hotkey).toBe('1')
    await ui.press({ key: 'row-a1' } as never)
    expect(await ui.find({ type: 'Text', text: /^\s+classifier: easy · effort ≤ low$/ })).toBeDefined()
    await ui.press({ key: 'row-a1' } as never)
    expect(await ui.find({ type: 'Text', text: /classifier: easy/ })).toBe(undefined)
    await ui.unmount()
  })

  test('a running agent shows ◐, a finished one ✓', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'a1' }))
    answerSteps(on, 'claude-haiku-5-5')
    await $.agent.spawn(spawnInput())
    await step($, 'a1', undefined)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: '◐ ' })).toBeDefined()
    await complete($, 'a1')
    expect(await ui.find({ type: 'Text', text: '✓ ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '◐ ' })).toBe(undefined)
    await ui.unmount()
  })

  test('the last turn\'s receipt: time, agents, cost and what routing saved', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)
    on('turn.start', async (_$: unknown, e: any) => ({ turnId: e.turnId }))
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'a1' }))
    answerSteps(on, 'claude-haiku-5-5')
    await $.turn.start({ text: 'rename it', turnId: 'm1' })
    await $.agent.spawn(spawnInput())
    await step($, 'a1', undefined)
    await $.turn.complete({ turnId: 'm1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    const ui = await mountPane($)
    // Haiku 5.5 $0.0007 and the classifier $0.0006 against Sonnet's $0.014: $0.0127 saved
    expect(await ui.find({ type: 'Text', text: /^Last turn\s+0:00 · 1 agent · \+<\$0\.01 · saved \$0\.01$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a turn with no agents leaves the agent count out of the receipt', async ($, on) => {
    mock.clock(on)
    engineBeneath(on)
    on('turn.start', async (_$: unknown, e: any) => ({ turnId: e.turnId }))
    answerSteps(on, 'claude-sonnet-5-5')
    await $.turn.start({ text: 'hi', turnId: 'm1' })
    await step($, undefined as any, undefined) // a main-conversation step
    await $.turn.complete({ turnId: 'm1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^Last turn\s+0:00 · \+\$0\.01$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Last turn.*agent/ })).toBe(undefined)
    await ui.unmount()
  })

  test('an agent the engine no longer runs is finished at the end of the main turn', async ($, on) => {
    const clock = mock.clock(on)
    engineBeneath(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'gone' }))
    on('agent.list', async () => ({ value: [] }))
    answerSteps(on, 'claude-haiku-5-5')
    await $.agent.spawn(spawnInput())
    await step($, 'gone', undefined)
    await clock.advance(11_000)
    // the main conversation's turn ends; the agent's own finish never came
    await $.turn.complete({ turnId: 'm1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: '✓ ' })).toBeDefined()
    await ui.unmount()
  })

  test('with no agents yet, the pane still shows the rate-limit gauges and Claude Code\'s total', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-13T10:00:00Z') })
    on('session.measure', async (_$: unknown, e: any) => ({ changed: e.changed }))
    await $.session.measure({
      context: {} as never,
      rateLimits: [
        { kind: 'five_hour', percentUsed: 82, resetsAt: '2026-10-13T11:20:00Z' },
        { kind: 'seven_day', percentUsed: 13 },
      ],
      cost: { usd: 0.42 },
      changed: ['rateLimits', 'cost'],
    } as never)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: 'No subagents yet. Ask Claude to use an agent and it shows up here.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5h limit\s+████░ 82%  resets in 1h20  · one tier down$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^7d limit\s+█░░░░ 13%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Claude Code\s+\$0\.42 total · this bill \$0 before the classifier$/ })).toBeDefined()
    await ui.unmount()
  })

  test('on a subscription Claude Code reports no cost, so there is nothing to compare', async ($, on) => {
    mock.clock(on)
    on('session.measure', async (_$: unknown, e: any) => ({ changed: e.changed }))
    await $.session.measure({ context: {} as never, rateLimits: [], cost: { usd: 0 }, changed: ['cost'] } as never)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^Claude Code/ })).toBe(undefined)
    await ui.unmount()
  })

  test('the main conversation\'s cache writes are billed at the hour rate', async ($, on) => {
    mock.clock(on)
    on('turn.step', async function* (_$: unknown, e: any) {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: 'done',
        toolUses: [],
        stopReason: 'end_turn' as never,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1e6, model: 'claude-sonnet-5-5' },
      }
    })
    const s = $.turn.step({ turnId: 'm1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })
    for await (const _ of s) {
      // drain
    }
    await s.result
    const ui = await mountPane($)
    // 1M cache-write tokens on Sonnet 5.5: $4.00 for an hour, not $2.50 for five minutes
    expect(await ui.find({ type: 'Text', text: /^Spent\s+\$4\.00$/ })).toBeDefined()
    await ui.unmount()
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [40, 60, 90, 120]) {
      test(`the pane fits ${cols} columns on ${surface}`, async ($, on) => {
        mock.clock(on)
        on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
        on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'a1' }))
        answerSteps(on, 'claude-haiku-5-5')
        await $.agent.spawn(spawnInput({ description: 'rename every fooBar reference across the whole monorepo' }))
        await step($, 'a1', undefined)
        const ui = await mountOn($, surface, cols)
        const pane = (await ui.drawn()) as any
        expect(pane.props.width).toBeLessThanOrEqual(cols - 2)
        const table = pane.children.find((c: any) => c.type === 'Box' && c.children?.some((r: any) => r.props?.flexDirection === 'row'))
        const rows = table.children.flatMap((r: any) =>
          r.props?.flexDirection === 'row' ? [r] : (r.children ?? []).filter((c: any) => c.props?.flexDirection === 'row'),
        )
        for (const row of rows) expect(row.children.reduce((sum: number, cell: any) => sum + cell.props.width, 0)).toBe(pane.props.width)
        // the money columns always show; Time only when the agent name keeps room
        expect(await ui.find({ type: 'Text', text: /^Cost$/ })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /^Unrouted$/ })).toBeDefined()
        expect((await ui.find({ type: 'Text', text: /^Time$/ })) !== undefined).toBe(cols - 2 >= 34 + 6 + 16)
        await ui.unmount()
      })
    }
  }
})

describe('0.7.0 rescue', () => {
  test('when an agent counts as struggling', async () => {
    expect(rescueReason('simple', { errors: 2, steps: 5, ms: 60_000 })).toBe(undefined)
    expect(rescueReason('simple', { errors: 3, steps: 5, ms: 60_000 })).toBe('3 failed tool calls in a row')
    expect(rescueReason('simple', { errors: 0, steps: 26, ms: 60_000 })).toBe('over 25 requests')
    expect(rescueReason('standard', { errors: 0, steps: 26, ms: 60_000 })).toBe(undefined)
    expect(rescueReason('simple', { errors: 0, steps: 1, ms: 11 * 60_000 })).toBe('over 10 minutes')
    expect(rescueReason('standard', { errors: 0, steps: 1, ms: 31 * 60_000 })).toBe('over 30 minutes')
    // only failures count for Opus: there is no time or request limit on hard work
    expect(rescueReason('hard', { errors: 0, steps: 500, ms: 600 * 60_000 })).toBe(undefined)
  })

  test('where a struggling agent moves to', async () => {
    expect(rescueTier('simple', 'builder')).toBe('standard')
    expect(rescueTier('standard', 'builder')).toBe('hard')
    // never to Fable, never past a role's cap
    expect(rescueTier('hard', 'builder')).toBe(undefined)
    expect(rescueTier('simple', 'runner')).toBe('standard')
    expect(rescueTier('standard', 'runner')).toBe(undefined)
    expect(rescueTier('simple', undefined)).toBe('standard')
  })

  /** Answers every tool call as failed (or not), beneath the plugin. */
  function toolsFail(on: any, failing: { now: boolean }) {
    on('tool.call', async () => (failing.now ? { result: 'boom' as never, text: 'boom', isError: true } : { result: 'ok' as never, text: 'ok' }))
  }

  async function bash($: any, agentId: string) {
    await $.tool.call({ tool: 'Bash', tool_use_id: `t${Math.random()}`, command: 'false', agentId } as never)
  }

  /** One request of `agentId`, returning the model it reached the engine with. */
  function stepsSeen(on: any) {
    const models: string[] = []
    on('turn.step', async function* (_$: unknown, e: any) {
      models.push(e.model)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as never, usage: { ...USAGE, model: e.model } }
    })
    return models
  }

  test('three failed tool calls in a row move a Haiku agent up to Sonnet', async ($, on) => {
    mock.clock(on)
    const failing = { now: true }
    toolsFail(on, failing)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'r1' }))
    const models = stepsSeen(on)
    await $.agent.spawn(spawnInput())
    await step($, 'r1', 'high')
    await bash($, 'r1')
    await bash($, 'r1')
    await step($, 'r1', 'high')
    await bash($, 'r1')
    await step($, 'r1', 'high')
    await step($, 'r1', 'high')
    expect(models).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^normal↑$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '↑ moved up a model after struggling' })).toBeDefined()
    await ui.press({ key: 'row-r1' } as never)
    expect(
      await ui.find({ type: 'Text', text: /classifier: easy · effort ≤ low · moved up to Sonnet \(3 failed tool calls in a row\)$/ }),
    ).toBeDefined()
    await ui.unmount()
  })

  test('a success in between starts the count again', async ($, on) => {
    mock.clock(on)
    const failing = { now: true }
    toolsFail(on, failing)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'r2' }))
    const models = stepsSeen(on)
    await $.agent.spawn(spawnInput())
    await bash($, 'r2')
    await bash($, 'r2')
    failing.now = false
    await bash($, 'r2')
    failing.now = true
    await bash($, 'r2')
    await step($, 'r2', 'high')
    expect(models).toEqual(['claude-haiku-5-5'])
  })

  test('a runner reporting failing commands is not struggling', async ($, on) => {
    mock.clock(on)
    toolsFail(on, { now: true })
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'r6' }))
    const models = stepsSeen(on)
    await $.agent.spawn(spawnInput({ subagentType: 'model-router:runner' }))
    for (let i = 0; i < 4; i++) await bash($, 'r6')
    await step($, 'r6', 'high')
    expect(models).toEqual(['claude-haiku-5-5'])
  })

  test('a model Claude named is never moved', async ($, on) => {
    mock.clock(on)
    toolsFail(on, { now: true })
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'r3' }))
    const models = stepsSeen(on)
    await $.agent.spawn(spawnInput({ model: 'haiku' }))
    for (let i = 0; i < 4; i++) await bash($, 'r3')
    await step($, 'r3', 'high')
    expect(models).toEqual(['claude-haiku-5-5'])
  })

  test('the rescue can be turned off', { options: { rescue: false } }, async ($, on) => {
    mock.clock(on)
    toolsFail(on, { now: true })
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'r4' }))
    const models = stepsSeen(on)
    await $.agent.spawn(spawnInput())
    for (let i = 0; i < 4; i++) await bash($, 'r4')
    await step($, 'r4', 'high')
    expect(models).toEqual(['claude-haiku-5-5'])
  })

  test('an agent running far past its tier\'s time moves up', async ($, on) => {
    const clock = mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'r5' }))
    const models = stepsSeen(on)
    await $.agent.spawn(spawnInput())
    await step($, 'r5', 'high')
    await clock.advance(11 * 60_000)
    await step($, 'r5', 'high')
    expect(models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
  })
})

describe('0.7.0 classifier cache', () => {
  test('the same task twice asks the classifier once', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    let calls = 0
    on('model.complete', async () => {
      calls++
      return { value: { isAnswered: true as const, text: 'hard', usage: USAGE } }
    })
    let n = 0
    const models: string[] = []
    on('agent.spawn', async (_$, e) => {
      models.push(e.model ?? '')
      return { model: e.model ?? '', agentId: `c${++n}` }
    })
    await $.agent.spawn(spawnInput())
    await $.agent.spawn(spawnInput())
    expect(calls).toBe(1)
    expect(models).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    const ui = await mountPane($)
    await ui.press({ key: 'row-c2' } as never)
    expect(await ui.find({ type: 'Text', text: /^\s+classifier \(cached\): hard$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a different task is classified afresh', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    let calls = 0
    on('model.complete', async () => {
      calls++
      return { value: { isAnswered: true as const, text: 'simple', usage: USAGE } }
    })
    let n = 0
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: `d${++n}` }))
    await $.agent.spawn(spawnInput())
    await $.agent.spawn(spawnInput({ prompt: 'Rename the variable a to b in src/b.ts' }))
    expect(calls).toBe(2)
  })

  test('a verdict from an earlier session is reused', async ($, on) => {
    mock.clock(on)
    const input = spawnInput()
    const key = await sha256(classifyKey({ agentType: input.subagentType, description: input.description, prompt: input.prompt }))
    mock.store(on, { classified: { [key]: 'standard|' } })
    let calls = 0
    on('model.complete', async () => {
      calls++
      return { value: { isAnswered: true as const, text: 'hard', usage: USAGE } }
    })
    let spawnedOn: string | undefined
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'e1' }
    })
    await $.agent.spawn(input)
    expect(calls).toBe(0)
    expect(spawnedOn).toBe('claude-sonnet-5-5')
  })

  test('a verdict the old rubric gave is not reused', async ($, on) => {
    mock.clock(on)
    const input = spawnInput()
    // 0.7.0 keyed verdicts on the task alone.
    const key = await sha256(`${input.subagentType}\n${input.description}\n${input.prompt}`)
    mock.store(on, { classified: { [key]: 'hard|' } })
    let calls = 0
    on('model.complete', async () => {
      calls++
      return { value: { isAnswered: true as const, text: 'standard', usage: USAGE } }
    })
    let spawnedOn: string | undefined
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'e1' }
    })
    await $.agent.spawn(input)
    expect(calls).toBe(1)
    expect(spawnedOn).toBe('claude-sonnet-5-5')
  })
})

/** One main-conversation request costing `usd` on Sonnet (output tokens at $10 per million). */
async function mainSpend($: any, on: any, usd: number) {
  on('turn.step', async function* (_$: unknown, e: any) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as never,
      usage: { input_tokens: 0, output_tokens: Math.round(usd * 1e5), cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' },
    }
  })
  const s = $.turn.step({ turnId: 'm1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })
  for await (const _ of s) {
    // drain
  }
  await s.result
}

describe('0.7.0 budget', () => {
  test('budget setting', async () => {
    expect(budgetUsd('off')).toBe(undefined)
    expect(budgetUsd('5')).toBe(5)
    expect(budgetUsd(undefined)).toBe(undefined)
  })

  test('at 80% of the budget, routing goes one tier cheaper', { options: { budget: '1' } }, async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'hard', usage: { ...USAGE, input_tokens: 0, output_tokens: 0 } } }))
    let spawnedOn: string | undefined
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'b1' }
    })
    await mainSpend($, on, 0.85)
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe('claude-sonnet-5-5')
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^Budget\s+████░ 85% of \$1$/ })).toBeDefined()
    await ui.press({ key: 'row-b1' } as never)
    expect(await ui.find({ type: 'Text', text: /classifier: hard → normal \(85% of \$1 budget: one tier down\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('with the budget spent, the cheapest model the role allows; risky tasks keep Opus', { options: { budget: '1' } }, async ($, on) => {
    mock.clock(on)
    const answers = ['hard', 'hard', 'standard risky']
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: answers.shift()!, usage: { ...USAGE, input_tokens: 0, output_tokens: 0 } } }))
    const models: string[] = []
    let n = 0
    on('agent.spawn', async (_$, e) => {
      models.push(e.model ?? '')
      return { model: e.model ?? '', agentId: `s${++n}` }
    })
    await mainSpend($, on, 1.2)
    await $.agent.spawn(spawnInput())
    await $.agent.spawn(spawnInput({ subagentType: 'model-router:architect', prompt: 'Plan the cache layer' }))
    await $.agent.spawn(spawnInput({ prompt: 'Deploy main to production now' }))
    // builder to Haiku, architect no lower than Sonnet, the risky task on Opus
    expect(models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
  })

  test('a toast when the bill crosses 80% and 100%, once each', { options: { budget: '1' } }, async ($, on) => {
    mock.clock(on)
    engineBeneath(on)
    const toasts: string[] = []
    on('ui.toast', async (_$: unknown, e: any) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const done = () => $.turn.complete({ turnId: 'm1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    await mainSpend($, on, 0.85)
    await done()
    await done()
    expect(toasts).toEqual(['Model router: 85% of the $1 budget. Routing one tier cheaper.'])
  })

  test('without a budget nothing changes', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'hard', usage: { ...USAGE, input_tokens: 0, output_tokens: 0 } } }))
    let spawnedOn: string | undefined
    on('agent.spawn', async (_$, e) => {
      spawnedOn = e.model
      return { model: e.model ?? '', agentId: 'n1' }
    })
    await mainSpend($, on, 50)
    await $.agent.spawn(spawnInput())
    expect(spawnedOn).toBe('claude-opus-5-5')
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^Budget/ })).toBe(undefined)
    await ui.unmount()
  })
})

describe('0.8.0 pane at start', () => {
  test('the pane opens when a session starts', async ($, on) => {
    let opened = 0
    on('ui.open', async () => {
      opened++
      return { value: { isPlaced: true as const } }
    })
    on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    expect(opened).toBe(1)
  })

  test('with the setting off, only /router opens it', { options: { openPane: false } }, async ($, on) => {
    let opened = 0
    on('ui.open', async () => {
      opened++
      return { value: { isPlaced: true as const } }
    })
    on('session.start', async (_$: unknown, e: any) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    expect(opened).toBe(0)
    await $.command.run({ command: 'router', args: '' } as never)
    expect(opened).toBe(1)
  })
})
