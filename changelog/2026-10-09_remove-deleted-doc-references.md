# Remove references to the deleted SPEC.md and docs/ARCHITECTURE.md

`SPEC.md` and `docs/ARCHITECTURE.md` were deleted on purpose: they had drifted from the code and confused more than they helped. This change removes everything that still depended on or pointed to them. Neither doc was recreated.

## What changed

| Area | Change |
|---|---|
| `AGENTS.md` | Rewritten so the README, the code and the tests are the source of truth. Dropped every SPEC/ARCHITECTURE pointer, `§N` / `§20 Dnn` citation, and the rules "update SPEC.md" and "change ARCHITECTURE.md first". Kept every real constraint and correctness rule, without its citation. The Layout block lost its `docs/` line, and the `test/` lines no longer point to ARCHITECTURE §18/§19. New rule: tests check code against code and never read Markdown. Pre-2026-10-09 changelog entries are marked as history. |
| `README.md` | One line (the "design is in SPEC.md / ARCHITECTURE.md" pointer) now says the README covers what mdsync does and the code and tests cover how. No other pointer existed. |
| `src/`, `test/`, `Dockerfile`, `.github/workflows/`, `test/container-smoke.sh`, fixture READMEs and notes | About 365 citations of `§N`, `ARCHITECTURE §N`, `§20 Dnn` and `SPEC …` dropped or reworded mechanically. Most were parenthetical and were simply removed. Section-header comments got plain titles (`// §7.7` → `// Case-fold precheck`, `// §7.3 STASH REPLAY` → `// STASH REPLAY`). Acceptance test headers `SPEC acceptance N` / `SPEC: "…"` became `Acceptance N: …`. Test names that cited sections were renamed (e.g. `'§1.5 values'` → `'pinned values'`). No behavior changed. |

## The three tests that read the deleted docs

| Test | Before | Now |
|---|---|---|
| `test/unit/log.test.ts` | Compared `LOG_MSGS` to the §15 table in ARCHITECTURE.md | Code-to-code only. Every `LOG_MSGS` entry must be the `msg` of some log call in `src/` (no stale entries). Every `msg` that `src/` emits must be in the set, including the line `liveness.ts` builds by hand from its worker thread, which bypasses the `LogMsg` type. The other behavior tests are unchanged. |
| `test/unit/workflow.test.ts` | Compared `renderWorkflow('main')` byte for byte with the YAML block in SPEC.md | Compares it with an inline golden copy of the workflow, since users commit that file and any change to it needs a manual update in every synced repo. The branch-quoting and escaping tests are unchanged. |
| `test/unit/readme.test.ts` | Checked README claims, plus SPEC.md's Stop-hook block and install text | **Deleted on purpose.** A new rule says no test reads Markdown (README included) unless the user asks for one. This file only checked README text, so no code-to-code part was left to keep. |

## Learned / corrected

- **Only `workflow.test.ts`'s golden check really needed the docs.** The `LOG_MSGS` check was a mirror of doc text, and the code alone can check the same invariant better: both directions now hold against the real log calls, and today all 82 msgs are emitted.
- **The log check found one gap.** `liveness.ts` writes its `event loop stalled` line with `JSON.stringify`, outside the typed logger, so the `LogMsg` type never covered it. The new test does.
- **`readme.test.ts` drifted along with the docs.** Its config-key list was hard-coded and lacked `sshKey`. A rewrite that derived the list from `CONFIG_FLAGS` and parsed every README `mdsync` command with `parseCli` passed. It was dropped anyway under the no-Markdown-in-tests rule.
- **Internal step labels survive in the code.** P1–P6 (preflight), S0–S7 (sync), M1–M9 and W1–W5 (worktree move), R/T numbers (replay) were defined in ARCHITECTURE.md. Comments still use them, but now only the code's own comments define them (for example `preflight.ts` and `sync.ts` headers, and the `// S0` markers). Expanding them was out of scope.
- **The fixture `test/fixtures/config/instance/spec-readme-example/` keeps its folder name.** Only its `note` changed ("from SPEC.md" → "from the README"). Renaming the case would churn the fixture test for no gain.
