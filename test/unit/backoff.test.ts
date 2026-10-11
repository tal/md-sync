import { describe, expect, test } from 'bun:test';
import { NETWORK_BACKOFF, NON_FF_DELAYS_MS, NTFY_BACKOFF, expBackoffMs, sleep } from '../../src/backoff';

describe('expBackoffMs', () => {
  test('network: 30 s doubling to a 600 s cap', () => {
    const seq = [1, 2, 3, 4, 5, 6, 7, 50].map((n) => expBackoffMs(n, NETWORK_BACKOFF));
    expect(seq).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  });

  test('ntfy: 1 s doubling to a 300 s cap', () => {
    const seq = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 2000].map((n) => expBackoffMs(n, NTFY_BACKOFF));
    expect(seq).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);
  });

  test('fewer than one failure (or a non-number) counts as the first', () => {
    expect(expBackoffMs(0, NETWORK_BACKOFF)).toBe(30_000);
    expect(expBackoffMs(-3, NETWORK_BACKOFF)).toBe(30_000);
    expect(expBackoffMs(Number.NaN, NETWORK_BACKOFF)).toBe(30_000);
  });

  test('custom schedule', () => {
    expect(expBackoffMs(3, { baseMs: 10, capMs: 1_000 })).toBe(40);
  });
});

describe('constants', () => {
  test('network and ntfy schedules', () => {
    expect(NETWORK_BACKOFF).toEqual({ baseMs: 30_000, capMs: 600_000 });
    expect(NTFY_BACKOFF).toEqual({ baseMs: 1_000, capMs: 300_000 });
  });

  test('non-ff delays: 3 retries => 4 push attempts', () => {
    expect([...NON_FF_DELAYS_MS]).toEqual([500, 1_000, 2_000]);
    expect(NON_FF_DELAYS_MS.length + 1).toBe(4);
  });
});

describe('sleep', () => {
  test('resolves slept after the delay', async () => {
    const t0 = performance.now();
    expect(await sleep(50)).toBe('slept');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
  });

  test('aborted by a signal mid-sleep', async () => {
    const ac = new AbortController();
    const t0 = performance.now();
    const p = sleep(10_000, ac.signal);
    setTimeout(() => ac.abort(), 30);
    expect(await p).toBe('aborted');
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  test('an already-aborted signal returns immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await sleep(10_000, ac.signal)).toBe('aborted');
  });

  test('a signal that never fires does not affect the sleep', async () => {
    const ac = new AbortController();
    expect(await sleep(20, ac.signal)).toBe('slept');
    ac.abort();   // after completion: no effect, no throw
  });
});
