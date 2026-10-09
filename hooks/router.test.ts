import { describe, expect, mock, test } from 'claude-code/testing'

import { clampTier, costOf, familyOf, parseTier, tierOfModel } from './lib/pricing'

/** Billionths of a dollar, so float sums compare exactly. */
const nano = (usd: number) => Math.round(usd * 1e9)

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
    expect(clampTier('long', 'runner')).toBe('standard')
    expect(clampTier('simple', 'architect')).toBe('standard')
    expect(clampTier('simple', undefined)).toBe('simple')
    expect(clampTier('long', 'builder', false)).toBe('hard')
    expect(clampTier('long', 'builder', true)).toBe('long')
    expect(tierOfModel('opus')).toBe('hard')
    expect(tierOfModel('claude-haiku-4-5')).toBe('simple')
  })
})

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

  // `$.agent.spawn` cannot start a background agent, so the background case is
  // covered by clampTier above.
  test('long goes to Opus for a foreground task', async ($, on) => {
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

describe('bill', () => {
  test('a routed step is priced on Haiku 5.5 and against the parent model', async ($, on) => {
    mock.clock(on)
    on('model.complete', async () => ({ value: { isAnswered: true as const, text: 'simple', usage: USAGE } }))
    on('agent.spawn', async (_$, e) => ({ model: e.model ?? '', agentId: 'a1' }))
    on('turn.step', async function* (_$, e) {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: 'done',
        toolUses: [],
        stopReason: 'end_turn' as never,
        usage: { ...USAGE, input_tokens: 2000, model: 'claude-haiku-5-5' },
      }
    })
    await $.agent.spawn(spawnInput())
    const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' })
    for await (const _ of s) {
      // drain
    }
    await s.result

    // 2k in + 1k out: Haiku 5.5 $0.0007, Opus 5.5 (the parent) $0.028; the Haiku 4.5
    // classifier call adds $0.006, so $0.0067 against $0.028 is 76% saved
    const ui = await $.ui.mount({
      plugin: 'model-router',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'model-router',
      props: { title: 'Model router', isFocused: false, bodyColumns: 70, placement: 'dock' } as never,
    })
    expect(await ui.find({ type: 'Text', text: /<\$0\.01 spent · \$0\.03 unrouted/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /76% saved/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /rename fooBar\s+S Haiku/ })).toBeDefined()
    await ui.unmount()
  })
})
