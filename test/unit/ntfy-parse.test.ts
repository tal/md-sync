import { describe, expect, test } from 'bun:test';
import { SSE_MAX_LINE, SseParser, parseNtfyEvent, type SseEvent } from '../../src/ntfy';

function events(r: SseEvent[] | 'line-too-long'): SseEvent[] {
  if (r === 'line-too-long') throw new Error('unexpected line-too-long');
  return r;
}

function feed(chunks: string[]): SseEvent[] {
  const p = new SseParser();
  return chunks.flatMap((c) => events(p.push(c)));
}

const SHA = '0123456789abcdef0123456789abcdef01234567';
const msg = (message: unknown, event = 'message'): string => JSON.stringify({ id: 'x1', time: 1, event, topic: 't', message });

describe('SseParser', () => {
  test('a single event; default type is message', () => {
    expect(feed(['data: hello\n\n'])).toEqual([{ event: 'message', data: 'hello' }]);
  });

  test('chunk boundaries anywhere, including mid-line and mid-field-name', () => {
    const text = `event: open\ndata: {"a":1}\n\ndata: ${msg(SHA)}\n\n`;
    const whole = feed([text]);
    expect(whole.length).toBe(2);
    for (let i = 1; i < text.length; i++) expect(feed([text.slice(0, i), text.slice(i)])).toEqual(whole);
    expect(feed([...text])).toEqual(whole);   // one character per chunk
  });

  test('CRLF line endings, including a split between \\r and \\n', () => {
    expect(feed(['event: x\r\ndata: a\r\n\r\n'])).toEqual([{ event: 'x', data: 'a' }]);
    expect(feed(['data: a\r', '\n\r', '\n'])).toEqual([{ event: 'message', data: 'a' }]);
  });

  test('multiple data lines are joined with \\n', () => {
    expect(feed(['data: one\ndata: two\ndata:\ndata: four\n\n'])).toEqual([{ event: 'message', data: 'one\ntwo\n\nfour' }]);
  });

  test('comments are ignored', () => {
    expect(feed([': keepalive\n\n', ':\n', 'data: x\n: inside\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });

  test('field parsing: no space, one space stripped, no colon, unknown fields and retry ignored', () => {
    expect(feed(['data:x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
    expect(feed(['data:  x\n\n'])).toEqual([{ event: 'message', data: ' x' }]);
    expect(feed(['data\n\n'])).toEqual([{ event: 'message', data: '' }]);
    expect(feed(['retry: 10\nfoo: bar\ndata: y\n\n'])).toEqual([{ event: 'message', data: 'y' }]);
  });

  test('id is reported per event; an id containing NUL is ignored', () => {
    expect(feed(['id: 7\ndata: a\n\ndata: b\n\n'])).toEqual([{ event: 'message', data: 'a', id: '7' }, { event: 'message', data: 'b' }]);
    expect(feed(['id: a\0b\ndata: a\n\n'])).toEqual([{ event: 'message', data: 'a' }]);
  });

  test('a block without data is not an event; the event type resets after each block', () => {
    expect(feed(['event: keepalive\n\n', 'data: z\n\n'])).toEqual([{ event: 'message', data: 'z' }]);
  });

  test('an unterminated block is not dispatched', () => {
    expect(feed(['data: partial\n'])).toEqual([]);
  });

  test('a leading BOM is stripped once', () => {
    expect(feed(['﻿', 'data: a\n\n'])).toEqual([{ event: 'message', data: 'a' }]);
    expect(feed(['﻿data: a\n\n'])).toEqual([{ event: 'message', data: 'a' }]);
  });

  test('ntfy open/keepalive/message stream', () => {
    const open = JSON.stringify({ id: 'o', time: 1, event: 'open', topic: 't' });
    const keep = JSON.stringify({ id: 'k', time: 2, event: 'keepalive', topic: 't' });
    const evs = feed([`event: open\ndata: ${open}\n\n`, `event: keepalive\ndata: ${keep}\n\n`, `data: ${msg(SHA)}\n\n`]);
    expect(evs.map((e) => e.event)).toEqual(['open', 'keepalive', 'message']);
    expect(evs.map(parseNtfyEvent)).toEqual([
      { kind: 'ignore', reason: 'not-message' },
      { kind: 'ignore', reason: 'not-message' },
      { kind: 'sha', sha: SHA },
    ]);
  });

  test(`a line longer than SSE_MAX_LINE (${SSE_MAX_LINE}) -> line-too-long`, () => {
    const ok = new SseParser();
    expect(events(ok.push(`data: ${'a'.repeat(SSE_MAX_LINE - 6)}\n\n`))).toEqual([{ event: 'message', data: 'a'.repeat(SSE_MAX_LINE - 6) }]);

    expect(new SseParser().push(`data: ${'a'.repeat(SSE_MAX_LINE)}\n\n`)).toBe('line-too-long');

    // still unterminated: the buffered partial line alone trips the limit
    const p = new SseParser();
    expect(events(p.push(`data: ${'b'.repeat(SSE_MAX_LINE - 10)}`))).toEqual([]);
    expect(p.push('b'.repeat(20))).toBe('line-too-long');
  });

  test('maxLine option', () => {
    const p = new SseParser({ maxLine: 10 });
    expect(events(p.push('data: 1234\n\n'))).toEqual([{ event: 'message', data: '1234' }]);
    expect(p.push('data: 12345\n')).toBe('line-too-long');
    expect(events(new SseParser({ maxLine: 10 }).push('data: 1234\r'))).toEqual([]);   // a trailing \r is not counted
  });
});

describe('parseNtfyEvent', () => {
  const ev = (data: string): SseEvent => ({ event: 'message', data });

  test('a message with a sha', () => {
    expect(parseNtfyEvent(ev(msg(SHA)))).toEqual({ kind: 'sha', sha: SHA });
  });

  test('trims and lower-cases; 7..64 hex digits', () => {
    expect(parseNtfyEvent(ev(msg(`  ${SHA.toUpperCase()}\n`)))).toEqual({ kind: 'sha', sha: SHA });
    expect(parseNtfyEvent(ev(msg('abcdef0')))).toEqual({ kind: 'sha', sha: 'abcdef0' });
    expect(parseNtfyEvent(ev(msg('a'.repeat(64))))).toEqual({ kind: 'sha', sha: 'a'.repeat(64) });
  });

  test('bad JSON', () => {
    expect(parseNtfyEvent(ev('not json'))).toEqual({ kind: 'ignore', reason: 'bad-json' });
    expect(parseNtfyEvent(ev(''))).toEqual({ kind: 'ignore', reason: 'bad-json' });
  });

  test('not a message event', () => {
    expect(parseNtfyEvent(ev(msg(SHA, 'open')))).toEqual({ kind: 'ignore', reason: 'not-message' });
    expect(parseNtfyEvent(ev(msg(SHA, 'keepalive')))).toEqual({ kind: 'ignore', reason: 'not-message' });
    expect(parseNtfyEvent(ev('null'))).toEqual({ kind: 'ignore', reason: 'not-message' });
    expect(parseNtfyEvent(ev('[1,2]'))).toEqual({ kind: 'ignore', reason: 'not-message' });
    expect(parseNtfyEvent(ev(`"${SHA}"`))).toEqual({ kind: 'ignore', reason: 'not-message' });
  });

  test('non-sha messages', () => {
    for (const m of ['hello', 'abc123', 'g'.repeat(40), 'a'.repeat(65), `${SHA} extra`, '', undefined, null]) {
      expect(parseNtfyEvent(ev(msg(m)))).toEqual({ kind: 'ignore', reason: 'not-sha' });
    }
  });
});
