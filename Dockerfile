# Example image for mdsync. Mount the synced folder at /data and state at /state.
#   docker build -t md-sync .
#   docker run -d --stop-timeout 300 -e GIT_TOKEN -v ~/notes:/data -v notes-state:/state \
#     md-sync run --dir /data --remote https://github.com/you/notes.git
# One state volume per synced folder: never share or reuse one (every instance's folder is /data in here).
# The Bun release in .bun-version; CI passes it with --build-arg, and
# test/unit/scripts.test.ts fails when this default and .bun-version differ.
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini \
 && rm -rf /var/lib/apt/lists/*
# md-sync needs git >= 2.40 (merge-tree --merge-base, --attr-source). Fail the build, not
# the first sync, when the base image's git is older (Debian bookworm ships 2.39).
RUN git version | awk '{ split($3, v, "."); if (v[1] < 2 || (v[1] == 2 && v[2] < 40)) { print "git " $3 " < 2.40"; exit 1 } }'
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
# safe.directory='*': a bind-mounted /data (and a local remote) is usually owned by a host uid that differs from
# the container user, and git refuses every repo it considers "dubiously owned". Process env, not repo config.
ENV XDG_STATE_HOME=/state XDG_CONFIG_HOME=/config \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*
# Run as the image's unprivileged `bun` user (uid 1000), not root, so the files md-sync writes into the bind-mounted
# /data (the clone, pulled files, conflict copies) belong to the host user and stay editable there. /state and
# /config are world-writable with the sticky bit, like /tmp, so another uid (`docker run --user "$(id -u):$(id -g)"`
# for a host user that isn't uid 1000) can still create its own private (0700) state dir. Before VOLUME, or Docker
# discards the change.
RUN mkdir -p /data /state /config && chown bun:bun /data && chmod 1777 /state /config
VOLUME ["/data", "/state"]
USER bun
# Docker's default stop grace period is 10 s; run with --stop-timeout 300 (compose: stop_grace_period: 5m)
# so a SIGTERM shutdown can commit and push.
STOPSIGNAL SIGTERM
# tini as PID 1 reaps orphaned grandchildren (ssh, git-remote-https) and forwards SIGTERM to mdsync.
ENTRYPOINT ["tini", "--", "bun", "/app/src/cli.ts"]
CMD ["run", "--dir", "/data"]
