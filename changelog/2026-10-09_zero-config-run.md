# Zero-config `mdsync run`, and no default branch

From the top of a git checkout with an `origin` remote, `mdsync run` (and `sync-once`, `install-service`) works with no flags and no config file, syncing the branch checked out there. In a follow-up decision, the built-in `branch` default `main` was removed entirely.

## What changed

| Key | New default | Source in logs |
| --- | --- | --- |
| `dir` | The current folder, only if it is the top of a git worktree. Otherwise exit 2: `no dir given and <cwd> is not a git repository; pass --dir (no config file at …)`, or `… is inside the git repository <top>, not at its top …` | `default` |
| `remote` | `git remote get-url origin` of `dir`, when `dir` already has its own `.git` and no flag or instance file sets it. No origin: the existing `missing required config key "remote"` | `origin` |
| `branch` | `git symbolic-ref HEAD` of `dir` (an unborn branch counts). **No built-in default any more** | `cli`, `instance`, `repo` or `checkout`, never `default` |

### When there is no branch, exit 2 naming `--branch` (or `"branch"`)

| Case | Message |
| --- | --- |
| Fresh clone (`dir` missing or empty) | `missing required config key "branch" (pass --branch or set "branch" in the config file…)`, from `requireKeys`, next to any missing `dir` or `remote` |
| Detached HEAD | `<dir> has a detached HEAD, so there is no checked-out branch to sync; check out a branch (git -C <dir> switch <branch>) or pass --branch (or set "branch" in the config file)` |
| Interrupted clone (`HEAD -> refs/heads/.invalid`; `symbolic-ref` exits 128) | `HEAD in <dir> does not name a valid branch, as an interrupted clone leaves it (fatal: No such ref: HEAD); pass --branch (or set "branch" in the config file)`. With the branch given, P6 still points HEAD at it and the next fetch completes the clone (acceptance 21) |

### Recoverable mdsync states still resolve without `--branch`

Checked in this order, before refusing a detached HEAD:

1. git's `rebase-merge/head-name` or `rebase-apply/head-name` (a rebase in progress)
2. mdsync's journal `move.ref` with `head: 'attach'` (a move interrupted before it re-attached HEAD)
3. a committed `.config/mdsync.json` `branch`. It is a layer too, so a detached HEAD in a repo whose file names the branch is not refused. Its value goes into the detected layer so the provisional config (no repo layer) has it; the repo layer then supplies the same value.

### Elsewhere

- Precedence: CLI > instance file > repo file > checkout. A committed repo-file `branch` still beats the checked-out branch.
- Read once, before the daemon starts (`ConfigLayers.detected`). SIGHUP keeps the values. Another branch or origin needs a restart, as before.
- `daemon starting` now logs `remote` and `sources: {dir, remote, branch}`. No new `msg`: `LOG_MSGS` is a closed set. The logger redacts `scheme://user:token@` in the remote.
- Types: `ResolvedConfig.branch` is optional. `ReadyConfig` requires it. `requireRunKeys` (was `requireDirAndRemote`) checks `dir`, `remote` and `branch`. `loadEffectiveConfig` throws `no branch to sync …` as a backstop. `bootstrap.ts` takes only `remote`/`branch`, and `cloneInto` fails rather than guess a branch.
- `install-service`:
  - It writes the cwd-derived `--dir` and the origin `--remote` into the unit, since a service starts in `/` or `~`.
  - It skips an origin URL with userinfo, so the token never lands in a plaintext plist or unit file. The daemon reads origin from the pinned folder instead.
  - It never writes the branch. A service with no branch configured and none checked out exits 2, like `run`.
  - With a configured `dir` it pins nothing extra. My first version also pinned the origin there, as a `--remote` CLI override, which would have silently outranked a `remote` added to the config file later.
- The one-off `flush`, `status` and `print-workflow` use the same detection as the daemon:
  - A one-off `flush` refusal is `flush not delivered: …` (exit 1).
  - `status` shows the refusal as the reason the repo part is unavailable.
  - `print-workflow` with no branch from any source exits 2 instead of printing `main`.
