// Acceptance 2: ten files + one flush -> exactly one commit with the flush message.
import { afterEach, expect, test } from 'bun:test';
import type { LogMsg } from '../../src/log';
import {
  cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, setupTestEnv, startDaemon, type LogLine,
} from '../harness';

afterEach(cleanupAll);

const on = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v);

test('ten files and one flush produce exactly one commit with the flush message', async () => {
  const t = await setupTestEnv('02-flush-batch');
  const remote = await createRemote(t);
  const ca = await cloneRemote(t, remote, 'a');
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote, config: { idleMs: 60_000 } });

  const before = await remote.log();
  const names = Array.from({ length: 10 }, (_, i) => `f${i}.md`);
  for (const [i, name] of names.entries()) await ca.write(name, `file ${i}\n`);

  const m = A.mark();
  const r = await A.flush(['-m', 'ten files', '--wait']);
  expect(r.code).toBe(0);
  await A.waitForLog(on('committed', { files: 10, subject: 'ten files', source: 'flush' }), { since: m });

  const after = await remote.log();
  expect(after.length).toBe(before.length + 1);
  const [newest] = after;
  expect(newest?.subject).toBe('ten files');
  expect(newest?.authorName).toBe('mdsync-A');
  expect([...(newest?.files ?? [])].sort()).toEqual(names);
  const listed = (newest?.body ?? '').split('\n').filter((line) => /^A\tf\d\.md$/.test(line));
  expect(listed.sort()).toEqual(names.map((n) => `A\t${n}`));
  expect(after.filter((c) => c.subject.includes('(auto)'))).toEqual([]);
  expect(await ca.head()).toBe(newest?.sha ?? 'none');
  expect(await ca.porcelain()).toEqual([]);

  await expectNoMdsyncArtifacts(t, [ca], remote, (p) => p === 'README.md' || names.includes(p));
}, 120_000);
