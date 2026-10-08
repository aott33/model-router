import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, RouterLedger, Tier, Tokens } from '../types'
import { ROLES } from './lib/agents'
import {
  CLASSIFIER_MODEL,
  CLASSIFIER_SYSTEM,
  MODEL_FOR_TIER,
  ZERO,
  addTokens,
  clampTier,
  classifierPrompt,
  costOf,
  fallbackTier,
  familyOf,
  parseTier,
  roleOf,
  tierOfModel,
  tokensFromUsage,
  usd,
  type Family,
} from './lib/pricing'

const PANE = 'model-router'
const EMPTY: RouterLedger = { rows: {}, classifierCost: 0, routed: 0 }
const ledger = atom({ plugin: 'model-router', key: 'ledger' } as const, EMPTY)

const TIER_TAG: Record<Tier, string> = { simple: 'S', standard: 'M', hard: 'H', long: 'L' }

type Baseline = 'unrouted' | Exclude<Family, 'haiku4' | 'haiku5'>

function blankRow(id: string, label: string, agentType: string, now: number): AgentRow {
  return { id, label, agentType, tokens: ZERO, cost: 0, startedAt: now }
}

function shortModel(model: string | undefined): string {
  if (!model) return '?'
  return { haiku4: 'Haiku4', haiku5: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }[familyOf(model)]
}

/**
 * The same tokens on the baseline. Priced on the row's summed tokens, so a fixed baseline
 * or a later change of the setting reprices the whole bill.
 */
function baselineCost(r: AgentRow, baseline: Baseline): number {
  const family = baseline === 'unrouted' ? familyOf(r.baselineModel ?? r.model) : baseline
  return costOf(r.tokens, family)
}

function totals(l: RouterLedger, baseline: Baseline) {
  let cost = l.classifierCost
  let base = 0
  for (const r of Object.values(l.rows)) {
    cost += r.cost
    base += baselineCost(r, baseline)
  }
  return { cost, base, saved: base > 0 ? 1 - cost / base : 0 }
}

/** Writes a spawned agent's row; its steps may have landed first, so it merges into them. */
async function record($: EngineInterface, id: string, now: number, fields: Partial<AgentRow>, routed: boolean) {
  await update($, ledger, l => {
    const row = l.rows[id] ?? blankRow(id, 'subagent', '?', now)
    return { ...l, routed: l.routed + (routed ? 1 : 0), rows: { ...l.rows, [id]: { ...row, ...fields } } }
  })
}

async function refreshStatus($: EngineInterface, baseline: Baseline, baselineName: string) {
  const t = totals(await read($, ledger), baseline)
  if (t.base === 0) return
  $.ui.status(`${usd(t.cost)} vs ${usd(t.base)} ${baselineName} (${Math.round(t.saved * 100)}% saved)`)
}

