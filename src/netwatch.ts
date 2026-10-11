// Network-change watcher: reports when the machine joins or rejoins a network, so a failed sync and the ntfy
// subscription retry at once instead of waiting out their backoff.
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { IntervalTimer } from './timers';
import { realClock, type Clock } from './types';

export type NetworkChange = { added: number; removed: number };

// 169.254.0.0/16 and fe80::/10. macOS keeps many utun/awdl/llw interfaces whose only addresses are fe80::, and AirDrop
// and VPN software bring them up and down; a self-assigned 169.254 address means no network at all.
function linkLocal(address: string): boolean {
  const a = address.toLowerCase();
  return a.startsWith('169.254.') || /^fe[89ab][0-9a-f]:/.test(a);
}

export function snapshotOf(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const out = new Set<string>();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if (!a.internal && !linkLocal(a.address)) out.add(`${name}|${a.address}`);
    }
  }
  return [...out].sort();
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// how many of xs are not in ys
function countNotIn(xs: ReadonlySet<string>, ys: ReadonlySet<string>): number {
  let n = 0;
  for (const x of xs) if (!ys.has(x)) n++;
  return n;
}

// Polls: no notifyutil/scutil (macOS), no `ip monitor` or netlink (Linux), no ffi. Containers lack those tools, and
// getifaddrs behind os.networkInterfaces() is cheap (26 µs a call on macOS).
export class NetworkWatcher {
  readonly #onChange: (c: NetworkChange) => void;
  readonly #read: () => string[];
  readonly #timer: IntervalTimer;
  #base: ReadonlySet<string> | 'unknown' = 'unknown';
  #candidate: ReadonlySet<string> | 'none' = 'none';

  constructor(o: { onChange: (c: NetworkChange) => void; clock?: Clock; tickMs?: number /* 5000 */; read?: () => string[] }) {
    this.#onChange = o.onChange;
    this.#read = o.read ?? (() => snapshotOf(networkInterfaces()));
    this.#timer = new IntervalTimer({ ms: o.tickMs ?? 5_000, clock: o.clock ?? realClock, onFire: () => this.#tick() });
  }

  // The first snapshot is the base. If that read throws, the first one that succeeds is.
  start(): void {
    this.#base = this.#snapshot();
    this.#candidate = 'none';
    this.#timer.start();
  }

  stop(): void {
    this.#timer.stop();
  }

  #snapshot(): ReadonlySet<string> | 'unknown' {
    try {
      return new Set(this.#read());
    } catch {
      return 'unknown';   // no change this tick
    }
  }

  // A snapshot must be read on two ticks in a row before it counts, so a flap inside one tick is never seen. Only a
  // change that added an address fires: a removal alone (the network went down) becomes the base silently, so the
  // same address coming back later still fires.
  #tick(): void {
    const s = this.#snapshot();
    if (s === 'unknown') return;
    const base = this.#base;
    if (base === 'unknown') {
      this.#base = s;
      return;
    }
    if (sameSet(s, base)) {
      this.#candidate = 'none';
      return;
    }
    if (this.#candidate === 'none' || !sameSet(s, this.#candidate)) {
      this.#candidate = s;
      return;
    }
    const added = countNotIn(s, base);
    const removed = countNotIn(base, s);
    this.#base = s;
    this.#candidate = 'none';
    if (added > 0) this.#onChange({ added, removed });
  }
}