- `--help` lines for `--dir`, `--remote` and `--branch` (`required for a new clone`).
- README: Quick start, config example (`"branch": "main"`), Commands, exit codes, config table rows, reload note, service section, and Docker/compose examples (`--branch main`).
- Tests that clone fresh folders now name the branch:
  - The harness's config-file daemons write `branch: 'main'`.
  - `smoke.test.ts` runs `print-workflow --branch main`.
  - `container-smoke.sh` runs `run … --branch main`.

## Learned or corrected along the way

- **The spec docs are gone.** The user deleted `SPEC.md` and `docs/ARCHITECTURE.md` mid-task, on purpose: they were only useful for the initial implementation and drifted. So there is no §20 deviation entry and no SPEC table edit. README is the doc of record. Another agent was removing references to them in parallel (`readme.test.ts` disappeared during this work); `AGENTS.md` was left as is, by instruction.
- **Removing the default was simpler than keeping it.** In the first round, `main` survived for fresh clones and invalid HEADs, which left an asymmetry.
  - A remote with only `master` failed on the first start (cloned with `main`).
  - The clone left HEAD on `master`, so a restart with the same config silently synced `master`.
  - With no default, a fresh clone must name its branch, and that case can't arise.
- **A detached HEAD is a normal mdsync recovery state, not only a user mistake.** A rebase in progress, or an mdsync move cut off before `symbolic-ref`, leaves HEAD detached.
  - Since the checkout is now the only branch source for configs that don't name one, a service could otherwise exit-2 loop after such a crash.
  - Hence the rebase and journal fallbacks.
- **Four places picked the branch on their own** and disagreed with a zero-config daemon on another branch. All now use the same detection:
  - The one-off `flush` would have run P6 with `main` and switched the folder to it.
  - `status` counted `unpushed` against `origin/main`.
  - `print-workflow` printed `branches: [main]`, so ntfy would never fire for the synced branch.
- **Behavior changes for existing configs without `branch`:**
  - A folder checked out on another branch: P6 used to switch it to `main`. Now that branch is synced.
  - A detached HEAD: it used to be re-attached to `main`. Now exit 2, unless a rebase, the journal or the repo file says which branch.
  - An empty folder (new device): it used to clone `main`. Now exit 2 until `branch` is set.
  - The Dockerfile's default `CMD ["run", "--dir", "/data"]` on an empty `/data` now needs `--branch`, or `branch` in `/config/mdsync/config.json`.
- **Overlap with the concurrent `--cwd` work.** Detection uses `CommandEnv.cwd`, so `mdsync sync-once --cwd ~/notes` works zero-config (tested). Edits to the files that effort touched only add to them; nothing from it was reverted.
- **Side effect:** with an existing clone at `/data`, the container no longer needs `--remote`.

## Tests

- `test/unit/repo-defaults.test.ts`:
  - cwd rules: the top of a checkout, a non-repo folder, a subfolder; an explicit dir wins.
  - Only unset keys are read; no origin.
  - Missing, empty or nested folders read nothing (no branch).
  - An unborn branch.
  - An `.invalid` HEAD is refused, then works with a branch given.
  - Detached HEAD: refused, then resolved by a repo-file branch, a rebase head-name, or a journal attach.
  - `hasUserinfo`.
- `test/unit/config.test.ts`: no built-in branch; the `detected` layer's precedence and sources; `requireKeys` for `branch` and `remote`.
- `test/unit/bootstrap.test.ts`: `loadEffectiveConfig` refuses with no branch.
- `test/unit/cli.test.ts`: `print-workflow` exits 2 with no branch, and the repo file outranks the checked-out branch.
- `test/acceptance/21-empty-remote.test.ts`: a fresh clone with no branch exits 2 before cloning; the interrupted clone exits 2, then repairs with `--branch main`.
- `test/acceptance/36-zero-config.test.ts`:
  - A no-flags daemon from a clone's cwd, plus `sync-once --cwd`.
  - A checkout on `notes`: daemon, one-off flush, `status` and `print-workflow` all use `notes`, and `main` is untouched.
  - Detached HEAD: exit 2, then `--branch` fixes it.
  - Non-repo cwd, subfolder and no-origin errors.
  - `install-service --print` pins the dir and origin, but never an origin with a token, which stays redacted in the daemon log.
- A mutation check (branch detection disabled) fails the branch acceptance test.
