# Changelog

All notable changes to model-router. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org). See `RELEASING.md` for the release process.

## [Unreleased]

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

[Unreleased]: https://github.com/aott33/model-router/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/aott33/model-router/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/aott33/model-router/releases/tag/v0.2.0
