// Opt-in GitHub smoke check. Keeps three checkouts, config and logs; stops its daemons on exit.
// No bun:test import: default tests, test:all and CI never create a remote repository.
import { closeSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { killChildrenGracefully, spawnTracked } from '../../src/spawn';
import { CONFLICT_COPY_RE } from '../../src/conflict-name';
import { NTFY_SECRET, renderWorkflow, WORKFLOW_NAME, WORKFLOW_PATH } from '../../src/workflow-template';
import { deliveryFromArgs, ntfyDelivered, type LiveLog } from './checks';

const delivery = deliveryFromArgs(process.argv.slice(2));
const ntfyUrl = delivery === 'ntfy' ? `https://ntfy.sh/mdsync-live-${crypto.randomUUID().replaceAll('-', '')}` : undefined;
const source = resolve(import.meta.dir, '../..');
const mdSync = [process.execPath, join(source, 'src/cli.ts')];
const run = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()}-${crypto.randomUUID().slice(0, 6)}`;
const root = join(homedir(), 'mdsync-live', run);
const env = { ...process.env, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'),
  GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'gh'),
  GIT_TERMINAL_PROMPT: '0' };
const names = ['alpha', 'beta', 'gamma'] as const;
type Name = typeof names[number];
const dir = (name: Name): string => join(root, name);
const config = (name: Name): string => join(root, `${name}.json`);
const daemons = new Map<Name, { proc: Bun.Subprocess; fd: number }>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      await stop();
      await killChildrenGracefully(5_000);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })();
  });
}

async function command(args: string[], cwd = root, input?: string): Promise<string> {
  const result = await spawnTracked(args, { cwd, env, timeoutMs: 120_000,
    ...(input === undefined ? {} : { input: new TextEncoder().encode(input) }) });
  if (result.code !== 0 || result.timedOut === 'timed-out') {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`${args[0]} ${args[1]} failed: ${ntfyUrl === undefined ? stderr : stderr.replaceAll(ntfyUrl, '[ntfy topic]')}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}
const git = (name: Name, ...args: string[]): Promise<string> => command(['git', ...args], dir(name));
const cli = (name: Name, verb: string, ...args: string[]): Promise<string> =>
  command([...mdSync, verb, '--config', config(name), ...args]);

async function waitFor(label: string, predicate: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + (delivery === 'ntfy' ? 300_000 : 120_000);
  while (Date.now() < until) {
    for (const [name, { proc }] of daemons) {
      if (proc.exitCode !== null) throw new Error(`${name} daemon exited; inspect ${root}/${name}.log`);
    }
    if (await predicate()) return;
    await Bun.sleep(500);
  }
  throw new Error(`Timed out: ${label}; inspect logs in ${root}`);
}

async function logs(name: Name): Promise<LiveLog[]> {
  return (await Bun.file(join(root, `${name}.log`)).text()).split('\n').flatMap(line => {
    try { return [JSON.parse(line) as LiveLog]; } catch { return []; }
  });
}

async function start(name: Name): Promise<void> {
  const previousLogs = await Bun.file(join(root, `${name}.log`)).exists() ? (await logs(name)).length : 0;
  const fd = openSync(join(root, `${name}.log`), 'a');
  const proc = Bun.spawn([...mdSync, 'run', '--config', config(name)],
    { cwd: root, env, stdin: 'ignore', stdout: fd, stderr: fd });
  daemons.set(name, { proc, fd });
  await waitFor(`${name} startup`, async () => {
    const status = JSON.parse(await cli(name, 'status', '--format', 'json'));
    return status.daemon?.state === 'running';
  });
  if (delivery === 'ntfy') {
    await waitFor(`${name} ntfy connection and initial catch-up`, async () => {
      const fresh = (await logs(name)).slice(previousLogs);
      return fresh.some(line => line.msg === 'ntfy connected') && fresh.some(line =>
        line.msg === 'sync done' && line.outcome === 'ok' && line.reasons?.includes('ntfy-connect'));
    });
  }
}

async function stop(): Promise<void> {
  const entries = [...daemons.values()];
  daemons.clear();
  for (const { proc } of entries) proc.kill('SIGTERM');
  await Promise.all(entries.map(async ({ proc, fd }) => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), 250_000);
    try { await proc.exited; } finally { clearTimeout(timer); closeSync(fd); }
  }));
}

