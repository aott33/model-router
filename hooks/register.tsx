import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { AgentRow, RouterLedger, RouterMeter, RouterView, Tier, Tokens } from '../types'
import { ROLES, ROLE_MODEL } from './lib/agents'
import {
  BUDGET_WARN,
  CLASSIFIER_EFFORT,
  CLASSIFIER_MODEL,
  CLASSIFIER_SYSTEM,
  TIER_WORD,
  EFFORT_CAP,
  FORCED_TIER,
  MODEL_FOR_TIER,
  ORDER,
  ZERO,
  addTokens,
  asksForLongRun,
  budgetUsd,
  classifyKey,
  builtinClassifierText,
  capEffort,
  classifierPrompt,
  costOf,
  explainTier,
  clockText,
  fallbackTier,
  familyOf,
  fullestWindow,
  looksRisky,
  parseMode,
  parseRisky,
  parseTier,
  pressureThreshold,
  rescueReason,
  rescueTier,
  roleOf,
  routeTier,
  tierOfModel,
  tokensFromUsage,
  usd,
  limitName,
  windowGauge,
  type CacheTtl,
  type Family,
  type Effort,
  type Mode,
} from './lib/pricing'

const PANE = 'model-router'
const EMPTY: RouterLedger = { rows: {}, classifierCost: 0, routed: 0 }
const ledger = atom({ plugin: 'model-router', key: 'ledger' } as const, EMPTY)
/** The `/router` mode in this session; the pane redraws when it is written. */
const modeState = atom({ plugin: 'model-router', key: 'mode' } as const, undefined)
const EMPTY_METER: RouterMeter = { limits: [] }
/** What the engine measures for the session (its cost, the rate-limit windows) and the turn receipt. */
const meter = atom({ plugin: 'model-router', key: 'meter' } as const, EMPTY_METER)
/** Which pane row is expanded. */
const view = atom({ plugin: 'model-router', key: 'view' } as const, {} as RouterView)

/** The classifier's budget. A spawn waits on it, so a slow answer costs more than a wrong tier. */
const CLASSIFY_MS = 3000
/** How long a subagent's first request waits for its spawn to be recorded, so it gets its effort. */
const SPAWN_WAIT_MS = 2000
const MODE_KEY = 'mode'
/** The model each unrouted agent type was last seen running on, for a fair baseline. */
const TYPE_MODELS_KEY = 'agentModels'

/** A router role's registered model as a full id, the model it runs on unrouted. */
const ROLE_BASELINE = MODEL_FOR_TIER[tierOfModel(ROLE_MODEL)]

/** True for the router's own roles, as registered from ROLES. */
function isRole(role: string | undefined): boolean {
  return ROLES.some(r => r.name === role)
}

type Baseline = 'unrouted' | Exclude<Family, 'haiku4' | 'haiku5'>

function blankRow(id: string, label: string, agentType: string, now: number): AgentRow {
  return { id, label, agentType, tokens: ZERO, cost: 0, startedAt: now }
}

function shortModel(model: string | undefined): string {
  if (!model) return '?'
  return { haiku4: 'Haiku4', haiku5: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }[familyOf(model)]
}

/** The main conversation's cache lives an hour; a subagent's five minutes. */
function ttlOf(id: string): CacheTtl {
  return id === 'main' ? '1h' : '5m'
}

/**
 * The same tokens on the baseline. Priced on the row's summed tokens, so a fixed baseline
 * or a later change of the setting reprices the whole bill.
 */
