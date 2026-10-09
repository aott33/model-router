# model-router

A Claude Code mod that picks the model for each subagent before it starts, and shows what each one cost.

## What it does

1. **Four roles.** Adds `model-router:architect` (plans, no edits), `model-router:builder` (writes code), `model-router:runner` (runs tests and commands, no edits) and `model-router:fixer` (fixes what failed).
2. **Haiku reads every task first.** On each subagent spawn, Haiku 4.5 sorts the task into `simple`, `standard`, `hard` or `long`. The classifier stays on Haiku 4.5 because it answers without thinking, so an 8-token reply cap holds. It gets 3 seconds; if it fails or names no tier, the engine's built-in classifier gets another 3 seconds before the role default is used.
3. **The mod routes it.**

   | Tier | Model | Effort | Typical work |
   | --- | --- | --- | --- |
   | simple | Haiku 5.5 | low | rename, search, run tests |
   | standard | Sonnet 5.5 | medium at most | normal feature work |
   | hard | Opus 5.5 | unchanged | hard bugs, architecture |
   | long | Fable 5.1 | unchanged | multi-hour background runs |

   Effort is only ever lowered, never raised, and only for agents the router picked a model for. An Agent call that sets its own effort keeps it.

   Guard rails: `runner` never goes above Sonnet; `architect` and `fixer` never go below Sonnet; `long` (Fable, 2.5 times Opus) only for background agents, so a foreground task the parent waits on tops out at Opus. If neither classifier gives a tier, the role default is used (architect: Opus, builder and fixer: Sonnet, runner: Haiku). Forks, workflow agents and agent-team teammates are not routed (the engine ignores a model change for the first two; a teammate is long-lived, so one classification of its first message is not a good guide). A model Claude already named in the Agent call is kept (setting), and the pane shows it at that model's tier.
4. **Modes.** `/router off` leaves every subagent on the model it would have had; `/router haiku`, `/router sonnet` or `/router opus` sends every routed subagent to that model without asking the classifier (a model Claude named is still kept, per the setting below); `/router on` goes back to classifying. The mode is kept across sessions and shows in the status line; `/router status` names it.
5. **Bill pane.** `/router` opens a pane: each agent, its tier, the model that ran it, what it cost, and what the same tokens would have cost without the router. The main conversation and unrouted agents are dim rows, and the Haiku classifier calls are counted in the total. A status line under the prompt shows the running total. `/router reset` clears it.

## Settings (`/config`)

- **Compare against**: `unrouted` (default) prices each routed agent on its parent's model, the one it would have inherited, and every unrouted row on its own model, so only routing shows as saved. `fable`, `opus` or `sonnet` price everything, the main conversation included, on that model.
- **Route every subagent**: on routes built-in subagents (Explore, general-purpose) too; off routes only the four router agents.
- **Keep a model Claude asked for**: on by default.
- **Lower effort for easy tasks**: on by default; off leaves every agent's effort alone.

## Install

```
/plugin install model-router --marketplace aott33/model-router
```

Or for development: `claude --plugin-dir ./model-router`

Needs Claude Code 2.1.287 or later (mods).

## Limits

- The built-in classifier's calls are not in the bill: the engine does not report their tokens.
- A routed subagent's first request may wait up to 2 seconds for its spawn to be recorded, so it gets its effort from the start.
- Only subagents are routed. The main conversation stays on your session model, so total savings depend on how much work goes through subagents.
- Costs use API list prices (Oct 2026) and treat cache writes as 5-minute writes. Haiku 5.5 costs five times as much above a 100K-token prompt; the actual cost is priced per request, the baseline on each row's summed tokens at the lower rate. On a Pro or Max plan the dollar figures are API-equivalent; what you actually save is rate-limit headroom.
- The baseline assumes the same token counts on the baseline model, and that an agent would have inherited its parent's model (a built-in agent with its own model, such as Explore, may not have). Different models use different token counts for the same task, so the "saved" figure is an estimate.
- Model ids live in `hooks/lib/pricing.ts`. Update them and the price table when models change.

## Develop

```
claude plugin validate .
claude plugin test .
```

Releases follow `RELEASING.md`; changes are listed in `CHANGELOG.md`.
