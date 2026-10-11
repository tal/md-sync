# Live GitHub sync check

Added an explicit `bun run test:live` runner that creates a private GitHub test repo and three persistent checkouts, with instance config, state and logs outside the synced folders. It exercises writes from all three writers, backup timers, deletion and deterministic divergent commits, then checks convergence against GitHub and content-only history. Daemons stop on exit; the workspace includes instructions for restarting them manually.

The live runner is a standalone Bun script outside the unit root and imports no `bun:test`. Default tests, all offline suites and CI remain network-free. It uses catch-up polling rather than installing a notification workflow, so a passing result does not establish GitHub Actions/ntfy delivery. Keep GitHub CLI's original config location when isolating mdsync's XDG config; otherwise `gh` loses access to the user's existing authentication.
