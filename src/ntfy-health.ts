// ntfy subscription health for the state file: how each ntfy callback changes the record, and when that is worth a write.
import { errorText } from './log';
import type { NtfyHealth } from './state';

// Bytes arrive with every keepalive (ntfy's default is every 45 s), so a write per chunk would rewrite the state file
// all day for nothing. A message alone writes at most this often; connects, drops and events write at once.
export const NTFY_MESSAGE_WRITE_MS = 60_000;

export type NtfyHealthEvent =
  | { kind: 'connected' }
  | { kind: 'disconnected'; error: string }
  | { kind: 'message' }                    // any chunk read off the stream
  | { kind: 'event'; sha: string };        // a push-notification SHA, echoes of our own pushes included

export function freshNtfyHealth(nowIso: string): NtfyHealth {
  return { state: 'disconnected', since: nowIso, reconnects: 0 };
}

// A failed attempt while already disconnected keeps `since` and lastDisconnectedAt: nothing dropped, only the error is new.
export function nextNtfyHealth(h: NtfyHealth, ev: NtfyHealthEvent, nowIso: string): NtfyHealth {
  switch (ev.kind) {
    case 'connected':
      return { ...h, state: 'connected', since: nowIso, lastConnectedAt: nowIso,
        reconnects: h.lastConnectedAt === undefined ? h.reconnects : h.reconnects + 1 };
    case 'disconnected': {
      const dropped = h.state === 'connected' ? { since: nowIso, lastDisconnectedAt: nowIso } : {};
      return { ...h, state: 'disconnected', ...dropped, lastError: errorText(ev.error) };
    }
    case 'message':
      return { ...h, lastMessageAt: nowIso };
    case 'event':
      return { ...h, lastEventAt: nowIso, lastEventSha: ev.sha };
  }
}

// lastWriteMs: when the state file was last written for any reason (that write carried the record as it was then).
export function ntfyWriteDue(kind: NtfyHealthEvent['kind'], lastWriteMs: number, nowMs: number): 'write' | 'skip' {
  if (kind !== 'message') return 'write';
  return nowMs - lastWriteMs >= NTFY_MESSAGE_WRITE_MS ? 'write' : 'skip';
}
