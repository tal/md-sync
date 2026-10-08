# md-sync

A standalone Bun/TypeScript daemon (`mdsync`) that keeps a local folder of Markdown files in two-way sync with a git remote. It is event-driven, not poll-driven, and it never lives inside the synced repo.

**Status:** spec only. See [`SPEC.md`](./SPEC.md) for the full design and acceptance checklist, and [`AGENTS.md`](./AGENTS.md) for contributor and agent rules.

## Planned usage

```sh
bun add -g mdsync            # or download the compiled binary from a release
mdsync run --config ~/.config/mdsync/notes.json
mdsync flush --dir ~/agent-notes --message "finished task"
```

Example instance config:

```json
{
  "remote": "git@github.com:tal/agent-notes.git",
  "dir": "~/agent-notes",
  "ntfyUrl": "https://ntfy.sh/<long-random-topic>"
}
```

## README TODOs (required by the spec)

- [ ] Claude Code `Stop` hook example calling `mdsync flush`, noting any agent framework with an end-of-task hook can do the same
- [ ] State plainly that the ntfy topic name is the shared secret, so use a long random string. Mention self-hosting ntfy later by changing only `ntfyUrl`
- [ ] `loginctl enable-linger` for Linux services
- [ ] Container usage (`oven/bun:slim` + `git`, mounted volume, `GIT_TOKEN` or mounted SSH key)
- [ ] Note that repo contents are plaintext on GitHub and in every clone (layer git-crypt if needed)
