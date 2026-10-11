// NetworkWatcher: settle, add vs remove, flaps, link-local filtering, failed reads.
import { describe, expect, test } from 'bun:test';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { type NetworkChange, NetworkWatcher, snapshotOf } from '../../src/netwatch';
import type { Clock, TimerHandle } from '../../src/types';

class ManualClock implements Clock {
  t = 1_000_000;
  #seq = 0;
  #timers = new Map<number, { due: number; fn: () => void }>();
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.#seq;
    this.#timers.set(id, { due: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: TimerHandle): void { this.#timers.delete(h as number); }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | undefined;
      for (const e of this.#timers) if (e[1].due <= end && (next === undefined || e[1].due < next[1].due)) next = e;
      if (next === undefined) break;
      this.#timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].due);
      next[1].fn();
    }
    this.t = end;
  }
  pending(): number { return this.#timers.size; }
}

const TICK = 5_000;

// `net` is what the next read returns; 'throw' makes it throw.
function setup(initial: string[] | 'throw') {
  const clock = new ManualClock();
  const changes: NetworkChange[] = [];
  const state: { net: string[] | 'throw'; reads: number } = { net: initial, reads: 0 };
  const w = new NetworkWatcher({ clock, onChange: (c) => changes.push(c), read: () => {
    state.reads++;
    if (state.net === 'throw') throw new Error('getifaddrs failed');
    return state.net;
  } });
  w.start();
  // one tick per entry: set the snapshot, then let the tick read it
  const ticks = (...nets: (string[] | 'throw')[]): void => {
    for (const n of nets) {
      state.net = n;
      clock.advance(TICK);
    }
  };
  return { clock, changes, state, w, ticks };
}

const A = 'en0|192.0.2.10';
const B = 'en0|2001:db8::10';
const C = 'utun4|100.64.0.7';

describe('NetworkWatcher', () => {
  test('defaults to a 5 s tick, and the snapshot at start() is the base', () => {
    const { clock, state, changes } = setup([A]);
    expect(state.reads).toBe(1);
    clock.advance(TICK - 1);
    expect(state.reads).toBe(1);
    clock.advance(1);
    expect(state.reads).toBe(2);
    expect(changes).toEqual([]);
  });

  test('a change fires only once it is stable for one tick, and only once', () => {
    const { changes, ticks } = setup([A]);
    ticks([A, B]);
    expect(changes).toEqual([]);   // seen once: a candidate
    ticks([A, B]);
    expect(changes).toEqual([{ added: 1, removed: 0 }]);
    ticks([A, B], [A, B]);
    expect(changes).toEqual([{ added: 1, removed: 0 }]);
  });

  test('a removal alone never fires; an added address fires with the removals counted', () => {
    const { changes, ticks } = setup([A, B]);
    ticks([A], [A], [A]);
    expect(changes).toEqual([]);
    ticks([C], [C]);   // relative to the new base [A]
    expect(changes).toEqual([{ added: 1, removed: 1 }]);
  });

  test('down, then up with the same address fires (the drop became the base)', () => {
    const { changes, ticks } = setup([A]);
    ticks([], []);
    expect(changes).toEqual([]);
    ticks([A], [A]);
    expect(changes).toEqual([{ added: 1, removed: 0 }]);
  });

  test('a flap inside one tick never fires', () => {
    const { changes, ticks } = setup([A]);
    ticks([], [A], [A]);              // down for one read only
    ticks([A, B], [A], [A]);          // an address that came and went
    ticks([], [A, B], [A], [A]);      // never the same thing twice in a row, then back to the base
    expect(changes).toEqual([]);
  });

  test('a newer candidate replaces the pending one', () => {
    const { changes, ticks } = setup([A]);
    ticks([A, B], [A, C]);
    expect(changes).toEqual([]);
    ticks([A, C]);
    expect(changes).toEqual([{ added: 1, removed: 0 }]);
  });

  test('a read that throws is no change: no crash, and the pending candidate survives it', () => {
    const { changes, ticks } = setup([A]);
    ticks('throw', [A, B], 'throw', [A, B]);
    expect(changes).toEqual([{ added: 1, removed: 0 }]);
    ticks('throw', 'throw', [A, B]);
    expect(changes).toEqual([{ added: 1, removed: 0 }]);
  });

  test('a read that throws at start(): the first one that succeeds is the base, silently', () => {
    const { changes, ticks } = setup('throw');
    ticks('throw', [A], [A], [A]);
    expect(changes).toEqual([]);
    ticks([A, B], [A, B]);
    expect(changes).toEqual([{ added: 1, removed: 0 }]);
  });

  test('stop() cancels the timer; start() again takes a fresh base', () => {
    const { clock, state, changes, w, ticks } = setup([A]);
    ticks([A, B]);
    w.stop();
    expect(clock.pending()).toBe(0);
    const reads = state.reads;
    clock.advance(10 * TICK);
    expect(state.reads).toBe(reads);
    w.start();                        // base [A, B]: the old candidate is gone, nothing fires
    ticks([A, B], [A, B]);
    expect(changes).toEqual([]);
    w.stop();
    expect(clock.pending()).toBe(0);
  });

  test('tickMs is honored', () => {
    const clock = new ManualClock();
    let reads = 0;
    const w = new NetworkWatcher({ clock, tickMs: 200, onChange: () => {}, read: () => { reads++; return []; } });
    w.start();
    clock.advance(1_000);
    expect(reads).toBe(1 + 5);
    w.stop();
  });
});

describe('snapshotOf', () => {
  const ni = (address: string, o: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo => ({
    address, netmask: '255.255.255.0', family: address.includes(':') ? 'IPv6' : 'IPv4', mac: '00:00:00:00:00:00',
    internal: false, cidr: null, ...o,
  } as NetworkInterfaceInfo);

  test('one <iface>|<address> per address that is neither internal nor link-local; sorted, deduped', () => {
    const snap = snapshotOf({
      lo0: [ni('127.0.0.1', { internal: true }), ni('::1', { internal: true }), ni('fe80::1', { internal: true })],
      en0: [ni('192.0.2.10'), ni('fe80::1c2b:3a4d:5e6f:7081'), ni('2001:db8::10'), ni('192.0.2.10')],
      awdl0: [ni('fe80::a1:b2ff:fec3:d4e5')],
      llw0: [ni('FE80::A1:B2FF:FEC3:D4E5')],
      utun0: [ni('fe9f::1'), ni('feaa::1'), ni('febf::1')],     // all inside fe80::/10
      en5: [ni('169.254.17.3')],                                   // self-assigned: no network
      utun4: [ni('100.64.0.7'), ni('fec0::1')],                    // fec0:: is outside fe80::/10
      bridge0: undefined,
    });
    expect(snap).toEqual(['en0|192.0.2.10', 'en0|2001:db8::10', 'utun4|100.64.0.7', 'utun4|fec0::1']);
  });

  test('the real interfaces never yield a loopback or link-local entry', () => {
    for (const e of snapshotOf(networkInterfaces())) {
      const address = e.slice(e.indexOf('|') + 1);
      expect(address === '127.0.0.1' || address === '::1' || /^(169\.254\.|fe[89ab][0-9a-f]:)/i.test(address)).toBe(false);
    }
  });
});
