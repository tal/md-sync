# Config fixtures

Config files the way real users write them, each with the outcome mdsync gives it today. `test/unit/config-fixtures.test.ts` runs every case: one `test()` per case folder, named `instance/<case>` or `repo/<case>`.

- `instance/<case>/config.json`: an instance file (`--config`, or `$XDG_CONFIG_HOME/mdsync/config.json`), run through `loadInstanceFile()`. A case folder with no `config.json` is a missing file.
- `repo/<case>/mdsync.json`: a committed `<repo>/.config/mdsync.json`, run through `parseRepoConfig()`. It is decoded as UTF-8 with a BOM kept, so `parseRepoConfig` sees the file's exact characters.
- `<case>/expected.json`: the outcome.

Inputs are byte-exact (BOMs, CRLF, UTF-16, curly quotes, zero-byte files). `.gitattributes` marks `test/fixtures/**` as `-text` so checkout never rewrites them. Check new ones with `xxd <file> | head`.

## expected.json

```json
{
  "note": "One sentence on the real-world origin of the case.",
  "gap": "Optional. One sentence on why the current behavior looks wrong or unfriendly.",
  "kind": "ok",
  "value": { "dir": "$HOME/agent-notes" },
  "warnings": []
}
```

| Field | When | Content |
|---|---|---|
| `note` | always | Where such a file comes from in real life. |
| `gap` | optional | The current behavior is pinned, but looks wrong or unfriendly. Not compared. |
| `kind` | always | `ok`, `invalid`, or `missing` (instance only). |
| `value` | `ok` | The parsed layer (a relative `dir` resolved, `~` expanded, `ignore` entries trimmed). |
| `errors` | `invalid` | `formatIssue()` of each issue, in order: the exact text the user sees on stderr. |
| `warnings` | repo, always | `{key, reason}` of each `repo config key ignored` log line, `[]` when none. |

Placeholders in `value`, `errors` and `warnings`:

- `$CASE` is the case folder's realpath.
- `$HOME` is `os.homedir()`.
- `$$` is a literal `$`, needed only in front of `$`, `CASE` or `HOME`: a `dir` of `$HOME/x`, which mdsync does not expand, is written `$CASE/$$HOME/x`, while a `$schema` key stays `$schema`.

## Adding a case

1. Make a folder under `instance/` or `repo/`, named in lowercase-kebab-case after the situation (`windows-notepad-bom-crlf`, `idle-ms-in-seconds`).
2. Put the file in it byte for byte as a user would write it, named `config.json` or `mdsync.json`.
3. Add `expected.json` with only a `note`.
4. Regenerate (below), then read the new `expected.json` against the README's "Configuration" section and `src/config.ts`. If the outcome is the intended one, keep it. If it is not, keep it anyway (the fixtures pin current behavior) and add a `gap`.

The test fails, naming the case, when a folder has no `expected.json`, no `note`, an unknown `kind`, a field that does not belong to its `kind`, or a file other than the input and `expected.json`.

## Regenerating

```sh
MDSYNC_TEST_UPDATE_FIXTURES=1 bun test test/unit/config-fixtures.test.ts
```

This rewrites every `expected.json` from current behavior, keeping `note` and `gap` (2-space JSON, trailing newline). Without the variable the test only compares. Review the diff before committing: a regenerated file records what mdsync does, not what it should do.

JSON syntax errors carry Bun's `JSON.parse` wording (`JSON Parse error: Unexpected EOF`), so a Bun bump can change them. Regenerate and check that only that wording moved.
