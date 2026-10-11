// Out-of-loop liveness guard: a worker thread that SIGKILLs the process when the main event
// loop stops running, so launchd, systemd or Docker restart a daemon that would otherwise look alive forever (a
// native deadlock freezes timers, IPC and the JS signal handlers alike, and only SIGKILL still works).
export const LOOP_STALL_MS = 60_000;
const BEAT_MS = 1_000;
const CHECK_MS = 5_000;

export type LivenessGuard = { stop(): void };

// The worker's whole program. It must not touch the main thread's state or anything native the main thread may be
// stuck in: it reads one shared counter, writes one log line with a plain write(2) and kills the process.
// A tick that comes much later than scheduled means the whole process was suspended (sleep, SIGSTOP): that resets the
// baseline instead of counting as a stall.
const WORKER_SOURCE = `
const { writeSync } = require('node:fs');
self.onmessage = (e) => {
  const { sab, stallMs, checkMs } = e.data;
  const beat = new Int32Array(sab);
  let seen = Atomics.load(beat, 0);
  let changedAt = Date.now();
  let tickAt = changedAt;
  setInterval(() => {
    const now = Date.now();
    const late = now - tickAt > checkMs * 3;
    tickAt = now;
    const cur = Atomics.load(beat, 0);
    if (cur !== seen || late) {
      seen = cur;
      changedAt = now;
      return;
    }
    if (now - changedAt < stallMs) return;
    const line = JSON.stringify({ ts: new Date(now).toISOString(), level: 'error', msg: 'event loop stalled',
      stalledMs: now - changedAt, pid: process.pid });
    try { writeSync(1, line + '\\n'); } catch {}
    process.kill(process.pid, 'SIGKILL');
  }, checkMs);
  self.postMessage({ kind: 'ready' });
};
`;

// onError: the worker failed after it was created (its script threw); the process runs on unguarded.
// onReady: the worker runs and watches (proof that the guard is armed, not just constructed).
export function startLivenessGuard(o: { stallMs?: number; beatMs?: number; checkMs?: number;
  onError?: (e: unknown) => void; onReady?: () => void } = {}): LivenessGuard {
  const sab = new SharedArrayBuffer(4);
  const beat = new Int32Array(sab);
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'application/javascript' }));
  const worker = new Worker(url);
  worker.unref();   // never keeps the process alive
  worker.addEventListener('error', (e) => o.onError?.(e instanceof ErrorEvent ? e.message : e));
  worker.addEventListener('message', (e: MessageEvent) => {
    if ((e.data as { kind?: unknown } | null)?.kind === 'ready') o.onReady?.();
  });
  worker.postMessage({ sab, stallMs: o.stallMs ?? LOOP_STALL_MS, checkMs: o.checkMs ?? CHECK_MS });
  const timer = setInterval(() => Atomics.add(beat, 0, 1), o.beatMs ?? BEAT_MS);
  timer.unref();
  let state: 'running' | 'stopped' = 'running';
  return {
    stop(): void {
      if (state === 'stopped') return;
      state = 'stopped';
      clearInterval(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}
