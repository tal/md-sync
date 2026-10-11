// Backoff schedules and an abortable sleep.
import { realClock } from './types';

export const NETWORK_BACKOFF = { baseMs: 30_000, capMs: 600_000 } as const;
export const NTFY_BACKOFF = { baseMs: 1_000, capMs: 300_000 } as const;
export const NON_FF_DELAYS_MS = [500, 1_000, 2_000] as const;           // 3 retries => 4 push attempts

// failures >= 1: base * 2^(failures-1), capped. Fewer than 1 failure counts as the first.
export function expBackoffMs(failures: number, b: { baseMs: number; capMs: number }): number {
  const n = Number.isFinite(failures) && failures >= 1 ? Math.floor(failures) : 1;
  return Math.min(b.capMs, b.baseMs * 2 ** (n - 1));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<'slept' | 'aborted'> {
  if (signal?.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    const onAbort = (): void => {
      realClock.clearTimeout(timer);
      resolve('aborted');
    };
    const timer = realClock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('slept');
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
