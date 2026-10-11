# Per-repo SSH private keys

Added instance-only `sshKey` and `--ssh-key`, including service overrides and idle SIGHUP reload. Paths expand `~` and resolve relative to the config file or CLI working directory. Clone, sync and git child processes use the selected identity without changing repository config or reading key contents. Shared config cannot choose a device identity. SSH uses shell-escaped paths, noninteractive authentication, IdentitiesOnly, and no reused control connection so another repo connection cannot bypass the selected identity.
