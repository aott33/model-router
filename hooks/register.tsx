import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, RouterLedger, Tier, Tokens } from '../types'
import { ROLES } from './lib/agents'
import {
  CLASSIFIER_MODEL,
  CLASSIFIER_SYSTEM,
  EFFORT_CAP,
  FORCED_TIER,
  MODEL_FOR_TIER,
  ORDER,
  ZERO,
  addTokens,
  builtinClassifierText,
  capEffort,
  classifierPrompt,
  costOf,
  fallbackTier,
  familyOf,
  fullestWindow,
  looksRisky,
  parseMode,
  parseRisky,
  parseTier,
  pressureThreshold,
  roleOf,
  routeTier,
  tierOfModel,
  tokensFromUsage,
  usd,
  type Family,
  type Effort,
  type Mode,
} from './lib/pricing'

const PANE = 'model-router'
const EMPTY: RouterLedger = { rows: {}, classifierCost: 0, routed: 0 }
const ledger = atom({ plugin: 'model-router', key: 'ledger' } as const, EMPTY)

const TIER_TAG: Record<Tier, string> = { simple: 'S', standard: 'M', hard: 'H', long: 'L' }

/** The classifier's budget. A spawn waits on it, so a slow answer costs more than a wrong tier. */
const CLASSIFY_MS = 3000
/** How long a subagent's first request waits for its spawn to be recorded, so it gets its effort. */
const SPAWN_WAIT_MS = 2000
const MODE_KEY = 'mode'

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

/** Tier tag for the pane: `!` when the risk floor raised it, `↓` when rate limits lowered it. */
function tierTag(r: AgentRow): string {
  if (!r.tier) return '- '
  return (TIER_TAG[r.tier] + (r.risky ? '!' : r.pressure !== undefined ? '↓' : '')).padEnd(2)
}

/** The fullest rate-limit window in percent; 0 when the engine has none or the call fails. */
async function windowPercent($: EngineInterface): Promise<number> {
  try {
    return fullestWindow((await $.session.usage()).rateLimits)
  } catch {
    return 0
  }
}

/** What a mode does, as `/router` and `/router status` say it. */
function modeText(mode: Mode): string {
  if (mode === 'on') return 'on: Haiku picks the model for each subagent'
  if (mode === 'off') return 'off: subagents run on the model they would have without the router'
  return `sending every routed subagent to ${shortModel(MODEL_FOR_TIER[FORCED_TIER[mode]])}`
}

function modeLabel(mode: Mode): string | undefined {
  if (mode === 'on') return undefined
  if (mode === 'off') return 'router off'
  return `router: all ${shortModel(MODEL_FOR_TIER[FORCED_TIER[mode]])}`
}

async function refreshStatus(
  $: EngineInterface,
  baseline: Baseline,
  baselineName: string,
  mode: Mode,
  pressureAt: number | undefined,
) {
  const t = totals(await read($, ledger), baseline)
  const parts = [modeLabel(mode)]
  if (mode === 'on' && pressureAt !== undefined) {
    const pct = await windowPercent($)
    if (pct >= pressureAt) parts.push(`limits ${Math.round(pct)}%: one tier down`)
  }
  if (t.base > 0) parts.push(`${usd(t.cost)} vs ${usd(t.base)} ${baselineName} (${Math.round(t.saved * 100)}% saved)`)
  const text = parts.filter(Boolean).join(' · ')
  $.ui.status(text || undefined)
}

/** Resolves undefined after `ms`, so a call raced against it can't hold a spawn up. */
function timeout($: EngineInterface, ms: number): Promise<undefined> {
  return $.clock.sleep(ms).then(() => undefined)
}

/** The `/router` mode saved by an earlier session, if any. */
async function storedMode($: EngineInterface): Promise<Mode | undefined> {
  try {
    return parseMode(await $.store.get(MODE_KEY))
  } catch {
    return undefined
  }
}

/**
 * The effort cap of a routed subagent. Its first step can beat its spawn's answer, so it
 * waits briefly for spawns in flight. The caps are kept in memory because a hook reads
 * `$.state` as of the moment it started: a row written during the wait is not seen. The
 * ledger is the fallback after a hot reload has emptied memory.
 */
async function effortCapOf(
  $: EngineInterface,
  agentId: string,
  caps: ReadonlyMap<string, Effort | undefined>,
  starting: ReadonlySet<Promise<unknown>>,
) {
  if (!caps.has(agentId) && starting.size > 0) {
    await Promise.race([Promise.allSettled([...starting]), timeout($, SPAWN_WAIT_MS)])
  }
  return caps.has(agentId) ? caps.get(agentId) : (await read($, ledger)).rows[agentId]?.effort
}