function baselineCost(r: AgentRow, baseline: Baseline): number {
  const family = baseline === 'unrouted' ? familyOf(r.baselineModel ?? r.model) : baseline
  return costOf(r.tokens, family, ttlOf(r.id))
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

/** A spawn's row details, kept in memory so a row that `/clear` wiped can be written again. */
type SpawnRow = Partial<AgentRow> & { startedAt: number }

/**
 * The row a step or a finish writes to: the ledger's, else one rebuilt from what the spawn
 * recorded (its tokens and cost start over), else a blank one. `routed` counts a rebuilt
 * routed row again, since the wipe took its count with it.
 */
function rowFor(
  l: RouterLedger,
  id: string,
  now: number,
  spawnRows: ReadonlyMap<string, SpawnRow>,
): { row: AgentRow; routed: number } {
  const row = l.rows[id]
  if (row) return { row, routed: l.routed }
  const blank =
    id === 'main' ? blankRow(id, 'main conversation', 'main', now) : blankRow(id, 'subagent', '?', now)
  const saved = spawnRows.get(id)
  if (!saved) return { row: blank, routed: l.routed }
  return {
    row: { ...blank, ...saved, tokens: ZERO, cost: 0 },
    routed: l.routed + (saved.via !== undefined && saved.via !== 'unrouted' ? 1 : 0),
  }
}

/** Writes a spawned agent's row; its steps may have landed first, so it merges into them. */
async function record(
  $: EngineInterface,
  id: string,
  now: number,
  fields: Partial<AgentRow>,
  routed: boolean,
  spawnRows: Map<string, SpawnRow>,
) {
  // Dropped oldest first, never all at once: a running agent's details must outlive a burst of spawns.
  if (spawnRows.size > 500) spawnRows.delete(spawnRows.keys().next().value!)
  spawnRows.set(id, { ...fields, startedAt: now })
  await update($, ledger, l => {
    const row = l.rows[id] ?? blankRow(id, 'subagent', '?', now)
    return { ...l, routed: l.routed + (routed ? 1 : 0), rows: { ...l.rows, [id]: { ...row, ...fields } } }
  })
}

/** How long a finished agent's line stays in the band above the prompt. */
const BAND_FADE_MS = 30_000

/**
 * Marks an agent finished, once: its row gets `finishedAt`, restored first if a `/clear`
 * wiped it, and the band is drawn again when the line's time is up.
 */
async function finishAgent($: EngineInterface, id: string, spawnRows: ReadonlyMap<string, SpawnRow>) {
  const now = await $.clock.now()
  let finished = false
  await update($, ledger, l => {
    finished = false
    if (!l.rows[id] && !spawnRows.has(id)) return l
    const { row, routed } = rowFor(l, id, now, spawnRows)
    if (row.finishedAt !== undefined) return l
    finished = true
    return { ...l, routed, rows: { ...l.rows, [id]: { ...row, finishedAt: now } } }
  })
  if (finished) $.clock.after(BAND_FADE_MS, () => $.ui.invalidate('ui.render'))
}

/** Statuses after which an agent will not step again on its own. */
const ENDED = new Set(['completed', 'failed', 'killed', 'idle'])
/** How old a row must be before a missing list entry counts as finished: a new spawn may not be listed yet. */
const RECONCILE_AFTER_MS = 10_000

/**
 * Finishes the rows of agents the engine no longer runs, for an agent whose finish events
 * were missed (it ended before this module loaded, or was killed): its band line would
 * otherwise stay up for the rest of the session.
 */
async function reconcileAgents($: EngineInterface, spawnRows: ReadonlyMap<string, SpawnRow>) {
  const l = await read($, ledger)
  const now = await $.clock.now()
  const open = Object.values(l.rows).filter(
    r => r.id !== 'main' && r.finishedAt === undefined && now - r.startedAt > RECONCILE_AFTER_MS,
  )
  if (open.length === 0) return
  const status = new Map((await $.agent.list()).map(a => [a.id, a.status as string]))
  for (const r of open) {
    const s = status.get(r.id)
    if (s === undefined || ENDED.has(s)) await finishAgent($, r.id, spawnRows)
  }
}

/** The pane's fixed column widths; Agent takes what is left of the pane. */
const TIER_WIDTH = 8
const MODEL_WIDTH = 8
const TIME_WIDTH = 6
const COST_WIDTH = 8
const BASE_WIDTH = 10
/** The columns that always show; Time joins them when the Agent column can spare it. */
const MIN_FIXED = TIER_WIDTH + MODEL_WIDTH + COST_WIDTH + BASE_WIDTH
/** The narrowest Agent column: a status mark and the ellipsis. */
const AGENT_MIN = 4
/** The header's label column. */
const FIELD_WIDTH = 12
/** The Agent column the Time column must leave before it shows. */
const AGENT_WIDE = 16

/**
 * Tier word for the pane: `↑` when it was moved up after struggling, `!` when the risk floor
 * raised it, `↓` when rate limits lowered it.
 */
function tierLabel(r: AgentRow): string {
  if (!r.tier || r.via === 'unrouted') return '-'
  return TIER_WORD[r.tier] + (r.rescued ? '↑' : r.risky ? '!' : r.pressure !== undefined || r.budget !== undefined ? '↓' : '')
}

/** How a routed agent is getting on, for the rescue: its tier and role, and what went wrong so far. */
type Health = { tier: Tier; role: string | undefined; errors: number; steps: number; since: number }

/**
 * Counts one more request of a routed agent and, when it is struggling, moves it up one model:
 * its next requests go there, its effort cap follows the new tier, and its row says why.
 * The counts start over, so an agent still stuck one tier up can move once more.
 */
async function rescueStep(
  $: EngineInterface,
  id: string,
  maps: {
    health: Map<string, Health>
    rescuedTo: Map<string, string>
    effortCaps: Map<string, Effort | undefined>
    spawnRows: Map<string, SpawnRow>
  },
  effortByTier: boolean,
) {
  const h = maps.health.get(id)
  if (!h) return
  h.steps += 1
  const now = await $.clock.now()
  const reason = rescueReason(h.tier, { errors: h.errors, steps: h.steps, ms: now - h.since })
  if (!reason) return
  const up = rescueTier(h.tier, h.role)
  if (!up) {
    maps.health.delete(id) // nowhere left to go: stop counting
    return
  }
  const model = MODEL_FOR_TIER[up]
  if (maps.rescuedTo.size > 500) maps.rescuedTo.delete(maps.rescuedTo.keys().next().value!)
  maps.rescuedTo.set(id, model)
  maps.health.set(id, { ...h, tier: up, errors: 0, steps: 0, since: now })
  const effort = effortByTier ? EFFORT_CAP[up] : undefined
  if (maps.effortCaps.has(id)) maps.effortCaps.set(id, effort)
  const note = ` · moved up to ${shortModel(model)} (${reason})`
  const saved = maps.spawnRows.get(id)
  if (saved) maps.spawnRows.set(id, { ...saved, tier: up, model, effort, why: (saved.why ?? '') + note })
  await update($, ledger, l => {
    const row = l.rows[id]
    if (!row) return l
    return {
      ...l,
      rows: { ...l.rows, [id]: { ...row, tier: up, model, effort, rescued: (row.rescued ?? 0) + 1, why: (row.why ?? '') + note } },
    }
  })
}

/** One running (or just finished) routed subagent, as the band above the prompt shows it. */
function bandLine(r: AgentRow): string {
  return `⇄ ${roleOf(r.agentType) ?? r.agentType}: ${r.label} → ${shortModel(r.model)} · ${usd(r.cost)}`
}

/** The pane's savings: `saved N%`, or `N% more` when routing cost more than the baseline. */
function savedText(t: { base: number; saved: number }): string {
  if (t.base <= 0) return ''
  const pct = Math.round(t.saved * 100)
  return pct < 0 ? `   ${-pct}% more` : `   saved ${pct}%`
}

/** The status line's savings: `N% saved`, or `N% more` when routing cost more than the baseline. */
function statusSaved(saved: number): string {
  const pct = Math.round(saved * 100)
  return pct < 0 ? `${-pct}% more` : `${pct}% saved`
}

/** A label cut to fit `width` cells with a space to spare, ending in `…` when cut. */
function fit(text: string, width: number): string {
  return text.length > width - 1 ? text.slice(0, Math.max(0, width - 2)) + '…' : text
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
  budgetLimit?: number,
) {
  const l = await read($, ledger)
  const t = totals(l, baseline)
  const parts = [modeLabel(mode)]
  if (budgetLimit !== undefined) parts.push(`budget ${Math.round((t.cost / budgetLimit) * 100)}% of $${budgetLimit}`)
  if (mode === 'on' && pressureAt !== undefined) {
    const pct = await windowPercent($)
    if (pct >= pressureAt) parts.push(`limits ${Math.round(pct)}%: one tier down`)
  }
  // Against the unrouted baseline nothing can be saved until an agent is routed: the main
  // conversation is never routed, so "N vs N (0% saved)" would only look like a fault.
  if (baseline === 'unrouted' && l.routed === 0) {
    if (t.cost > 0) parts.push(`${usd(t.cost)} · no agents routed yet`)
  } else if (t.base > 0) parts.push(`${usd(t.cost)} vs ${usd(t.base)} ${baselineName} (${statusSaved(t.saved)})`)
  const text = parts.filter(Boolean).join(' · ')
  $.ui.status(text || undefined)
}

/** Resolves undefined after `ms`, so a call raced against it can't hold a spawn up. */
function timeout($: EngineInterface, ms: number): Promise<undefined> {
  return $.clock.sleep(ms).then(() => undefined)
}

/**
 * The `/router` mode: the atom when it holds one, else what the store kept from an earlier
 * session, else on. It only reads, so a ui.render hook may call it: state.set is refused
 * while one draws, and /clear empties the atom before the pane is drawn again.
 */
async function currentMode($: EngineInterface): Promise<Mode> {
  return (await read($, modeState)) ?? (await storedMode($)) ?? 'on'
}

/**
 * currentMode, and the atom filled when it was empty so the pane reads it from then on.
 * For the hooks that run outside a draw (session.start, command.run, agent.spawn,
 * turn.step, session.end), never a ui.render hook.
 */
async function loadMode($: EngineInterface): Promise<Mode> {
  const held = await read($, modeState)
  if (held !== undefined) return held
  const mode = (await storedMode($)) ?? 'on'
  await update($, modeState, () => mode)
  return mode
}

async function setMode($: EngineInterface, next: Mode) {
  await update($, modeState, () => next)
}

/** The `/router` mode saved by an earlier session, if any. */
async function storedMode($: EngineInterface): Promise<Mode | undefined> {
  try {
    return parseMode(await $.store.get(MODE_KEY))
  } catch {
    return undefined
  }
}

/** The models agent types ran on in earlier sessions; empty when nothing is stored or the read fails. */
async function storedTypeModels($: EngineInterface): Promise<Record<string, string>> {
  try {
    const v = await $.store.get(TYPE_MODELS_KEY)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter((p): p is [string, string] => typeof p[1] === 'string'))
  } catch {
    return {}
  }
}

