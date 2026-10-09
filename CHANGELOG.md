# Changelog

All notable changes to model-router. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org). See `RELEASING.md` for the release process.

## [Unreleased]

## [0.4.1] - 2026-10-09

### Fixed

- A routed subagent's first request now gets its lowered effort. It used to go out at the session's effort, because the wait for the spawn re-read shared state that a hook only sees as of when it started. Found by running the mod in a live session; later requests were already right.
- `/router status` no longer says "router" twice, and `/router on` no longer suggests `/router on to go back`.

## [0.4.0] - 2026-10-09

### Added

- Risk floor: Haiku flags a task as risky when carrying it out could do costly or hard-to-reverse harm (deploying to production, deleting data, a forced push), judging the act rather than the subject. A risky task runs on Opus at least, past the runner's cap and past rate-limit pressure. Without a classifier answer, a narrow pattern check on destructive acts stands in. New setting **Send risky tasks to Opus** (on by default). The pane marks these rows `!`.
- Rate-limit awareness: when the fullest rate-limit window is at or past a threshold, routed tasks go one tier lower and never to Fable; role floors still hold. The status line shows the window. New setting **Route cheaper near rate limits** (`80` by default, or `70`, `90`, `off`). The pane marks these rows `↓`.

### Changed

- The classifier may now reply with two words (`hard risky`).

## [0.3.0] - 2026-10-09

### Added

- Effort by tier: a `simple` subagent runs at `low` effort and a `standard` one at `medium` at most. `hard` and `long` keep the effort they had. Effort is only ever lowered, never raised, and an Agent call that sets its own effort keeps it. New setting **Lower effort for easy tasks** (on by default).
- `/router on|off|haiku|sonnet|opus|status`: turn routing off, or send every routed subagent to one model without classifying. The mode is kept across sessions and shows in the status line and the bill pane.
- If Haiku 4.5 fails or names no tier, the engine's built-in classifier is asked before falling back to the role default. Routing keeps working if the pinned classifier model is retired.

### Changed

- The classifier now gets 3 seconds instead of 8, so a slow classifier holds up a spawn for less time.

## [0.2.1] - 2026-10-09

### Fixed

- Agent-team teammates are no longer classified or rerouted. A teammate always runs in the background, so a single read of its first message could send a long-lived agent to Fable. Teammates now start on the model the team gives them and show as dim, unrouted rows in the bill pane.

## [0.2.0] - 2026-10-09

First public release.

### Added

- Four subagents: `model-router:architect` (plans, no edits), `model-router:builder` (writes code), `model-router:runner` (runs commands, no edits) and `model-router:fixer` (fixes failures).
- Per-spawn routing: Haiku 4.5 sorts each subagent task into `simple`, `standard`, `hard` or `long`, which run on Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.1.
- Guard rails: `runner` is capped at Sonnet; `architect` and `fixer` never go below Sonnet; `long` (Fable) only for background agents, so foreground tasks top out at Opus. A failed or empty classifier reply falls back to the role default. Forks and workflow agents are left alone.
- `/router` bill pane: each agent's tier, model, cost, and what the same tokens would have cost unrouted, with the main conversation, unrouted agents and classifier calls included in the total. A status line shows the running total; `/router reset` clears it.
- Settings: **Compare against** (`unrouted`, `fable`, `opus`, `sonnet`), **Route every subagent**, **Keep a model Claude asked for**.
- Pricing from the October 2026 API list prices, including Haiku 5.5's higher rate above a 100K-token prompt.

[Unreleased]: https://github.com/aott33/model-router/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/aott33/model-router/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/aott33/model-router/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/aott33/model-router/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/aott33/model-router/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/aott33/model-router/releases/tag/v0.2.0
