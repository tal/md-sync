#!/usr/bin/env bash
# Container smoke test: `md-sync run` as the entrypoint, a flush over the socket via
# `docker exec`, and a SIGTERM shutdown that commits and pushes pending work.
# Usage: bash test/container-smoke.sh <image>
set -euo pipefail

image=${1:?usage: container-smoke.sh <image>}
name="mdsync-smoke-$$"
tmp=$(mktemp -d)
status=fail

# Host-side git: hermetic config, a fixed identity, and safe.directory='*' (the container may run as another uid).
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$tmp/gitconfig"
export GIT_AUTHOR_NAME='Smoke Helper' GIT_AUTHOR_EMAIL='helper@test.invalid'
export GIT_COMMITTER_NAME='Smoke Helper' GIT_COMMITTER_EMAIL='helper@test.invalid'
hgit() { git -c safe.directory='*' -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

log() { echo "container-smoke: $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

cleanup() {
  if [ "$status" != ok ] && docker inspect "$name" >/dev/null 2>&1; then
    log "container logs:"
    docker logs "$name" 2>&1 | tail -n 200 >&2 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  # Should the ownership check below have failed: hand foreign-owned files back so the host can delete them.
  docker run --rm --user 0 -v "$tmp:/t" --entrypoint chown "$image" -R "$(id -u):$(id -g)" /t >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# Never pipe a producer into `grep -q` under pipefail: grep exits at the first match, the producer's next write gets
# SIGPIPE (141), and the pipeline "fails" although the line was there (r3: step 4 failed 499 runs in 500). Capture
# the output first, then match it.
has_line() {   # has_line <fixed|exact> <needle> <text>
  if [ "$1" = exact ]; then grep -qx -- "$2" <<<"$3"; else grep -qF -- "$2" <<<"$3"; fi
}

wait_for_log() {
  local needle=$1 limit=$2 i logs
  for ((i = 0; i < limit; i++)); do
    logs=$(docker logs "$name" 2>&1)
    if has_line fixed "$needle" "$logs"; then return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != true ]; then
      fail "container exited while waiting for $needle"
    fi
    sleep 1
  done
  fail "no $needle in the container logs after ${limit}s"
}

# 1. A bare remote seeded with one commit, plus empty data and state dirs.
mkdir -p "$tmp/data" "$tmp/state"
hgit init -q --bare -b main "$tmp/remote.git"
hgit init -q -b main "$tmp/seed"
printf '# notes\n' >"$tmp/seed/README.md"
hgit -C "$tmp/seed" add README.md
hgit -C "$tmp/seed" commit -q -m seed
hgit -C "$tmp/seed" push -q "$tmp/remote.git" main

# 2. Start the daemon with `run` as the command (the image's entrypoint is tini + md-sync), as the host user, the way
#    the README says to run it when the host uid isn't the image's 1000 (CI runners are 1001).
docker run -d --name "$name" --stop-timeout 120 --user "$(id -u):$(id -g)" \
  -v "$tmp/data:/data" -v "$tmp/remote.git:/remote.git" -v "$tmp/state:/state" \
  "$image" run --dir /data --remote /remote.git --branch main --idle-ms 60000 >/dev/null

# 3. Ready, and the empty data dir was cloned.
wait_for_log '"msg":"daemon ready"' 60
[ -d "$tmp/data/.git" ] || fail "data/ was not cloned"
[ "$(cat "$tmp/data/README.md")" = '# notes' ] || fail "data/README.md does not match the remote"
[ "$(docker exec "$name" id -u)" != 0 ] || fail "the daemon runs as root"
log "daemon ready, data/ cloned"

# 4. A host-side write, flushed through the socket inside the container.
printf 'x\n' >"$tmp/data/x.md"
docker exec "$name" bun /app/src/cli.ts flush --dir /data --wait || fail "flush --wait exited $?"
files=$(hgit -C "$tmp/remote.git" log --name-only --format= main)
has_line exact 'x.md' "$files" || fail "x.md is not on the remote after flush"
log "flush pushed x.md"

# 5. A pending write, then SIGTERM: committed as a backup commit and pushed before a clean exit.
printf 'y\n' >"$tmp/data/y.md"
docker stop "$name" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
[ "$code" = 0 ] || fail "exit code after docker stop is $code, want 0"
logs=$(docker logs "$name" 2>&1)
has_line fixed '"msg":"shutdown complete"' "$logs" || fail "no shutdown complete log"
subject=$(hgit -C "$tmp/remote.git" log -1 --format=%s main -- y.md)
[ -n "$subject" ] || fail "y.md is not on the remote after SIGTERM"
case "$subject" in
  *' (auto)') ;;
  *) fail "the commit with y.md has subject '$subject', want a ' (auto)' suffix" ;;
esac
log "SIGTERM committed and pushed y.md ($subject)"

# 6. Everything the container wrote into the bind-mounted folder belongs to the host user, not root.
foreign=$(find "$tmp/data" "$tmp/state" ! -uid "$(id -u)" -print)
[ -z "$foreign" ] || fail "files not owned by the host user: $(head -n 5 <<<"$foreign")"
log "data/ and state/ are owned by the host user"

# 7. Cleanup happens in the EXIT trap.
status=ok
log "ok"
