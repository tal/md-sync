# Optional ntfy delivery in the live GitHub check

`bun run test:live --ntfy` prepares a random ntfy.sh topic, a GitHub repository secret and the existing notification workflow in the disposable repo. The workflow discards the publish response because its JSON includes the secret topic name. Instance configs hold the topic outside the synced folders; command arguments and runner output do not include it.

Notification-mode checkouts catch up hourly instead of every ten seconds. Each writer's push must produce matching SHA events and successful importing pulls with the `ntfy` reason in both peers, plus a successful GitHub Actions notification run. Startup and reconnect catch-up cannot pass as notification delivery. Each wait allows five minutes for hosted runners. The content-history check explicitly permits only the notification workflow in addition to synthetic content.

Added offline checks for mode parsing and rejection of fallback, reconnect, wrong-SHA, failed and no-op sync evidence. The live test was not rerun for this change.
