// Pure live-runner checks, kept separate so offline tests never import the executable runner.
export type Delivery = 'catch-up' | 'ntfy';
export function deliveryFromArgs(args: string[]): Delivery {
  if (args.length === 0) return 'catch-up';
  if (args.length === 1 && args[0] === '--ntfy') return 'ntfy';
  throw new Error('Usage: bun run test:live [--ntfy]');
}

export type LiveLog = { msg?: string; sha?: string; head?: string; outcome?: string;
  reasons?: string[]; commitsIn?: number };

export function ntfyDelivered(logs: LiveLog[], sha: string): boolean {
  const event = logs.findIndex(line => line.msg === 'ntfy event' && line.sha === sha);
  return event !== -1 && logs.slice(event + 1).some(line => line.msg === 'sync done'
    && line.outcome === 'ok' && line.head === sha && (line.commitsIn ?? 0) > 0
    && line.reasons?.includes('ntfy'));
}
