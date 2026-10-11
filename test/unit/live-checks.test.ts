// Offline checks for the opt-in live runner's mode and ntfy evidence requirements.
import { expect, test } from 'bun:test';
import { deliveryFromArgs, ntfyDelivered, type LiveLog } from '../live/checks';

test('ntfy requires an explicit flag; unknown arguments refuse to run', () => {
  expect(deliveryFromArgs([])).toBe('catch-up');
  expect(deliveryFromArgs(['--ntfy'])).toBe('ntfy');
  expect(() => deliveryFromArgs(['--typo'])).toThrow('Usage:');
  expect(() => deliveryFromArgs(['--ntfy', 'extra'])).toThrow('Usage:');
});

test('ntfy evidence must pair a matching notification with a successful importing pull', () => {
  const event: LiveLog = { msg: 'ntfy event', sha: 'abc1234' };
  const sync: LiveLog = { msg: 'sync done', head: 'abc1234', outcome: 'ok', commitsIn: 1, reasons: ['ntfy'] };
  expect(ntfyDelivered([event, sync], 'abc1234')).toBe(true);
  expect(ntfyDelivered([sync], 'abc1234')).toBe(false);
  expect(ntfyDelivered([sync, event], 'abc1234')).toBe(false);
  expect(ntfyDelivered([event, sync], 'def5678')).toBe(false);
  for (const reasons of [['fallback'], ['startup'], ['ntfy-connect'], ['ntfy-reconnect']]) {
    expect(ntfyDelivered([event, { ...sync, reasons }], 'abc1234')).toBe(false);
  }
  expect(ntfyDelivered([event, { ...sync, outcome: 'network-error' }], 'abc1234')).toBe(false);
  expect(ntfyDelivered([event, { ...sync, commitsIn: 0 }], 'abc1234')).toBe(false);
  expect(ntfyDelivered([event, { ...sync, head: 'def5678' }], 'abc1234')).toBe(false);
});
