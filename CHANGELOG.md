# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions: [SemVer](https://semver.org).

## [Unreleased]

### Fixed

- The status line says `no agents routed yet` instead of `$N vs $N unrouted (0% saved)` until an agent is routed. Against the unrouted baseline the main conversation alone can never save anything, so the comparison looked like a fault.

## [0.8.0] - 2026-10-14

### Added

- Setting **Open the pane at start**. Off: only `/router` opens it. From a fork by [4leX-42](https://github.com/4leX-42/model-router).

## [0.7.2] - 2026-10-14

### Fixed

- Planning and detailed tasks no longer go to Opus. Hard now means an unknown-cause or racy bug, security, performance or a real design trade-off.
- Writing code that deletes or resets data is no longer flagged risky. Only what the agent itself runs counts.
- A classifier reply that explains itself is read by its last line, so "no risky flag" isn't read as risky.
- Verdicts cached by 0.7.1 or earlier are not reused.

## [0.7.1] - 2026-10-14

### Fixed

- The pane marks an Unrouted cost with `~` when it is a guess: the agent type's own model isn't known yet, so the parent's model stands in. A legend line says so.
- The Last turn line leaves out the agent count when the turn ran no agents.
- The hint line is shorter and wraps instead of being cut off in a narrow pane.

## [0.7.0] - 2026-10-14

### Added

- Rescue: a stuck Haiku or Sonnet agent moves up one model mid-run. Stuck means 3 failed tool calls in a row (not for runners), over 25/60 requests, or over 10/30 minutes. Setting: **Move up a struggling agent**.
- Session budget: one tier cheaper at 80%, cheapest allowed at 100%, with a toast at each. Setting: **Session budget**.
- Classifier cache: a repeated task reuses its verdict, skipping the classifier (about 0.5 s and its cost).

## [0.6.0] - 2026-10-13

### Added

- Press an agent's number in the pane to see why it got its model.
- Rate-limit gauges with reset times.
- Status marks (`◐`/`✓`) and a running clock per agent.
- A receipt for the last turn.
- Claude Code's own session total next to the bill.

### Changed

- Classifier is now Haiku 5.5 at low effort: a seventh of the cost.
- Under rate-limit pressure, builders and fixers stay on Sonnet or higher.

### Fixed

- Main-conversation cache writes are priced at the 1-hour rate. The bill now matches Claude Code's total.
- Band lines no longer stick for agents that ended without a finish event.

## [0.5.0] - 2026-10-12

### Added

- A band above the prompt with one line per running agent.

### Changed

- Fable only when the task asks for long or unattended work. Running in the background no longer counts.
- Router agents are compared against Sonnet; built-ins against the model they were last seen on.
- Redesigned pane: header, aligned table, tiers as words.

### Fixed

- `/clear` no longer leaves a nameless row or a stale status line.
- The status line updates when a subagent finishes.

## [0.4.1] - 2026-10-09

### Fixed

- A subagent's first request now gets its lowered effort.
- Clearer `/router status` and `/router on` replies.

## [0.4.0] - 2026-10-09

### Added

- Risk floor: risky tasks run on Opus or higher. Setting: **Send risky tasks to Opus**.
- Rate limits: one tier cheaper at 80% of a window. Setting: **Route cheaper near rate limits**.

## [0.3.0] - 2026-10-09

### Added

- Effort by tier: easy runs at low, normal at medium at most. Setting: **Lower effort for easy tasks**.
- `/router on|off|haiku|sonnet|opus|status`.
- The engine's classifier as a fallback.

### Changed

- Classifier timeout cut from 8 to 3 seconds.

## [0.2.1] - 2026-10-09

### Fixed

- Agent-team teammates are no longer routed.

## [0.2.0] - 2026-10-09

First release: four agents, per-task routing across Haiku, Sonnet, Opus and Fable, the `/router` pane and three settings.

[Unreleased]: https://github.com/aott33/model-router/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/aott33/model-router/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/aott33/model-router/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/aott33/model-router/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/aott33/model-router/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/aott33/model-router/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/aott33/model-router/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/aott33/model-router/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/aott33/model-router/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/aott33/model-router/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/aott33/model-router/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/aott33/model-router/releases/tag/v0.2.0