export const register: Register = (on, options) => {
  const baseline = (['unrouted', 'fable', 'opus', 'sonnet'].includes(String(options.baseline))
    ? options.baseline
    : 'unrouted') as Baseline
  const routeAll = options.routeAll !== false
  const respectExplicit = options.respectExplicitModel !== false
  const baselineName = baseline === 'unrouted' ? 'unrouted' : `on ${shortModel(baseline)}`
  const effortByTier = options.effortByTier !== false
  const riskFloor = options.riskFloor !== false
  const pressureAt = options.limitPressure === 'off' ? undefined : pressureThreshold(options.limitPressure)

  // Module state starts over on a hot reload; the mode is read back from the store.
  let mode: Mode = 'on'
  let modeLoaded = false
  /** Agent calls that set their own effort, by tool_use_id, until their spawn reads it. */
  const callEffort = new Set<string>()
  /** Spawns between the call to `next` and its answer, which a first step may overtake. */
  const starting = new Set<Promise<unknown>>()
  /** Each routed subagent's effort cap, by agent id, as soon as it has started. */
  const effortCaps = new Map<string, Effort | undefined>()

  on('session.start', async ($, e, next) => {
    if (!modeLoaded) {
      modeLoaded = true
      mode = (await storedMode($)) ?? mode
    }
    if (mode !== 'on') $.ui.status(modeLabel(mode))
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
        description: 'Open the model router bill pane; on, off, haiku, sonnet or opus sets the mode; reset clears the bill',
        argumentHint: '[on|off|haiku|sonnet|opus|status|reset]',
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
    const arg = e.args.trim().toLowerCase()
    if (!modeLoaded) {
      modeLoaded = true
      mode = (await storedMode($)) ?? mode
    }
    if (arg === 'reset') {
      await update($, ledger, () => EMPTY)
      $.ui.status(modeLabel(mode))
      return { text: 'Model router bill cleared.' }
    }
    if (arg === 'status') return { text: `Model router ${modeText(mode)}.` }
    const picked = parseMode(arg)
    if (picked) {
      mode = picked
      modeLoaded = true
      try {
        await $.store.set(MODE_KEY, mode)
      } catch (err) {
        $.ui.log(`could not save the router mode: ${String(err)}`)
      }
      await refreshStatus($, baseline, baselineName, mode, pressureAt)
      const back = mode === 'on' ? '' : '; /router on to go back'
      return { text: `Model router ${modeText(mode)}. Kept across sessions${back}.` }
    }
    if (arg) return { text: `Unknown option "${arg}". Use on, off, haiku, sonnet, opus, status or reset.` }
    await $.ui.open({ id: PANE, title: 'Model router', focus: true, closeOnEscape: true })
    return {}
  })

  // An Agent call that sets its own effort was asked for that effort: remember it so
  // the router leaves that agent's effort alone.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.tool === 'Agent' && e.effort && e.tool_use_id) {
      // Read and removed by the spawn; a call that never spawns leaves one id behind.
      if (callEffort.size > 200) callEffort.clear()
      callEffort.add(e.tool_use_id)
    }
    return next(e)
  })

  // 1. Haiku reads the task and sorts it. 2. The router sets the model.
  on('agent.spawn', async ($, e, next) => {
    if (!modeLoaded) {
      modeLoaded = true
      mode = (await storedMode($)) ?? mode
    }
    const callSetEffort = callEffort.delete(e.tool_use_id)
    const role = roleOf(e.subagentType)
    const now = await $.clock.now()

    // Not routed: forks always inherit, a workflow agent's model cannot be rewritten,
    // a teammate is long-lived and always background (so it would qualify for Fable on
    // its first message alone), and with routing narrowed only the router's own agents
    // are touched. `/router off` leaves everything alone.
    if (mode === 'off' || e.fork || e.workflow || e.isTeammate || (!routeAll && !role)) {
      const result = await next(e)
      if (result.deny === undefined && result.agentId) {
        await record($, result.agentId, now, {
          label: e.description || e.name || e.subagentType,
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
    let risky = false
    let pressure: number | undefined

    if (respectExplicit && e.model) {
      via = 'explicit'
      model = e.model
      tier = tierOfModel(e.model)
    } else if (mode !== 'on') {
      via = 'forced'
      tier = FORCED_TIER[mode]
      model = MODEL_FOR_TIER[tier]
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
            timeoutMs: CLASSIFY_MS,
          },
          { signal: next.signal },
        )
        const c = costOf(tokensFromUsage(r.usage), familyOf(CLASSIFIER_MODEL))
        await update($, ledger, l => ({ ...l, classifierCost: l.classifierCost + c }))
        if (r.isAnswered) {
          picked = parseTier(r.text)
          risky = parseRisky(r.text)
        }
      } catch {
        // try the built-in classifier
      }
      via = picked ? 'haiku' : undefined
      if (!picked) {
        // The engine's own small model, with no rubric: worse than Haiku 4.5 with one, better
        // than a fixed default, and it keeps working if the pinned classifier model goes away.
        try {
          const label = await Promise.race([
            $.model.classify(builtinClassifierText({
              agentType: e.subagentType,
              description: e.description,
              prompt: e.prompt,
            }), ORDER),
            timeout($, CLASSIFY_MS),
          ])
          picked = parseTier(label ?? '')
          if (picked) via = 'builtin'
        } catch {
          // fall through to the role's default
        }
      }
      via ??= 'fallback'
      // Without Haiku's judgment, only a plainly destructive act counts as risky.
      if (via !== 'haiku') risky ||= looksRisky(`${e.description}\n${e.prompt}`)
      risky &&= riskFloor
      const asked = picked ?? fallbackTier(role)
      tier = routeTier(asked, role, e.background, { risky })
      if (pressureAt !== undefined) {
        const pct = await windowPercent($)
        const lower = pct >= pressureAt ? routeTier(asked, role, e.background, { risky, underPressure: true }) : tier
        // Marked only when the window actually moved the agent down.
        if (lower !== tier) {
          tier = lower
          pressure = pct
        }
      }
      model = MODEL_FOR_TIER[tier]
    }

    // Effort is set per request in turn.step; here the router only decides the cap.
    const effort =
      effortByTier && via !== 'explicit' && via !== 'forced' && !callSetEffort
        ? EFFORT_CAP[tier]
        : undefined

    // Held in `starting` until the cap is known: the agent's first request can arrive
    // before `next` answers and must wait for its effort cap.
    const spawned = (async () => {
      const result = await next({ ...e, model })
      if (result.deny !== undefined || !result.agentId) return result
      if (effortCaps.size > 500) effortCaps.clear()
      effortCaps.set(result.agentId, effort)
      await record($, result.agentId, now, {
        label: e.description,
        agentType: e.subagentType,
        tier,
        via,
        model: result.model,
        effort,
        risky: risky || undefined,
        pressure,
        // A model Claude named would have run anyway; otherwise the agent inherits its parent's.
        baselineModel: via === 'explicit' ? result.model : e.parentModel,
      }, true)
      return result
    })()
    starting.add(spawned)
    try {
      return await spawned
    } finally {
      starting.delete(spawned)
    }
  }).catch(($, e, next) => next(e)) // routing is an optimisation: on failure, spawn as asked

  // 3. Effort, lowered for easy tiers. 4. The bill: every model request, priced on the model that answered it.
  on('turn.step', async function* ($, e, next) {
    let request = e
    if (effortByTier && e.agentId && e.effort !== undefined) {
      try {
        const effort = capEffort(e.effort, await effortCapOf($, e.agentId, effortCaps, starting))
        if (effort !== e.effort) request = { ...e, effort }
      } catch {
        // leave the request as it is
      }
    }
    const result = yield* next(request)
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
    await refreshStatus($, baseline, baselineName, mode, pressureAt)
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
        {mode !== 'on' && <Text color="yellow">{modeLabel(mode)} (/router on to go back)</Text>}
        <Text> </Text>
        <Text dimColor wrap="truncate">
          {'agent'.padEnd(labelWidth)} T  model   {'cost'.padStart(7)} {baseHead.padStart(8)}
        </Text>
        {rows.slice(0, room).map(r => (
          <Text wrap="truncate" dimColor={r.via === 'unrouted'}>
            {(r.label.length > labelWidth - 1 ? r.label.slice(0, labelWidth - 2) + '…' : r.label).padEnd(labelWidth)}
            {tierTag(r)} {shortModel(r.model).padEnd(7)} {usd(r.cost).padStart(7)}{' '}
            {usd(baselineCost(r, baseline)).padStart(8)}
          </Text>
        ))}
        {rows.length > room && <Text dimColor>…{rows.length - room} more</Text>}
        <Text> </Text>
        <Text dimColor wrap="wrap">
          T: S simple→Haiku 5.5 at low effort, M standard→Sonnet at medium effort at most, H hard→Opus,
          L long→Fable (background only). ! risky, sent to Opus at least; ↓ one tier down for rate limits.
          Dim rows are not routed. API list prices; plans billed by
          subscription see rate-limit use, not dollars.
        </Text>
      </Box>
    )
  })
}