export const register: Register = (on, options) => {
  const baseline = (['unrouted', 'fable', 'opus', 'sonnet'].includes(String(options.baseline))
    ? options.baseline
    : 'unrouted') as Baseline
  const routeAll = options.routeAll !== false
  const respectExplicit = options.respectExplicitModel !== false
  const baselineName = baseline === 'unrouted' ? 'unrouted' : `on ${shortModel(baseline)}`

  on('session.start', async ($, e, next) => {
    for (const role of ROLES) {
      try {
        await $.agent.register({ ...role, model: 'sonnet' })
      } catch (err) {
        $.ui.log(`could not add agent ${role.name}: ${String(err)}`)
      }
    }
    try {
      await $.command.register({
        name: 'router',
        description: 'Open the model router bill pane (/router reset clears it)',
        argumentHint: '[reset]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`could not add /router: ${String(err)}`)
    }
    // Opened unasked, so it only seats in a wide terminal; /router opens it anywhere.
    void $.ui.open({ id: PANE, title: 'Model router' })
    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    if (e.args.trim() === 'reset') {
      await update($, ledger, () => EMPTY)
      $.ui.status(undefined)
      return { text: 'Model router bill cleared.' }
    }
    await $.ui.open({ id: PANE, title: 'Model router', focus: true, closeOnEscape: true })
    return {}
  })

  // 1. Haiku reads the task and sorts it. 2. The router sets the model.
  on('agent.spawn', async ($, e, next) => {
    const role = roleOf(e.subagentType)
    const now = await $.clock.now()

    // Not routed: forks always inherit, a workflow agent's model cannot be rewritten,
    // and with routing narrowed only the router's own agents are touched.
    if (e.fork || e.workflow || (!routeAll && !role)) {
      const result = await next(e)
      if (result.deny === undefined && result.agentId) {
        await record($, result.agentId, now, {
          label: e.description || e.subagentType,
          agentType: e.subagentType,
          via: 'unrouted',
          model: result.model,
          baselineModel: result.model,
        }, false)
      }
      return result
    }

    let tier: Tier
    let via: AgentRow['via']
    let model: string | undefined

    if (respectExplicit && e.model) {
      via = 'explicit'
      model = e.model
      tier = tierOfModel(e.model)
    } else {
      let picked: Tier | undefined
      try {
        const r = await $.model.complete(
          {
            model: CLASSIFIER_MODEL,
            system: CLASSIFIER_SYSTEM,
            prompt: classifierPrompt({
              agentType: e.subagentType,
              description: e.description,
              prompt: e.prompt,
              background: e.background,
            }),
            maxTokens: 8,
            timeoutMs: 8000,
          },
          { signal: next.signal },
        )
        const c = costOf(tokensFromUsage(r.usage), familyOf(CLASSIFIER_MODEL))
        await update($, ledger, l => ({ ...l, classifierCost: l.classifierCost + c }))
        if (r.isAnswered) picked = parseTier(r.text)
      } catch {
        // fall through to the role's default
      }
      via = picked ? 'haiku' : 'fallback'
      tier = clampTier(picked ?? fallbackTier(role), role, e.background)
      model = MODEL_FOR_TIER[tier]
    }

    const result = await next({ ...e, model })
    if (result.deny !== undefined || !result.agentId) return result

    await record($, result.agentId, now, {
      label: e.description,
      agentType: e.subagentType,
      tier,
      via,
      model: result.model,
      // A model Claude named would have run anyway; otherwise the agent inherits its parent's.
      baselineModel: via === 'explicit' ? result.model : e.parentModel,
    }, true)
    return result
  }).catch(($, e, next) => next(e)) // routing is an optimisation: on failure, spawn as asked

  // 4. The bill: every model request, priced on the model that answered it.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!result.usage) return result
    const usage = result.usage
    const t: Tokens = tokensFromUsage(usage)
    const id = e.agentId ?? 'main'
    const actual = costOf(t, familyOf(usage.model))
    const now = await $.clock.now()
    await update($, ledger, l => {
      const row =
        l.rows[id] ??
        blankRow(id, id === 'main' ? 'main conversation' : 'subagent', id === 'main' ? 'main' : '?', now)
      return {
        ...l,
        rows: {
          ...l.rows,
          [id]: {
            ...row,
            model: row.model ?? usage.model,
            via: row.via ?? (id === 'main' ? 'unrouted' : row.via),
            baselineModel: row.baselineModel ?? (id === 'main' ? usage.model : undefined),
            tokens: addTokens(row.tokens, t),
            cost: row.cost + actual,
          },
        },
      }
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    await refreshStatus($, baseline, baselineName)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const l = await read($, ledger)
    const t = totals(l, baseline)
    const width = Math.max(30, (e.props.bodyColumns ?? 60) - 2)
    const rows = Object.values(l.rows).sort((a, b) => b.startedAt - a.startedAt)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 10)
    const labelWidth = Math.max(8, width - 33)
    const baseHead = baseline === 'unrouted' ? 'unrouted' : shortModel(baseline)

    return (
      <Box flexDirection="column" width={width}>
        <Text bold>
          {usd(t.cost)} spent · {usd(t.base)} {baselineName}
        </Text>
        <Text color={t.saved > 0 ? 'green' : undefined}>
          {t.base > 0 ? `${Math.round(t.saved * 100)}% saved` : 'No model calls yet.'} · {l.routed} routed ·
          classifier {usd(l.classifierCost)}
        </Text>
        <Text> </Text>
        <Text dimColor wrap="truncate">
          {'agent'.padEnd(labelWidth)} T model   {'cost'.padStart(7)} {baseHead.padStart(8)}
        </Text>
        {rows.slice(0, room).map(r => (
          <Text wrap="truncate" dimColor={r.via === 'unrouted'}>
            {(r.label.length > labelWidth - 1 ? r.label.slice(0, labelWidth - 2) + '…' : r.label).padEnd(labelWidth)}
            {r.tier ? TIER_TAG[r.tier] : '-'} {shortModel(r.model).padEnd(7)} {usd(r.cost).padStart(7)}{' '}
            {usd(baselineCost(r, baseline)).padStart(8)}
          </Text>
        ))}
        {rows.length > room && <Text dimColor>…{rows.length - room} more</Text>}
        <Text> </Text>
        <Text dimColor wrap="wrap">
          T: S simple→Haiku 5.5, M standard→Sonnet, H hard→Opus, L long→Fable (background only). Dim rows
          are not routed. API list prices; plans billed by subscription see rate-limit use, not dollars.
        </Text>
      </Box>
    )
  })
}
