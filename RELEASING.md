# Releasing

model-router uses [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`, tagged `vMAJOR.MINOR.PATCH`.

The version lives in one place: `"version"` in `.claude-plugin/plugin.json`. The git tag and the GitHub release must match it.

## Which number to bump

While the version is `0.x`, the mod is still settling, so breaking changes bump MINOR instead of MAJOR.

| Change | Before 1.0 | From 1.0 |
| --- | --- | --- |
| Removed or renamed agent (`model-router:*`), setting, or `/router` subcommand; a changed setting default; a changed ledger state shape that loses old data | MINOR | MAJOR |
| New agent, setting, command, pane column; a new tier or a change to routing rules (caps, floors, role defaults) | MINOR | MINOR |
| Bug fix; price table or model id update in `hooks/lib/pricing.ts`; prompt wording; docs | PATCH | PATCH |

Release 1.0.0 once the four agent names, the three settings and the `/router` command are ones you are willing to keep.

Pre-releases, when you want someone to try a change first: `0.3.0-rc.1`, `0.3.0-rc.2`, then `0.3.0`.

## Steps

1. **Update `CHANGELOG.md`.** Move the entries under `Unreleased` to a new `## [X.Y.Z] - YYYY-MM-DD` section, grouped as Added / Changed / Fixed / Removed.
2. **Bump `version`** in `.claude-plugin/plugin.json`.
3. **Check it.**
   ```
   claude plugin validate .
   claude plugin test .
   ```
   Both must pass.
4. **Merge to `main`** through a PR titled `Release vX.Y.Z`.
5. **Tag the merge commit on `main`.**
   ```
   git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
6. **Publish the GitHub release** from the tag (Releases → Draft a new release → choose the tag), titled `vX.Y.Z`, with that version's `CHANGELOG.md` section as the notes. Tick "Set as a pre-release" for `-rc` versions.

Never move or reuse a tag once it is pushed; ship a new PATCH instead.

## When models or prices change

Anthropic model ids and list prices are hard-coded in `hooks/lib/pricing.ts`. Updating them is a PATCH release, unless the change moves a tier to a different model family, which changes routing and is a MINOR release. Update the README table and the "Costs use API list prices (month year)" line in the same release.
