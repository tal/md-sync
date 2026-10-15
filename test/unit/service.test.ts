import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseCli } from '../../src/cli';
import {
  execArgv,
  installService,
  launchdLabel,
  launchdPlistPath,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceArgv,
  serviceEnv,
  serviceKindFor,
  systemdQuoteArg,
  systemdQuoteEnv,
  systemdUnitName,
  systemdUnitPath,
  uninstallService,
  type ServiceCommandResult,
  type ServiceRunner,
} from '../../src/service';
import { SpawnNotFoundError } from '../../src/spawn';

const HASH = '0123456789abcdef';
const roots: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'mdsync-service-'));
  roots.push(d);
  return d;
}

afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Records every command; `answer` decides each exit code.
function fakeRunner(answer: (argv: string[], n: number) => ServiceCommandResult | Error = () => ok()) {
  const calls: string[][] = [];
  const runner: ServiceRunner = async (argv) => {
    calls.push(argv);
    const r = answer(argv, calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, runner };
}

function ok(): ServiceCommandResult {
  return { code: 0, stdout: '', stderr: '' };
}

function fail(code: number, stderr: string): ServiceCommandResult {
  return { code, stdout: '', stderr };
}

describe('serviceKindFor', () => {
  test('maps platforms', () => {
    expect(serviceKindFor('darwin')).toBe('launchd');
    expect(serviceKindFor('linux')).toBe('systemd');
    expect(serviceKindFor('win32')).toBe('unsupported');
    expect(serviceKindFor('freebsd')).toBe('unsupported');
  });
});

describe('execArgv', () => {
  test('compiled binary: the executable alone', () => {
    expect(execArgv({ main: '/$bunfs/root/md-sync', execPath: '/usr/local/bin/md-sync' })).toEqual(['/usr/local/bin/md-sync']);
  });

  test('source install: bun plus the entry script', () => {
    expect(execArgv({ main: '/home/me/.bun/install/global/node_modules/md-sync/src/cli.ts', execPath: '/home/me/.bun/bin/bun' }))
      .toEqual(['/home/me/.bun/bin/bun', '/home/me/.bun/install/global/node_modules/md-sync/src/cli.ts']);
  });

  test('defaults to this process', () => {
    expect(execArgv()).toEqual([process.execPath, Bun.main]);
  });
});

describe('serviceArgv', () => {
  const exec = ['/opt/bun', '/app/src/cli.ts'];

  test('bare run', () => {
    expect(serviceArgv(exec, 'none', {}, 'unset')).toEqual(['/opt/bun', '/app/src/cli.ts', 'run']);
  });

  test('config path is made absolute', () => {
    expect(serviceArgv(['/m'], 'conf/notes.json', {}, 'unset')).toEqual(['/m', 'run', '--config', resolve('conf/notes.json')]);
  });

  test('every override, in table order, then the log level', () => {
    const argv = serviceArgv(exec, '/c/notes.json', {
      autoCommit: 'off', maxWaitMs: 900_000, authorEmail: 'me@host.local', authorName: 'Me', ignore: ['*.tmp', 'drafts/'],
      fallbackMs: 7_200_000, idleMs: 120_000, ntfyUrl: 'https://ntfy.sh/topic', branch: 'notes',
      dir: '/data/notes', remote: 'git@github.com:me/notes.git',
    }, 'debug');
    expect(argv).toEqual([
      '/opt/bun', '/app/src/cli.ts', 'run', '--config', '/c/notes.json',
      '--remote', 'git@github.com:me/notes.git',
      '--dir', '/data/notes',
      '--branch', 'notes',
      '--ntfy-url', 'https://ntfy.sh/topic',
      '--idle-ms', '120000',
      '--fallback-ms', '7200000',
      '--ignore', '*.tmp', '--ignore', 'drafts/',
      '--author-name', 'Me',
      '--author-email', 'me@host.local',
      '--max-wait-ms', '900000',
      '--auto-commit', 'off',
      '--log-level', 'debug',
    ]);
  });

  test('dir is absolute: ~ expanded, relative resolved against cwd', () => {
    expect(serviceArgv(['/m'], 'none', { dir: '~/notes' }, 'unset')).toEqual(['/m', 'run', '--dir', join(homedir(), 'notes')]);
    expect(serviceArgv(['/m'], 'none', { dir: 'rel/notes' }, 'unset')).toEqual(['/m', 'run', '--dir', resolve('rel/notes')]);
  });

  test('values starting with a dash use --flag=value', () => {
    expect(serviceArgv(['/m'], 'none', { authorName: '-bot-', ignore: ['-x', 'y'] }, 'unset'))
      .toEqual(['/m', 'run', '--ignore=-x', '--ignore', 'y', '--author-name=-bot-']);
  });

  test('round-trips through the CLI parser', () => {
    const argv = serviceArgv(exec, '/c/x.json', {
      remote: 'https://example.com/r.git', dir: '/d', ignore: ['-weird', 'ok/**'], authorName: '--double', idleMs: 1000,
      sshKey: '/k/id_ed25519',
    }, 'warn');
    expect(parseCli(argv.slice(exec.length))).toEqual({ kind: 'command', command: 'run', paths: [], values: {
      config: '/c/x.json', remote: 'https://example.com/r.git', dir: '/d', ignore: ['-weird', 'ok/**'],
      'author-name': '--double', 'idle-ms': '1000', 'ssh-key': '/k/id_ed25519', 'log-level': 'warn',
    } });
  });
});

describe('names and paths', () => {
  test('launchd', () => {
    expect(launchdLabel(HASH)).toBe('dev.mdsync.0123456789abcdef');
    expect(launchdPlistPath(HASH, '/Users/me')).toBe('/Users/me/Library/LaunchAgents/dev.mdsync.0123456789abcdef.plist');
    expect(launchdPlistPath(HASH)).toBe(join(homedir(), 'Library/LaunchAgents/dev.mdsync.0123456789abcdef.plist'));
  });

  test('systemd', () => {
    expect(systemdUnitName(HASH)).toBe('mdsync-0123456789abcdef.service');
    expect(systemdUnitPath(HASH, { XDG_CONFIG_HOME: '/xdg', HOME: '/home/me' }))
      .toBe('/xdg/systemd/user/mdsync-0123456789abcdef.service');
    expect(systemdUnitPath(HASH, { HOME: '/home/me' })).toBe('/home/me/.config/systemd/user/mdsync-0123456789abcdef.service');
    expect(systemdUnitPath(HASH, { XDG_CONFIG_HOME: 'relative', HOME: '/home/me' }))
      .toBe('/home/me/.config/systemd/user/mdsync-0123456789abcdef.service');
  });
});

describe('serviceEnv', () => {
  test('PATH starts with git and bun dirs, then the fallbacks, deduped', () => {
    const bin = join(tmp(), 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), '#!/bin/sh\n');
    chmodSync(join(bin, 'git'), 0o755);
    const env = serviceEnv({ PATH: bin });
    const parts = env.PATH!.split(':');
    expect(parts[0]).toBe(bin);
    expect(parts[1]).toBe(dirname(process.execPath));
    for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) expect(parts).toContain(d);
    expect(new Set(parts).size).toBe(parts.length);
  });

  test('a git already in a fallback dir is listed once', () => {
    const parts = serviceEnv({ PATH: '/usr/bin' }).PATH!.split(':');
    expect(parts.filter((p) => p === '/usr/bin')).toHaveLength(1);
  });

  test('no git on PATH still yields the fallbacks', () => {
    const parts = serviceEnv({ PATH: join(tmp(), 'empty') }).PATH!.split(':');
    expect(parts[0]).toBe(dirname(process.execPath));
    expect(parts).toContain('/usr/bin');
  });

  test('records XDG dirs and the log level if set, and never GIT_TOKEN or anything else', () => {
    const env = serviceEnv({
      PATH: '/usr/bin', HOME: '/home/me', GIT_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'aws_secret',
      XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/state', MDSYNC_LOG_LEVEL: 'debug',
    });
    expect(Object.keys(env).sort()).toEqual(['MDSYNC_LOG_LEVEL', 'PATH', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']);
    expect(env.XDG_CONFIG_HOME).toBe('/cfg');
    expect(env.XDG_STATE_HOME).toBe('/state');
    expect(env.MDSYNC_LOG_LEVEL).toBe('debug');
    expect(JSON.stringify(env)).not.toContain('secret');
  });

  test('unset or empty XDG vars are left out', () => {
    expect(Object.keys(serviceEnv({ PATH: '/usr/bin', XDG_STATE_HOME: '' }))).toEqual(['PATH']);
  });
});

describe('renderLaunchdPlist', () => {
  test('snapshot', () => {
    const text = renderLaunchdPlist({
      label: 'dev.mdsync.0123456789abcdef',
      argv: ['/opt/homebrew/bin/bun', '/Users/me/md-sync/src/cli.ts', 'run', '--config', '/Users/me/.config/mdsync/notes.json'],
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', XDG_STATE_HOME: '/Users/me/state' },
      logPath: '/Users/me/state/mdsync/0123456789abcdef.log',
    });
    expect(text).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>dev.mdsync.0123456789abcdef</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/opt/homebrew/bin/bun</string>
\t\t<string>/Users/me/md-sync/src/cli.ts</string>
\t\t<string>run</string>
\t\t<string>--config</string>
\t\t<string>/Users/me/.config/mdsync/notes.json</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/opt/homebrew/bin:/usr/bin:/bin</string>
\t\t<key>XDG_STATE_HOME</key>
\t\t<string>/Users/me/state</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>ExitTimeOut</key>
\t<integer>300</integer>
\t<key>StandardOutPath</key>
\t<string>/Users/me/state/mdsync/0123456789abcdef.log</string>
\t<key>StandardErrorPath</key>
\t<string>/Users/me/state/mdsync/0123456789abcdef.log</string>
</dict>
</plist>
`);
  });

  test('XML-escapes every string', () => {
    const text = renderLaunchdPlist({ label: 'l', argv: ['a&b', '<x>'], env: { 'K&': 'v<>' }, logPath: '/p&q' });
    expect(text).toContain('<string>a&amp;b</string>');
    expect(text).toContain('<string>&lt;x&gt;</string>');
    expect(text).toContain('<key>K&amp;</key>');
    expect(text).toContain('<string>v&lt;&gt;</string>');
    expect(text).toContain('<string>/p&amp;q</string>');
    expect(text).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });

  test.skipIf(process.platform !== 'darwin')('plutil accepts it and reads back the exact strings', () => {
    const argv = ['/opt/bun', '/tmp/a dir/cli.ts', 'run', '--dir', '/x/<notes> & "quotes" \'single\' $HOME 100% é'];
    const env = { PATH: '/usr/bin:/bin', XDG_STATE_HOME: '/s&t' };
    const file = join(tmp(), 'x.plist');
    writeFileSync(file, renderLaunchdPlist({ label: 'dev.mdsync.test', argv, env, logPath: '/l<og>' }));
    expect(Bun.spawnSync(['plutil', '-lint', file]).exitCode).toBe(0);
    const json = Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', file]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout.toString()) as Record<string, unknown>;
    expect(parsed.ProgramArguments).toEqual(argv);
    expect(parsed.EnvironmentVariables).toEqual(env);
    expect(parsed.StandardOutPath).toBe('/l<og>');
    expect(parsed.KeepAlive).toBe(true);
    expect(parsed.ExitTimeOut).toBe(300);
  });
});

// Reverses systemd's rules for a quoted word, to prove the quoting round-trips.
function systemdUnquote(word: string, mode: 'exec' | 'env'): string {
  expect(word.startsWith('"') && word.endsWith('"')).toBe(true);
  let s = word.slice(1, -1).replace(/%%/g, '%');
  if (mode === 'exec') s = s.replace(/\$\$/g, '$');
  return s.replace(/\\(x[0-9a-f]{2}|.)/g, (_, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e.slice(1), 16)) : e));
}

describe('systemd quoting', () => {
  test('ExecStart words', () => {
    expect(systemdQuoteArg('/usr/bin/bun')).toBe('"/usr/bin/bun"');
    expect(systemdQuoteArg('a b')).toBe('"a b"');
    expect(systemdQuoteArg('back\\slash')).toBe('"back\\\\slash"');
    expect(systemdQuoteArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(systemdQuoteArg('100%')).toBe('"100%%"');
    expect(systemdQuoteArg('$HOME')).toBe('"$$HOME"');
    expect(systemdQuoteArg('a\nb')).toBe('"a\\x0ab"');
  });

  test('Environment= keeps $ but escapes %', () => {
    expect(systemdQuoteEnv('PATH', '/a$b:%c')).toBe('"PATH=/a$b:%%c"');
    expect(systemdQuoteEnv('X', 'q"\\')).toBe('"X=q\\"\\\\"');
  });

  test('round-trips tricky strings', () => {
    for (const s of ['plain', 'sp ace', '"', '\\', '\\"', '%h', '$$', '${X}', 'tab\there', 'é ü', '\\x41', "it's"]) {
      expect(systemdUnquote(systemdQuoteArg(s), 'exec')).toBe(s);
      expect(systemdUnquote(systemdQuoteEnv('K', s), 'env')).toBe(`K=${s}`);
    }
  });
});

describe('renderSystemdUnit', () => {
  test('snapshot', () => {
    const text = renderSystemdUnit({
      realDir: '/home/me/agent-notes',
      argv: ['/home/me/.bun/bin/bun', '/home/me/md-sync/src/cli.ts', 'run', '--config', '/home/me/.config/mdsync/notes.json'],
      env: { PATH: '/usr/bin:/bin', XDG_STATE_HOME: '/home/me/state' },
    });
    expect(text).toBe(`[Unit]
Description=mdsync for /home/me/agent-notes

[Service]
Type=simple
ExecStart="/home/me/.bun/bin/bun" "/home/me/md-sync/src/cli.ts" "run" "--config" "/home/me/.config/mdsync/notes.json"
Restart=always
RestartSec=5
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=300
Environment="PATH=/usr/bin:/bin"
Environment="XDG_STATE_HOME=/home/me/state"

[Install]
WantedBy=default.target
`);
  });

  test('KillMode=mixed, so SIGTERM reaches mdsync and not its in-flight git children', () => {
    expect(renderSystemdUnit({ realDir: '/d', argv: ['/m', 'run'], env: {} })).toMatch(/^KillMode=mixed$/m);
  });

  test('escapes specifiers and variables in every field', () => {
    const text = renderSystemdUnit({ realDir: '/d/100%', argv: ['/m', 'run', '--dir', '/d/$x 100%'], env: { PATH: '/p%$' } });
    expect(text).toContain('Description=mdsync for /d/100%%\n');
    expect(text).toContain('ExecStart="/m" "run" "--dir" "/d/$$x 100%%"\n');
    expect(text).toContain('Environment="PATH=/p%%$"\n');
  });

  test('a control character cannot break out of the Description line', () => {
    const text = renderSystemdUnit({ realDir: '/d/a\nExecStartPre=/bin/evil', argv: ['/m'], env: {} });
    expect(text).not.toMatch(/^ExecStartPre=/m);
  });
});

describe('installService (injected runner)', () => {
  test('launchd: bootout (failure ignored), write the plist, bootstrap', async () => {
    const home = tmp();
    const { calls, runner } = fakeRunner((argv) => (argv[1] === 'bootout' ? fail(113, 'Could not find service') : ok()));
    const r = await installService({ kind: 'launchd', hash: HASH, text: '<plist/>', env: { HOME: home }, runner });
    expect(r).toEqual({ kind: 'ok' });
    const plist = launchdPlistPath(HASH, home);
    expect(readFileSync(plist, 'utf8')).toBe('<plist/>');
    const domain = `gui/${process.getuid!()}`;
    expect(calls).toEqual([
      ['launchctl', 'bootout', `${domain}/dev.mdsync.${HASH}`],
      ['launchctl', 'bootstrap', domain, plist],
    ]);
  });

  test('launchd: a bootstrap that fails while the old job is torn down is retried', async () => {
    const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
    try {
      const { calls, runner } = fakeRunner((argv, n) => (argv[1] === 'bootstrap' && n === 2 ? fail(5, 'Input/output error') : ok()));
      const r = await installService({ kind: 'launchd', hash: HASH, text: 'x', env: { HOME: tmp() }, runner });
      expect(r).toEqual({ kind: 'ok' });
      expect(calls.map((c) => c[1])).toEqual(['bootout', 'bootstrap', 'bootstrap']);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500]);
    } finally {
      sleep.mockRestore();
    }
  });

  test('launchd: a bootstrap that keeps failing reports the command and stderr', async () => {
    const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
    try {
      const { calls, runner } = fakeRunner((argv) => (argv[1] === 'bootstrap' ? fail(5, 'Bootstrap failed: 5: Input/output error\n') : ok()));
      const r = await installService({ kind: 'launchd', hash: HASH, text: 'x', env: { HOME: tmp() }, runner });
      expect(r.kind).toBe('failed');
      if (r.kind === 'failed') {
        expect(r.error).toContain('launchctl bootstrap');
        expect(r.error).toContain('exited 5: Bootstrap failed: 5: Input/output error');
      }
      expect(calls.filter((c) => c[1] === 'bootstrap')).toHaveLength(3);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1_000]);
    } finally {
      sleep.mockRestore();
    }
  });

  test('launchd: launchctl missing', async () => {
    const { runner } = fakeRunner((argv) => new SpawnNotFoundError(argv[0]!));
    const r = await installService({ kind: 'launchd', hash: HASH, text: 'x', env: { HOME: tmp() }, runner });
    expect(r).toEqual({ kind: 'failed', error: 'launchctl not found' });
  });

  test('systemd: write the unit where the user manager looks, daemon-reload, enable, restart', async () => {
    const cfg = tmp();
    const { calls, runner } = fakeRunner((argv) => (argv[2] === 'show-environment'
      ? { code: 0, stdout: `HOME=/home/me\nXDG_CONFIG_HOME=${cfg}\nPATH=/usr/bin\n`, stderr: '' } : ok()));
    const r = await installService({ kind: 'systemd', hash: HASH, text: '[Unit]\n', env: { HOME: tmp(), XDG_CONFIG_HOME: cfg }, runner });
    expect(r).toEqual({ kind: 'ok' });
    expect(readFileSync(join(cfg, 'systemd/user', `mdsync-${HASH}.service`), 'utf8')).toBe('[Unit]\n');
    expect(calls).toEqual([
      ['systemctl', '--user', 'show-environment'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', `mdsync-${HASH}.service`],
      ['systemctl', '--user', 'restart', `mdsync-${HASH}.service`],
    ]);
  });

  test("systemd: an XDG_CONFIG_HOME only the shell has is not where the manager looks: the unit goes to ~/.config", async () => {
    // r3: the unit landed under the shell rc's XDG_CONFIG_HOME, and `enable` failed: "Unit file ... does not exist"
    const home = tmp();
    const shellCfg = tmp();
    const { runner } = fakeRunner((argv) => (argv[2] === 'show-environment' ? { code: 0, stdout: 'HOME=/x\n', stderr: '' } : ok()));
    const env = { HOME: home, XDG_CONFIG_HOME: shellCfg };
    expect(await installService({ kind: 'systemd', hash: HASH, text: '[Unit]\n', env, runner })).toEqual({ kind: 'ok' });
    expect(existsSync(join(home, '.config/systemd/user', `mdsync-${HASH}.service`))).toBe(true);
    expect(existsSync(join(shellCfg, 'systemd/user', `mdsync-${HASH}.service`))).toBe(false);
    // and uninstall finds it there
    expect(await uninstallService({ kind: 'systemd', hash: HASH, env, runner })).toEqual({ kind: 'ok' });
    expect(existsSync(join(home, '.config/systemd/user', `mdsync-${HASH}.service`))).toBe(false);
  });

  test('systemd: stops at the first failing step', async () => {
    const { calls, runner } = fakeRunner((argv) => (argv[2] === 'enable' ? fail(1, 'Failed to connect to bus') : ok()));
    const r = await installService({ kind: 'systemd', hash: HASH, text: 'x', env: { HOME: tmp(), XDG_CONFIG_HOME: tmp() }, runner });
    expect(r).toEqual({ kind: 'failed', error: `systemctl --user enable mdsync-${HASH}.service exited 1: Failed to connect to bus` });
    expect(calls).toHaveLength(3);
  });
});

describe('uninstallService (injected runner)', () => {
  function installedPlist(home: string): string {
    const p = launchdPlistPath(HASH, home);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'x');
    return p;
  }

  test('launchd: bootout, then remove the plist', async () => {
    const home = tmp();
    const plist = installedPlist(home);
    const { calls, runner } = fakeRunner();
    expect(await uninstallService({ kind: 'launchd', hash: HASH, env: { HOME: home }, runner })).toEqual({ kind: 'ok' });
    expect(existsSync(plist)).toBe(false);
    expect(calls).toEqual([['launchctl', 'bootout', `gui/${process.getuid!()}/dev.mdsync.${HASH}`]]);
  });

  test('launchd: not loaded and no plist is not an error', async () => {
    const { calls, runner } = fakeRunner(() => fail(113, 'Could not find service'));
    expect(await uninstallService({ kind: 'launchd', hash: HASH, env: { HOME: tmp() }, runner })).toEqual({ kind: 'ok' });
    expect(calls.map((c) => c[1])).toEqual(['bootout', 'print']);
  });

  test('launchd: a failed bootout of a still-loaded job keeps the plist', async () => {
    const home = tmp();
    const plist = installedPlist(home);
    const { runner } = fakeRunner((argv) => (argv[1] === 'bootout' ? fail(1, 'Operation not permitted') : ok()));
    const r = await uninstallService({ kind: 'launchd', hash: HASH, env: { HOME: home }, runner });
    expect(r.kind).toBe('failed');
    expect(existsSync(plist)).toBe(true);
  });

  test('systemd: disable --now, remove, daemon-reload', async () => {
    const cfg = tmp();
    const unit = systemdUnitPath(HASH, { XDG_CONFIG_HOME: cfg });
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'x');
    const { calls, runner } = fakeRunner();
    expect(await uninstallService({ kind: 'systemd', hash: HASH, env: { HOME: tmp(), XDG_CONFIG_HOME: cfg }, runner })).toEqual({ kind: 'ok' });
    expect(existsSync(unit)).toBe(false);
    expect(calls).toEqual([
      ['systemctl', '--user', 'show-environment'],
      ['systemctl', '--user', 'disable', '--now', `mdsync-${HASH}.service`],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
  });

  test('systemd: a missing unit is not an error', async () => {
    const { calls, runner } = fakeRunner(() => fail(5, 'Unit not loaded'));
    expect(await uninstallService({ kind: 'systemd', hash: HASH, env: { HOME: tmp(), XDG_CONFIG_HOME: tmp() }, runner })).toEqual({ kind: 'ok' });
    expect(calls).toEqual([['systemctl', '--user', 'show-environment'], ['systemctl', '--user', 'stop', `mdsync-${HASH}.service`]]);
  });

  test('systemd: a failed disable keeps the unit file', async () => {
    const cfg = tmp();
    const unit = systemdUnitPath(HASH, { XDG_CONFIG_HOME: cfg });
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'x');
    const { runner } = fakeRunner(() => fail(1, 'Failed to connect to bus'));
    const r = await uninstallService({ kind: 'systemd', hash: HASH, env: { HOME: tmp(), XDG_CONFIG_HOME: cfg }, runner });
    expect(r.kind).toBe('failed');
    expect(existsSync(unit)).toBe(true);
  });
});

test('services preserve the per-repo SSH key override', () => {
  expect(serviceArgv(['/m'], 'none', { sshKey: "/keys/notes' key" }, 'unset'))
    .toEqual(['/m', 'run', '--ssh-key', "/keys/notes' key"]);
});