type TypeModels = { models: Record<string, string>; loaded: boolean }

/** Reads the stored type models once; a type seen before the read keeps what was seen. */
async function loadTypeModels($: EngineInterface, t: TypeModels) {
  if (t.loaded) return
  t.loaded = true
  t.models = { ...(await storedTypeModels($)), ...t.models }
}

/** Remembers the model an unrouted agent type ran on, writing the store only on a change. */
async function rememberTypeModel($: EngineInterface, t: TypeModels, type: string, model: string) {
  if (t.models[type] === model) return
  t.models = { ...t.models, [type]: model }
  try {
    await $.store.set(TYPE_MODELS_KEY, t.models)
  } catch (err) {
    $.ui.log(`could not save the model of ${type}: ${String(err)}`)
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

/** Where classifier verdicts are kept across sessions, by a hash of what the classifier read. */
const CLASS_CACHE_KEY = 'classified'
/** How many verdicts the cache keeps; the oldest goes first. */
const CLASS_CACHE_MAX = 300

type ClassCache = { entries: Map<string, { tier: Tier; risky: boolean }>; loaded: boolean }

/** A SHA-256 of the text, so the store keeps no task text. */
async function hashKey(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/** Reads the cached verdicts once; a verdict made before the read keeps its place. */
async function loadClassCache($: EngineInterface, c: ClassCache) {
  if (c.loaded) return
  c.loaded = true
  try {
    const v = await $.store.get(CLASS_CACHE_KEY)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return
    const stored = new Map<string, { tier: Tier; risky: boolean }>()
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const [tier, risky] = String(x).split('|')
      if (ORDER.includes(tier as Tier)) stored.set(k, { tier: tier as Tier, risky: risky === 'r' })
    }
    c.entries = new Map([...stored, ...c.entries])
  } catch {
    // start with an empty cache
  }
}

/** Keeps a verdict, dropping the oldest past the cap, and saves the cache. */
async function rememberClass($: EngineInterface, c: ClassCache, key: string, v: { tier: Tier; risky: boolean }) {
  c.entries.delete(key)
  c.entries.set(key, v)
  while (c.entries.size > CLASS_CACHE_MAX) c.entries.delete(c.entries.keys().next().value!)
  try {
    await $.store.set(
      CLASS_CACHE_KEY,
      Object.fromEntries([...c.entries].map(([k, x]) => [k, `${x.tier}|${x.risky ? 'r' : ''}`])),
    )
  } catch (err) {
    $.ui.log(`could not save the classifier cache: ${String(err)}`)
  }
}

/** The budget gauge's text: `████░ 84% of $5`. */
function budgetText(spent: number, usd: number, now: number): string {
  return `${windowGauge({ percentUsed: (spent / usd) * 100 }, now)} of $${usd}`
}

export const register: Register = (on, options) => {
  const baseline = (['unrouted', 'fable', 'opus', 'sonnet'].includes(String(options.baseline))
    ? options.baseline
    : 'unrouted') as Baseline
  const routeAll = options.routeAll !== false
  const respectExplicit = options.respectExplicitModel !== false
  const baselineName = baseline === 'unrouted' ? 'unrouted' : `on ${shortModel(baseline)}`
  const effortByTier = options.effortByTier !== false
  const rescueOn = options.rescue !== false
  const budgetLimit = budgetUsd(options.budget)
  const riskFloor = options.riskFloor !== false
  const openAtStart = options.openPane !== false
  const pressureAt = options.limitPressure === 'off' ? undefined : pressureThreshold(options.limitPressure)

  /**
   * The model each agent type ran on when the router left it alone, by type. A built-in
   * such as Explore runs on its own model, not its parent's, so this is its baseline.
   */
  const typeModels: TypeModels = { models: {}, loaded: false }
  /** Agent calls that set their own effort, by tool_use_id, until their spawn reads it. */
  const callEffort = new Set<string>()
  /** Spawns between the call to `next` and its answer, which a first step may overtake. */
  const starting = new Set<Promise<unknown>>()
  /** Each routed subagent's effort cap, by agent id, as soon as it has started. */
  const effortCaps = new Map<string, Effort | undefined>()
  /** Each spawn's row details, by agent id, for rows a `/clear` wiped while the agent ran on. */
  const spawnRows = new Map<string, SpawnRow>()
  /** Each agent the classifier placed, by id: how it is doing, for the rescue. */
  const health = new Map<string, Health>()
  /** The model each rescued agent now runs on, by id. */
  const rescuedTo = new Map<string, string>()
  /** Classifier verdicts by a hash of what it read, so a repeated task skips the call. */
  const classCache: ClassCache = { entries: new Map(), loaded: false }
  /** The highest budget mark already announced with a toast: 0, 80 or 100. */
  let budgetToasted = 0

  on('session.start', async ($, e, next) => {
    const mode = await loadMode($)
    if (mode !== 'on') $.ui.status(modeLabel(mode))
    for (const role of ROLES) {
      try {
        await $.agent.register({ ...role, model: ROLE_MODEL })
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
    if (openAtStart) void $.ui.open({ id: PANE, title: 'Model router' })
    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const mode = await loadMode($)
    if (arg === 'reset') {
      await update($, ledger, () => EMPTY)
      await update($, meter, m => ({ ...(m ?? EMPTY_METER), turn: undefined, lastTurn: undefined }))
      await update($, view, () => ({}))
      budgetToasted = 0
      $.ui.status(modeLabel(mode))
      return { text: 'Model router bill cleared.' }
    }
    if (arg === 'status') return { text: `Model router ${modeText(mode)}.` }
    const picked = parseMode(arg)
    if (picked) {
      await setMode($, picked)
      try {
        await $.store.set(MODE_KEY, picked)
      } catch (err) {
        $.ui.log(`could not save the router mode: ${String(err)}`)
      }
      await refreshStatus($, baseline, baselineName, picked, pressureAt, budgetLimit)
      const back = picked === 'on' ? '' : '; /router on to go back'
      return { text: `Model router ${modeText(picked)}. Kept across sessions${back}.` }
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
  }).catch(($, e, next) => next(e)) // a note about effort is a side job: never block the call

  // A routed agent's tool calls: failures in a row are the rescue's first sign of trouble.
  // Not for a runner: reporting a failing command is its job, not a sign it is stuck.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const h = e.agentId ? health.get(e.agentId) : undefined
    if (h && h.role !== 'runner' && result.deny === undefined) h.errors = 'isError' in result && result.isError ? h.errors + 1 : 0
    return result
  }).catch(($, e, next) => next(e)) // watching is a side job: never block the call

  // 1. Haiku reads the task and sorts it. 2. The router sets the model.
  on('agent.spawn', async ($, e, next) => {
    const mode = await loadMode($)
    await loadTypeModels($, typeModels)
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
          why:
            mode === 'off'
              ? 'not routed: /router off'
              : e.fork
                ? 'not routed: a fork keeps its parent\'s model'
                : e.workflow
                  ? 'not routed: a workflow agent\'s model cannot be changed'
                  : e.isTeammate
                    ? 'not routed: teammates keep their team\'s model'
                    : 'not routed: Route every subagent is off',
        }, false, spawnRows)
        // What this type runs on by itself: a fork or teammate takes its parent's, a
        // workflow agent or a named model is the call's choice, not the type's. The
        // router's own agents are compared with their registered model instead.
        if (!role && !e.fork && !e.workflow && !e.isTeammate && !e.model && result.model) {
          await rememberTypeModel($, typeModels, e.subagentType, result.model)
        }
      }
      return result
    }

    let tier: Tier
    let via: AgentRow['via']
    let model: string | undefined
    let risky = false
    let pressure: number | undefined
    let budgetPct: number | undefined
    let why: string

    if (respectExplicit && e.model) {
      via = 'explicit'
      model = e.model
      tier = tierOfModel(e.model)
      why = `kept: the Agent call named ${shortModel(e.model)}`
    } else if (mode !== 'on') {
      via = 'forced'
      tier = FORCED_TIER[mode]
      model = MODEL_FOR_TIER[tier]
      why = `/router ${mode}: every routed subagent on ${shortModel(model)}`
    } else {
      let picked: Tier | undefined
      let cached = false
      const asked0 = { agentType: e.subagentType, description: e.description, prompt: e.prompt }
      const key = await hashKey(classifyKey(asked0))
      await loadClassCache($, classCache)
      const hit = classCache.entries.get(key)
      if (hit) {
        picked = hit.tier
        risky = hit.risky
        cached = true
      } else try {
        const r = await $.model.complete(
          {
            model: CLASSIFIER_MODEL,
            system: CLASSIFIER_SYSTEM,
            prompt: classifierPrompt({
              agentType: e.subagentType,
              description: e.description,
              prompt: e.prompt,
            }),
            maxTokens: 8,
            effort: CLASSIFIER_EFFORT,
            timeoutMs: CLASSIFY_MS,
          },
          { signal: next.signal },
        )
        const c = costOf(tokensFromUsage(r.usage), familyOf(CLASSIFIER_MODEL))
        await update($, ledger, l => ({ ...l, classifierCost: l.classifierCost + c }))
        if (r.isAnswered) {
          picked = parseTier(r.text)
          risky = parseRisky(r.text)
          if (picked) await rememberClass($, classCache, key, { tier: picked, risky })
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
      // Agents run in the background by default, so only the task's own words open up `long`.
      const allowLong = asksForLongRun(`${e.description}\n${e.prompt}`)
      tier = routeTier(asked, role, allowLong, { risky })
      if (pressureAt !== undefined) {
        const pct = await windowPercent($)
        const lower = pct >= pressureAt ? routeTier(asked, role, allowLong, { risky, underPressure: true }) : tier
        // Marked only when the window actually moved the agent down.
        if (lower !== tier) {
          tier = lower
          pressure = pct
        }
      }
      if (budgetLimit !== undefined) {
        const pct = (totals(await read($, ledger), baseline).cost / budgetLimit) * 100
        if (pct >= BUDGET_WARN) {
          const lower = routeTier(asked, role, allowLong, { risky, underPressure: true, cheapest: pct >= 100 })
          if (ORDER.indexOf(lower) < ORDER.indexOf(tier)) {
            tier = lower
            budgetPct = pct
          }
        }
      }
      model = MODEL_FOR_TIER[tier]
      why = explainTier({
        source: via,
        asked,
        final: tier,
        role,
        risky,
        allowLong,
        pressure,
        cached,
        budget: budgetPct !== undefined && budgetLimit !== undefined ? { pct: budgetPct, usd: budgetLimit } : undefined,
      })
    }

    // Effort is set per request in turn.step; here the router only decides the cap.
    const effort =
      effortByTier && via !== 'explicit' && via !== 'forced' && !callSetEffort
        ? EFFORT_CAP[tier]
        : undefined
    if (effort) why += ` · effort ≤ ${effort}`

    // Held in `starting` until the cap is known: the agent's first request can arrive
    // before `next` answers and must wait for its effort cap.
    const spawned = (async () => {
      const result = await next({ ...e, model })
      if (result.deny !== undefined || !result.agentId) return result
      if (effortCaps.size > 500) effortCaps.clear()
      effortCaps.set(result.agentId, effort)
      // Only an agent the classifier placed can be moved up: a named or forced model stays.
      if (rescueOn && (via === 'haiku' || via === 'builtin' || via === 'fallback')) {
        if (health.size > 500) health.delete(health.keys().next().value!)
        health.set(result.agentId, { tier, role, errors: 0, steps: 0, since: now })
      }
      await record($, result.agentId, now, {
        label: e.description,
        agentType: e.subagentType,
        tier,
        via,
        model: result.model,
        effort,
        risky: risky || undefined,
        pressure,
        budget: budgetPct,
        why,
        // A model Claude named would have run anyway. A router role runs on its registered
        // model; another type on its own model when it was seen running unrouted (a built-in
        // such as Explore), else on the parent's it inherits. The parent's model is a guess,
        // marked for the pane.
        baselineModel:
          via === 'explicit'
            ? result.model
            : isRole(role)
              ? ROLE_BASELINE
              : (typeModels.models[e.subagentType] ?? e.parentModel),
        baselineGuessed:
          (via !== 'explicit' && !isRole(role) && typeModels.models[e.subagentType] === undefined) || undefined,
      }, true, spawnRows)
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
    await loadMode($) // the first hook after /clear with a prompt: the pane reads the mode again
    let request = e
    if (e.agentId && health.has(e.agentId)) {
      try {
        await rescueStep($, e.agentId, { health, rescuedTo, effortCaps, spawnRows }, effortByTier)
      } catch {
        // the rescue is a side job: the request goes as it was
      }
    }
    const movedTo = e.agentId ? rescuedTo.get(e.agentId) : undefined
    if (movedTo && movedTo !== e.model) request = { ...request, model: movedTo }
    if (effortByTier && e.agentId && e.effort !== undefined) {
      try {
        const effort = capEffort(e.effort, await effortCapOf($, e.agentId, effortCaps, starting))
        if (effort !== e.effort) request = { ...request, effort }
      } catch {
        // leave the request as it is
      }
    }
    const result = yield* next(request)
    if (!result.usage) return result
    const usage = result.usage
    const t: Tokens = tokensFromUsage(usage)
    const id = e.agentId ?? 'main'
    const actual = costOf(t, familyOf(usage.model), ttlOf(id))
    const now = await $.clock.now()
    await update($, ledger, l => {
      const { row, routed } = rowFor(l, id, now, spawnRows)
      return {
        ...l,
        routed,
        rows: {
          ...l.rows,
          [id]: {
            ...row,
            model: row.model ?? usage.model,
            via: row.via ?? (id === 'main' ? 'unrouted' : row.via),
            baselineModel: row.baselineModel ?? (id === 'main' ? usage.model : undefined),
            tokens: addTokens(row.tokens, t),
            cost: row.cost + actual,
            // A finished agent woken again (SendMessage) is running once more.
            finishedAt: undefined,
          },
        },
      }
    })
    return result
  })

  // The main conversation's turn: the bill as it stood when the turn began, for the receipt.
  on('turn.start', async ($, e, next) => {
    try {
      const t = totals(await read($, ledger), baseline)
      const agents = Object.keys((await read($, ledger)).rows).filter(id => id !== 'main').length
      const startedAt = await $.clock.now()
      await update($, meter, m => ({ ...(m ?? EMPTY_METER), turn: { startedAt, cost: t.cost, base: t.base, agents } }))
    } catch {
      // the receipt is a side job
    }
    return next(e)
  })

  // A subagent's run ends with its own turn.complete; SubagentStop backs it up. Either
  // marks the row finished (once) and brings the status line up to date at once. The
  // main conversation's turn writes the receipt and finishes agents the engine has dropped.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      await finishAgent($, e.agentId, spawnRows)
    } else {
      try {
        const l = await read($, ledger)
        const t = totals(l, baseline)
        const agents = Object.keys(l.rows).filter(id => id !== 'main').length
        const now = await $.clock.now()
        await update($, meter, m => {
          const mark = (m ?? EMPTY_METER).turn
          if (!mark) return m ?? EMPTY_METER
          const cost = t.cost - mark.cost
          return {
            ...(m ?? EMPTY_METER),
            turn: undefined,
            lastTurn: { ms: now - mark.startedAt, agents: agents - mark.agents, cost, saved: t.base - mark.base - cost },
          }
        })
        await reconcileAgents($, spawnRows)
        // session.measure can trail the turn; read the engine's figures once more as it ends.
        const u = await $.session.usage()
        await update($, meter, m => ({
          ...(m ?? EMPTY_METER),
          limits: u.rateLimits.map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })),
          engineCost: u.cost?.usd ?? (m ?? EMPTY_METER).engineCost,
        }))
      } catch {
        // the receipt is a side job
      }
    }
    await refreshStatus($, baseline, baselineName, await currentMode($), pressureAt, budgetLimit)
    if (budgetLimit !== undefined) {
      const pct = (totals(await read($, ledger), baseline).cost / budgetLimit) * 100
      const mark = pct >= 100 ? 100 : pct >= BUDGET_WARN ? BUDGET_WARN : 0
      if (mark > budgetToasted) {
        budgetToasted = mark
        $.ui.toast(
          mark === 100
            ? `Model router: $${budgetLimit} budget spent. Routed agents now get the cheapest model their role allows.`
            : `Model router: ${Math.round(pct)}% of the $${budgetLimit} budget. Routing one tier cheaper.`,
        )
      }
    }
    return next(e)
  })

  // The engine's own figures: the rate-limit windows for the pane's gauges, and the
  // session's cost to set beside the bill.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') || e.changed.includes('cost')) {
      try {
        await update($, meter, m => ({
          ...(m ?? EMPTY_METER),
          limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
          engineCost: e.cost?.usd ?? (m ?? EMPTY_METER).engineCost,
        }))
      } catch {
        // a reading is a side job
      }
    }
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await finishAgent($, e.agent_id, spawnRows)
    await refreshStatus($, baseline, baselineName, await currentMode($), pressureAt, budgetLimit)
    return next(e)
  }).catch(($, e, next) => next(e)) // the bill is a side job: never hold up a stop

  // /clear starts a new session with an empty bill, so the totals go. Kept to one call:
  // session.end shares a short bound. spawnRows stays, for agents still running.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      budgetToasted = 0
      $.ui.status(modeLabel(await loadMode($)))
    }
    return next(e)
  })

  // The band above the prompt: one line per routed subagent while it runs, fading
  // BAND_FADE_MS after it finished.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const l = await read($, ledger)
    const now = await $.clock.now()
    const rows = Object.values(l.rows)
      .filter(r => r.id !== 'main' && r.via !== undefined && r.via !== 'unrouted')
      .filter(r => r.finishedAt === undefined || now - r.finishedAt < BAND_FADE_MS)
      .sort((a, b) => a.startedAt - b.startedAt)
    if (rows.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {rows.slice(0, Math.max(1, e.props.maxRows)).map(r => (
          <Text wrap="truncate" dimColor={r.finishedAt !== undefined}>
            {bandLine(r)}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const hasClient = 'Client' in els
    const mode = await currentMode($)
    const l = await read($, ledger)
    const m = (await read($, meter)) ?? EMPTY_METER
    const expanded = ((await read($, view)) ?? {}).expanded
    const now = await $.clock.now()
    const t = totals(l, baseline)
    const width = Math.max(MIN_FIXED + AGENT_MIN, (e.props.bodyColumns ?? 60) - 2)
    // The Time column goes first when the pane is narrow: the money columns stay whole.
    const withTime = width >= MIN_FIXED + TIME_WIDTH + AGENT_WIDE
    const fixed = MIN_FIXED + (withTime ? TIME_WIDTH : 0)
    const rows = Object.values(l.rows).sort((a, b) => b.startedAt - a.startedAt)
    const agents = rows.filter(r => r.id !== 'main').length
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 18)
    const shown = rows.slice(0, room)
    const agentWidth = width - fixed
    const baseHead = baseline === 'unrouted' ? 'Unrouted' : `On ${shortModel(baseline)}`
    const hasRisky = shown.some(r => tierLabel(r).endsWith('!'))
    const hasRescued = shown.some(r => tierLabel(r).endsWith('↑'))
    const hasPressure = shown.some(r => tierLabel(r).endsWith('↓'))
    const hasGuessed = baseline === 'unrouted' && shown.some(r => r.baselineGuessed)
    const tight = pressureAt !== undefined && m.limits.some(w => w.percentUsed >= pressureAt)
    const rowsCost = Object.values(l.rows).reduce((sum, r) => sum + r.cost, 0)

    // A labelled header row: the label in a fixed column so the values line up.
    const field = (label: string, value: string, color?: string) => (
      <Text key={`field-${label}`} wrap="truncate" color={color}>
        {label.padEnd(FIELD_WIDTH) + value}
      </Text>
    )

    const toggle = (id: string) => () =>
      update($, view, v => ({ expanded: (v ?? {}).expanded === id ? undefined : id }))

    const clock = (r: AgentRow) =>
      r.id === 'main' ? (
        <Text dimColor>–</Text>
      ) : hasClient && r.finishedAt === undefined ? (
        <els.Client key={`clock-${r.id}`} module="./clock.tsx" props={{ since: r.startedAt, now, endAt: null }} />
      ) : (
        <Text dimColor>{clockText((r.finishedAt ?? now) - r.startedAt)}</Text>
      )

    // One fixed-width Box per cell; the money columns right-aligned.
    const line = (
      agent: RenderElement | string,
      tier: string,
      model: string,
      time: RenderElement | string,
      cost: string,
      base: string,
      dim: boolean,
    ) => (
      <Box flexDirection="row">
        <Box width={agentWidth}>{typeof agent === 'string' ? <Text wrap="truncate" dimColor={dim}>{agent}</Text> : agent}</Box>
        <Box width={TIER_WIDTH} flexShrink={0}>
          <Text wrap="truncate" dimColor={dim}>{tier}</Text>
        </Box>
        <Box width={MODEL_WIDTH} flexShrink={0}>
          <Text wrap="truncate" dimColor={dim}>{model}</Text>
        </Box>
        {withTime && (
          <Box width={TIME_WIDTH} flexShrink={0} justifyContent="flex-end">
            {typeof time === 'string' ? <Text dimColor>{time}</Text> : time}
          </Box>
        )}
        <Box width={COST_WIDTH} flexShrink={0} justifyContent="flex-end">
          <Text wrap="truncate" dimColor={dim}>{cost}</Text>
        </Box>
        <Box width={BASE_WIDTH} flexShrink={0} justifyContent="flex-end">
          <Text wrap="truncate" dimColor={dim}>{base}</Text>
        </Box>
      </Box>
    )

    // The agent cell: ✓ finished or ◐ running, then the name, pressable by its number.
    const agentCell = (r: AgentRow, i: number) => {
      const dim = r.via === 'unrouted'
      const mark = r.id === 'main' ? '  ' : r.finishedAt === undefined ? '◐ ' : '✓ '
      const key = i < 9 && r.id !== 'main' ? String(i + 1) : undefined
      // The surface draws a Button's hotkey itself (`1:`), so the label is the name alone.
      const name = fit(r.label, agentWidth - (key ? 5 : 2))
      return (
        <Box flexDirection="row">
          <Text dimColor={r.finishedAt !== undefined || dim}>{mark}</Text>
          {key ? (
            <Button key={`row-${r.id}`} plain hotkey={key} label={name} dimColor={dim} onPress={toggle(r.id)} />
          ) : (
            <Text wrap="truncate" dimColor={dim}>{name}</Text>
          )}
        </Box>
      )
    }

    let numbered = 0
    return (
      <Box flexDirection="column" width={width}>
        <Text bold>{`Model router · ${mode}`}</Text>
        {mode !== 'on' && <Text color="yellow">{`${modeLabel(mode)} (/router on to go back)`}</Text>}
        <Text> </Text>
        {field('Spent', usd(t.cost))}
        {field(baseHead, `${usd(t.base)}${savedText(t)}`, t.saved > 0 ? 'green' : undefined)}
        {m.limits.map(w =>
          field(
            limitName(w.kind),
            windowGauge(w, now) + (tight && mode === 'on' && pressureAt !== undefined && w.percentUsed >= pressureAt ? '  · one tier down' : ''),
            pressureAt !== undefined && w.percentUsed >= pressureAt ? 'yellow' : undefined,
          ),
        )}
        {budgetLimit !== undefined &&
          field('Budget', budgetText(t.cost, budgetLimit, now), t.cost >= (budgetLimit * BUDGET_WARN) / 100 ? 'yellow' : undefined)}
        {m.lastTurn &&
          field(
            'Last turn',
            `${clockText(m.lastTurn.ms)}` +
              (m.lastTurn.agents > 0 ? ` · ${m.lastTurn.agents} agent${m.lastTurn.agents === 1 ? '' : 's'}` : '') +
              ` · +${usd(m.lastTurn.cost)}` +
              (m.lastTurn.saved > 0.005 ? ` · saved ${usd(m.lastTurn.saved)}` : ''),
          )}
        {/* On a subscription Claude Code reports no cost: nothing to compare with then. */}
        {(m.engineCost ?? 0) > 0 && field('Claude Code', `${usd(m.engineCost!)} total · this bill ${usd(rowsCost)} before the classifier`)}
        <Text> </Text>
        {agents === 0 ? (
          <Text dimColor wrap="wrap">No subagents yet. Ask Claude to use an agent and it shows up here.</Text>
        ) : (
          <Box flexDirection="column">
            {line('  Agent', 'Tier', 'Model', 'Time', 'Cost', baseHead, true)}
            <Text dimColor>{'─'.repeat(width)}</Text>
            {shown.map(r => {
              const i = r.id === 'main' ? -1 : numbered++
              const open = expanded === r.id && r.why
              return (
                <Box flexDirection="column">
                  {line(
                    agentCell(r, i),
                    tierLabel(r),
                    shortModel(r.model),
                    clock(r),
                    usd(r.cost),
                    (baseline === 'unrouted' && r.baselineGuessed ? '~' : '') + usd(baselineCost(r, baseline)),
                    r.via === 'unrouted',
                  )}
                  {open && (
                    <Text wrap="wrap" color="cyan">
                      {`    ${r.why}`}
                    </Text>
                  )}
                </Box>
              )
            })}
            {rows.length > room && <Text dimColor>{`…${rows.length - room} more`}</Text>}
            <Text> </Text>
            <Text dimColor wrap="truncate">
              {`${agents} agent${agents === 1 ? '' : 's'} · ${l.routed} routed · classifier ${usd(l.classifierCost)}`}
            </Text>
            <Text dimColor wrap="wrap">Why: ctrl+x tab, then a number. Esc: back</Text>
            {hasRescued && <Text dimColor>↑ moved up a model after struggling</Text>}
            {hasRisky && <Text dimColor>! risky: sent to Opus at least</Text>}
            {hasPressure && <Text dimColor>↓ moved down for rate limits or budget</Text>}
            {hasGuessed && <Text dimColor>~ guessed: this agent type's own model isn't known yet</Text>}
            <Text dimColor wrap="wrap">
              Dim rows are not routed. API list prices; plans billed by subscription see rate-limit use, not dollars.
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}
