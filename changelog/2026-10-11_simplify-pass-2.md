# Second simplify pass

Cleanup of everything changed since the 2026-10-09 pass (live runner, `--ntfy`, the `md-sync` rename, zero-config run, flush without a daemon).

## Behavior change

- **The generated notification workflow now discards ntfy's response** (`curl -fsS -o /dev/null -d …`). ntfy echoes the topic in its JSON reply, so every user's Actions log showed their secret topic. Before, only the live runner patched this, with a `.replace` on the rendered YAML. Existing users must re-run `print-workflow` and commit the new file to get the fix. `test/unit/workflow.test.ts` pins the line.
- `src/workflow-template.ts` exports `WORKFLOW_NAME`, `WORKFLOW_PATH` and `NTFY_SECRET` (new API). The live runner imports them instead of hardcoding them.

## src

- `repo-defaults.ts` uses `firstLine` from `fsutil.ts` and `kindAt(.git)` instead of private copies (`bootstrap.ts` and `status.ts` too). It detects `origin` and the checked-out branch in parallel.
- `PROBE_IDENTITY` and `committedBranch` are exported from `repo-defaults.ts` and reused by `print-workflow`. `DirectLayers` moved to `config.ts` (it had 3 copies).
- `paths.ts` gains `stateDirIn(home)`. `otherStatePaths` no longer hand-joins the XDG default or the `mdsync` state dir, and it's now a single expression instead of a mutated Set.
- `flush` only searches other state homes after the main socket reports no daemon. The hook-driven hot path no longer reads unit files and lock owners. It now calls `reportIssues` instead of a copy.
- Removed `export` from `COMMANDS`, `Command`, `Parsed` (cli.ts) and `Refusal`, since nothing imported them.
- CI builds with `bun run build`.

## Tests

- `test/harness.ts` exports `is`, `allowAuthor`, `DEFAULT_AUTHOR` and `writeJson`. These replace 16 copies of `is`, and two fake daemons that only existed to fail so they would register an author.
- `service.test.ts` round-trips through the real `parseCli`. The copied flag table had drifted (it lacked `ssh-key`), so the round trip now covers `sshKey`.
- `integration/cli.test.ts` dropped 13 dead imports and an unused helper, and builds unit names with the `service.ts` functions.
- Independent reads in `expectNoMdsyncArtifacts`, CLI error cases, smoke daemons A/B and the live runner's daemon starts and ntfy waits now run in parallel.

## Corrections

- A reviewer said the harness's `CONFLICT_COPY_RE` re-export had no importer. 11 test files use it, so it stays.

## Skipped (bigger refactors, worth doing on purpose)

- A single flag table driving `OPTIONS`, `CliValues`, the config key map and `OVERRIDE_FLAGS` (there are 4 copies in src).
- A per-command spec table in `cli.ts`, and moving repo-default detection into `resolveTarget`.
- A `COMMAND_NAME` constant. Prose still says "mdsync" as the product name in places like `daemon.ts` and `preflight.ts`.
- One release job for all Linux targets. A `/usr/local/bin/md-sync` symlink in the Dockerfile. Incremental log reads in the live runner.

## Verification

`tsc` is clean. Unit 565, integration 537 and acceptance 128 all pass. Not run: the live GitHub check, and the compiled-binary smoke test (CI only).
