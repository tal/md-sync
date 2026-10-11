# Faster worktree-move regression tests

The move and recovery helpers waited five real seconds every time they needed settled replacement files. Those cases now age the test journal's settlement timestamps before calling the real settlement code, removing over a minute of fixed waits. The descriptor-write regression still waits through the real grace period and checks that an early settlement leaves the inode alone.

The ARG_MAX regression created and moved 25,000 files to indirectly check that paths did not travel on the command line. It now moves 128 files in a real repository and checks the transport directly: checkout and index updates must receive every path through stdin, and no move git command may put a bulk path in its arguments. This catches even small argv regressions without a large filesystem stress fixture. All worktree and git operations still run normally; production code and timing constants are unchanged.

Poll-watcher tests also performed the macOS readiness handshake and its 1.5-second quiet wait for every fixture. Poll startup already awaits the initial baseline scan. The test helper now starts poll assertions immediately after startup resolves, while retaining the FSEvents handshake. This removes redundant setup time without changing watcher implementation, event observation windows or backend coverage.

The two service-install retry tests used a fake launchctl runner but still slept through the real 500/1000 ms backoff. They now replace Bun.sleep only inside each test, restore it in finally, and assert the requested delay sequence. Retry ordering, success/failure and diagnostics remain covered without two seconds of wall-clock waiting.
