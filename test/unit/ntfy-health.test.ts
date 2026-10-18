import { describe, expect, test } from 'bun:test';
import { createLogger } from '../../src/log';
import { addNtfySecrets } from '../../src/ntfy';
import { freshNtfyHealth, NTFY_MESSAGE_WRITE_MS, nextNtfyHealth, ntfyWriteDue } from '../../src/ntfy-health';

const T0 = '2026-10-18T10:00:00.000Z';
const T1 = '2026-10-18T10:01:00.000Z';
const T2 = '2026-10-18T10:02:00.000Z';
const T3 = '2026-10-18T10:03:00.000Z';
const SHA = 'fedcba9876543210fedcba9876543210fedcba98';

describe('nextNtfyHealth', () => {
  test('a fresh record is disconnected since the start, with no reconnects', () => {
    expect(freshNtfyHealth(T0)).toEqual({ state: 'disconnected', since: T0, reconnects: 0 });
  });

  test('the first connect is not a reconnect; each later one is', () => {
    const c1 = nextNtfyHealth(freshNtfyHealth(T0), { kind: 'connected' }, T1);
    expect(c1).toEqual({ state: 'connected', since: T1, lastConnectedAt: T1, reconnects: 0 });
    const d = nextNtfyHealth(c1, { kind: 'disconnected', error: 'stream ended' }, T2);
    expect(d).toEqual({ state: 'disconnected', since: T2, lastConnectedAt: T1, lastDisconnectedAt: T2, lastError: 'stream ended',
      reconnects: 0 });
    expect(nextNtfyHealth(d, { kind: 'connected' }, T3)).toMatchObject({ state: 'connected', since: T3, lastConnectedAt: T3,
      lastDisconnectedAt: T2, lastError: 'stream ended', reconnects: 1 });
  });

  test('a failed attempt while disconnected updates only the error', () => {
    const h = nextNtfyHealth(freshNtfyHealth(T0), { kind: 'disconnected', error: 'HTTP 503' }, T1);
    expect(h).toEqual({ state: 'disconnected', since: T0, lastError: 'HTTP 503', reconnects: 0 });
  });

  test('messages and events keep the connection state', () => {
    const c = nextNtfyHealth(freshNtfyHealth(T0), { kind: 'connected' }, T0);
    const m = nextNtfyHealth(c, { kind: 'message' }, T1);
    expect(m).toEqual({ ...c, lastMessageAt: T1 });
    expect(nextNtfyHealth(m, { kind: 'event', sha: SHA }, T2)).toEqual({ ...m, lastEventAt: T2, lastEventSha: SHA });
  });

  test('the stored error is single-line and never holds the topic or the auth token', () => {
    addNtfySecrets(createLogger({ level: 'error', sink: 'stderr', write: () => {} }),
      'https://ntfy.example/health-secret-topic?auth=aGVhbHRoLXRva2Vu');
    const h = nextNtfyHealth(freshNtfyHealth(T0),
      { kind: 'disconnected', error: 'fetch https://ntfy.example/health-secret-topic/sse?auth=aGVhbHRoLXRva2Vu\nfailed' }, T1);
    expect(h.lastError).toBe('fetch https://ntfy.example/***/sse?*** failed');
  });
});

describe('ntfyWriteDue', () => {
  test('connects, drops and events always write; a message alone at most once a minute', () => {
    for (const k of ['connected', 'disconnected', 'event'] as const) expect(ntfyWriteDue(k, 1_000, 1_001)).toBe('write');
    expect(ntfyWriteDue('message', 1_000, 1_000 + NTFY_MESSAGE_WRITE_MS - 1)).toBe('skip');
    expect(ntfyWriteDue('message', 1_000, 1_000 + NTFY_MESSAGE_WRITE_MS)).toBe('write');
    expect(ntfyWriteDue('message', Number.NEGATIVE_INFINITY, 0)).toBe('write');
    expect(NTFY_MESSAGE_WRITE_MS).toBe(60_000);
  });
});