async function content(name: Name, path: string): Promise<string> {
  const file = Bun.file(join(dir(name), path));
  return await file.exists() ? file.text() : '';
}
async function replicated(path: string, expected: string): Promise<void> {
  await waitFor(`${path} replicated`, async () =>
    (await Promise.all(names.map(name => content(name, path)))).every(value => value === expected));
}

mkdirSync(root, { recursive: true });
console.log(`Live workspace: ${root}`);
try {
  const owner = await command(['gh', 'api', 'user', '--jq', '.login']);
  const repo = `${owner}/mdsync-live-${run}`;
  const url = await command(['gh', 'repo', 'create', repo, '--private', '--description', 'Disposable md-sync live sync check']);
  console.log(`GitHub: ${url}`);
  if (ntfyUrl !== undefined) {
    // stdin keeps the topic secret out of argv and command diagnostics.
    await command(['gh', 'secret', 'set', NTFY_SECRET, '--repo', repo], root, ntfyUrl);
  }
  await command(['gh', 'repo', 'clone', repo, dir('alpha')]);
  await git('alpha', 'checkout', '-b', 'main');
  await git('alpha', 'config', 'user.name', 'mdsync-live-seed');
  await git('alpha', 'config', 'user.email', 'mdsync-live@test.invalid');
  await Bun.write(join(dir('alpha'), 'README.md'), '# md-sync live test\n\nSynthetic notes only. Safe to delete when finished testing.\n');
  await Bun.write(join(dir('alpha'), 'shared.md'), 'original\n');
  await git('alpha', 'add', 'README.md', 'shared.md');
  if (delivery === 'ntfy') {
    mkdirSync(join(dir('alpha'), '.github/workflows'), { recursive: true });
    await Bun.write(join(dir('alpha'), WORKFLOW_PATH), renderWorkflow('main'));
    await git('alpha', 'add', WORKFLOW_PATH);
  }
  await git('alpha', 'commit', '-m', 'Seed synthetic notes');
  await git('alpha', 'push', '-u', 'origin', 'main');
  await command(['gh', 'repo', 'edit', repo, '--default-branch', 'main']);
  await Promise.all((['beta', 'gamma'] as const).map(name => command(['gh', 'repo', 'clone', repo, dir(name)])));
  for (const name of names) {
    await Bun.write(config(name), JSON.stringify({ dir: dir(name), branch: 'main',
      fallbackMs: delivery === 'ntfy' ? 3_600_000 : 10_000, ...(ntfyUrl === undefined ? {} : { ntfyUrl }),
      idleMs: 5_000, maxWaitMs: 30_000, authorName: `mdsync-live-${name}`, authorEmail: `${name}@test.invalid` }, null, 2));
  }
  await Bun.write(join(root, 'session.json'), JSON.stringify({ repo, url, root, source, names, delivery }, null, 2));
  const deliveryNotes = delivery === 'ntfy'
    ? 'GitHub Actions posts pushes to ntfy; subscribers catch up hourly. The notification workflow and secret are retained.'
    : 'Remote catch-up every 10 seconds. No ntfy workflow is installed.';
  await Bun.write(join(root, 'README.txt'), `GitHub: ${url}\n\nEach checkout has an external instance config and logs.\nStart one daemon per terminal (replace NAME with alpha, beta or gamma):\nXDG_STATE_HOME='${env.XDG_STATE_HOME}' bun '${source}/src/cli.ts' run --config '${root}/NAME.json'\n\nFlush:\nXDG_STATE_HOME='${env.XDG_STATE_HOME}' bun '${source}/src/cli.ts' flush --config '${root}/NAME.json' --wait\n\nStop with Ctrl-C. Backup commits after 5 seconds idle.\n${deliveryNotes} Daemons from the automated check stop on exit.\n`);
  await Promise.all(names.map(start));
  for (const name of names) {
    const path = `${name}.md`;
    const text = `Written by ${name}\n`;
    await Bun.write(join(dir(name), path), text);
    await cli(name, 'flush', '--wait', '-m', `Live write from ${name}`);
    if (delivery === 'ntfy') {
      const sha = await git(name, 'rev-parse', 'HEAD');
      await Promise.all([
        ...names.filter(other => other !== name).map(receiver =>
          waitFor(`${receiver} ntfy pull for ${sha}`, async () => ntfyDelivered(await logs(receiver), sha))),
        waitFor(`GitHub notification workflow for ${sha}`, async () => {
          const runs: { status: string; conclusion: string; workflowName: string; url: string }[] = JSON.parse(
            await command(['gh', 'run', 'list', '--repo', repo, '--commit', sha,
              '--json', 'status,conclusion,workflowName,url']));
          const notify = runs.find(run => run.workflowName === WORKFLOW_NAME);
          if (notify?.status !== 'completed') return false;
          if (notify.conclusion !== 'success') throw new Error(`Notification workflow ${notify.conclusion}: ${notify.url}`);
          return true;
        }),
      ]);
      console.log(`PASS: ${name} push notified both peers through GitHub Actions and ntfy`);
    }
    await replicated(path, text);
    console.log(`PASS: ${name} write reached all three checkouts`);
  }
  await Bun.write(join(dir('gamma'), 'backup.md'), 'Backup timer write\n');
  await replicated('backup.md', 'Backup timer write\n');
  console.log('PASS: backup timer committed and replicated an unflushed write');
  rmSync(join(dir('alpha'), 'alpha.md'));
  await cli('alpha', 'flush', '--wait', '-m', 'Live deletion');
  await waitFor('deletion replicated', async () =>
    (await Promise.all(names.map(name => Bun.file(join(dir(name), 'alpha.md')).exists()))).every(exists => !exists));
  console.log('PASS: deletion reached all three checkouts');

  // Stop catch-up before making divergent local commits, so the conflict is deterministic.
  await stop();
  for (const name of ['alpha', 'beta'] as const) {
    await Bun.write(join(dir(name), 'shared.md'), `${name} version\n`);
    await git(name, 'add', 'shared.md');
    await git(name, '-c', `user.name=mdsync-live-${name}`, '-c', `user.email=${name}@test.invalid`, 'commit', '-m', `Divergent ${name} edit`);
  }
  await cli('alpha', 'flush', '--wait');
  await cli('beta', 'flush', '--wait');
  await Promise.all(names.map(start));
  await replicated('shared.md', 'alpha version\n');
  await waitFor('conflict copy replicated', async () => {
    for (const name of names) {
      const copies = readdirSync(dir(name)).filter(path => CONFLICT_COPY_RE.test(path));
      if (!(await Promise.all(copies.map(path => content(name, path)))).includes('beta version\n')) return false;
    }
    return true;
  });
  console.log('PASS: divergent edits preserved both versions across all three checkouts');
  await stop();
  const heads = await Promise.all(names.map(name => git(name, 'rev-parse', 'HEAD')));
  const remoteHead = (await git('alpha', 'ls-remote', 'origin', 'refs/heads/main')).split(/\s/)[0];
  if (!heads.every(head => head === remoteHead)) throw new Error('Checkout heads differ from GitHub');
  const allowed = (path: string): boolean =>
    ['README.md', 'shared.md', 'alpha.md', 'beta.md', 'gamma.md', 'backup.md'].includes(path)
    || (delivery === 'ntfy' && path === WORKFLOW_PATH) || CONFLICT_COPY_RE.test(path);
  const historyPaths = (await git('alpha', 'log', '--format=', '--name-only', 'HEAD')).split('\n').filter(Boolean);
  if (!historyPaths.every(allowed)) throw new Error('Unexpected non-content path in commit history');
  for (const name of names) {
    if (await git(name, 'status', '--porcelain')) throw new Error(`${name} checkout is dirty`);
  }
  console.log(`PASS: clean checkouts match GitHub ${remoteHead}; history contains only synthetic content${delivery === 'ntfy' ? ' and the notification workflow' : ''}`);
  await Bun.write(join(root, 'result.json'), JSON.stringify({ outcome: 'passed', repo, delivery, head: remoteHead, completedAt: new Date().toISOString() }, null, 2));
  console.log(`Kept repo and checkouts. Restart instructions: ${root}/README.txt`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stop();
}
