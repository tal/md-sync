// State file, the two-part conflict journal and the local-only copy list, all written atomically.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { type InstanceInput, type LoadedRepoConfig, type RepoInput, RepoSchema } from './config';
import { errCode, isRecord } from './fsutil';
import { isOid } from './git';
import type { StatePaths } from './paths';
import type { OverriddenDelete, RunResult, StuckRecord } from './types';

export type LastRun = Omit<RunResult, 'runId'> & { runId: number; finishedAt: string };
export type KeptStash = { sha: string; reason: 'write-raced' | 'data-guard-stop' | 'failed'; at: string };
// The daemon's ntfy subscription, for `status` and other apps that read this file. Never holds the URL: the topic is a
// secret, and lastError is redacted like a log line.
export type NtfyHealth = {
  state: 'connected' | 'disconnected';
  since: string;                     // when it entered `state`
  lastConnectedAt?: string;          // last successful subscribe
  lastDisconnectedAt?: string;       // last time a live stream dropped
  lastError?: string;                // last failure (a dropped stream or a failed attempt)
  lastMessageAt?: string;            // last bytes on the stream, keepalives included: stream liveness
  lastEventAt?: string;              // last push-notification SHA
  lastEventSha?: string;
  reconnects: number;                // since the daemon started
};
export type StateFile = {
  version: 1; dir: string; pid: number; updatedAt: string;
  instance?: { configPath: string | 'none'; cli: InstanceInput };   // written by `run` and `install-service`
  lastRun?: LastRun; lastOkAt?: string; consecutiveFailures: number; nextRetryAt?: string;
  keptStashes: KeptStash[];          // pruned of shas no longer in refs/stash on every write (by the caller)
  stuck?: StuckRecord;               // informational; the daemon's in-memory copy is authoritative
  repoConfig?: { blob: string | 'none'; layer: RepoInput };   // last known rules; 'none' with {} records removal
                                     //   so invalid config keeps the same layer across restarts and one-off runs
  integrated?: string;               // the last RunResult.integrated: the origin/B commit HEAD contained
  ntfy?: NtfyHealth;                 // only while ntfyUrl is set; each daemon start begins a fresh record
};

export function rememberRepoConfig(state: StateFile, repo: LoadedRepoConfig): void {
  if (repo.state === 'valid' || repo.state === 'absent') state.repoConfig = { blob: repo.blob, layer: repo.layer };
}

export type RebaseJournal = { op: 'rebase-conflict'; phase: 'aborting' | 'planned' | 'stashed' | 'reset' | 'committed';
  local: string; remote: string;
  target: string | 'none';          // C: the verified replay commit (or R when nothing to commit); 'none' while aborting
  stash: string | 'none';           // S from `stash create`, recorded BEFORE `stash store`
  copies: string[]; overridden: OverriddenDelete[]; startedAt: string };
export type StashJournal = { op: 'stash-replay'; phase: 'planned' | 'reset' | 'written';
  stash: string; head: string;
  target: string;                   // copies commit (parent = head), or head when no copy is committed
  workTree: string;                 // tree whose `writes` paths are written to the worktree
  writes: string[]; deletes: string[]; copies: string[]; overridden: OverriddenDelete[]; startedAt: string };
// The worktree move's own part. Written before the first temp exists; P4 resumes it forward.
export type MoveReason = 'pull' | 'conflict-replay' | 'unborn' | 'branch-fix' | 'op-quit' | 'clone-completion'   // moveWorktree
  | 'stash-replay' | 'unmerged-recovery' | 'rescue-restore';                                           // applyOps with a caller's plan
export type RefStep =
  | { kind: 'update'; ref: string; old: string | 'zero';    // update-ref -m "mdsync: <reason>" <ref> <final> <old|zero oid>;
      head: 'as-is' | 'attach' }                            //   ref 'HEAD' (a detached HEAD) adds --no-deref;
                                                            //   'attach': then symbolic-ref HEAD <ref> (P2, P6)
  | { kind: 'none' };                                       // final must equal HEAD (no copies commit): P2 merge/am
export type MoveTemp = { name: string;          // repo-relative: <temp folder>/<n>
  path: string; kind: 'temp' | 'aside';         // C1's temp, or the name C4/C5'/C5c move the old inode to
  expect: string | 'absent' | 'inode';          // sha256 of the bytes the op replaces (C3), or absent for a create
  want: string | 'absent';                      // sha256 of the bytes the op puts at path, or absent for a delete
  copy?: string };                              // a copy that hard-links the replaced inode (the aside's copy)
export type QuitOp = 'rebase' | 'am' | 'merge' | 'cherry-pick' | 'revert';
export type QuitTree = { rev: string; paths: 'all' | string[] };
export type MoveJournal = { op: 'move'; reason: MoveReason;
  phase: 'planned' | 'writing' | 'undoing' | 'index' | 'ref' | 'drop';   // 'drop': stash-replay only (the ref moved; T8–T10
                                                 //   are next); 'undoing': M9 runs (its temps are never a done map)
  from: string | 'empty';
  head: { sha: string | 'unborn'; ref: string | 'detached' };   // M0's HEAD (P2: HEAD when it writes 'planned')
  to: string;                                    // final: the copies commit when there is one
  base: string;                                  // the commit `to` was built on (equals `to` without a copies commit)
  ref: RefStep; index: 'changed-paths' | 'reset';
  temps: MoveTemp[];                             // appended before each round creates them; never rewritten
  written?: number;                              // how many of `temps` (from the start) a completed write pass covers:
                                                 //   a later temp was never switched in (absent: every temp, legacy)
  copies: { path: string; copy: string; blob: string }[];
  stash?: { sha: string; keep: 'keep-stash' | 'drop'; paths: string[] };   // decided before the ref moves
  quit?: { op: QuitOp;                            // P2: written at 'planned', before `<op> --quit`
    trees: QuitTree[]; stages: Record<string, string[]>; autoMerge: string | 'none'; stashBefore: string | 'none' };
  startedAt: string };
// A replaced inode waiting out its grace (an Aside, serialized: ino as a decimal string).
export type SettleEntry = { name: string; path: string; ino: string;
  expect: { kind: 'file' | 'symlink'; size: number; sha256: string } | { kind: 'absent' } | 'inode';
  copy: string | 'none'; since: number };
// rebase, stash: legacy (written by versions before the worktree move), resume only. settle: replaced inodes waiting for their grace; it never
// blocks a run.
export type Journal = { rebase?: RebaseJournal; stash?: StashJournal; move?: MoveJournal; settle?: SettleEntry[] };

const NTFY_OPTIONAL = ['lastConnectedAt', 'lastDisconnectedAt', 'lastError', 'lastMessageAt', 'lastEventAt', 'lastEventSha'] as const;
const KEPT_REASONS: readonly KeptStash['reason'][] = ['write-raced', 'data-guard-stop', 'failed'];
const REBASE_PHASES: readonly RebaseJournal['phase'][] = ['aborting', 'planned', 'stashed', 'reset', 'committed'];
const STASH_PHASES: readonly StashJournal['phase'][] = ['planned', 'reset', 'written'];
const MOVE_PHASES: readonly MoveJournal['phase'][] = ['planned', 'writing', 'undoing', 'index', 'ref', 'drop'];
const MOVE_REASONS: readonly MoveReason[] = ['pull', 'conflict-replay', 'unborn', 'branch-fix', 'op-quit', 'clone-completion',
  'stash-replay', 'unmerged-recovery', 'rescue-restore'];

// ---------------------------------------------------------------------------------------------------------------
// Atomic JSON files

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // not supported everywhere; the rename itself is still atomic
  }
}

// write tmp, fsync, rename over path, fsync the dir. A missing parent dir is created (0700) once.
function writeAtomic(path: string, tmp: string, value: unknown): void {
  const data = JSON.stringify(value, null, 2) + '\n';
  let fd: number;
  try {
    fd = openSync(tmp, 'w', 0o600);
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw e;
    mkdirSync(dirname(tmp), { recursive: true, mode: 0o700 });
    fd = openSync(tmp, 'w', 0o600);
  }
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

function readJsonObject(path: string): Record<string, unknown> | 'none' {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return 'none';
  }
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : 'none';
  } catch {
    return 'none';
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isOverridden = (v: unknown): v is OverriddenDelete[] => Array.isArray(v)
  && v.every((x) => isRecord(x) && isString(x.path) && (x.deletedBy === 'local' || x.deletedBy === 'remote'));

// ---------------------------------------------------------------------------------------------------------------
// State file

function normalizeState(o: Record<string, unknown>): StateFile | 'none' {
  if (o.version !== 1 || !isString(o.dir)) return 'none';
  const s: StateFile = {
    version: 1,
    dir: o.dir,
    pid: typeof o.pid === 'number' && Number.isInteger(o.pid) ? o.pid : 0,
    updatedAt: isString(o.updatedAt) ? o.updatedAt : '',
    consecutiveFailures: typeof o.consecutiveFailures === 'number' && Number.isInteger(o.consecutiveFailures)
      && o.consecutiveFailures >= 0 ? o.consecutiveFailures : 0,
    keptStashes: Array.isArray(o.keptStashes)
      ? o.keptStashes.filter((k): k is KeptStash => isRecord(k) && isString(k.sha) && isString(k.at)
          && (KEPT_REASONS as readonly unknown[]).includes(k.reason))
      : [],
  };
  const inst = o.instance;
  if (isRecord(inst) && isString(inst.configPath) && isRecord(inst.cli)) {
    s.instance = { configPath: inst.configPath, cli: inst.cli as InstanceInput };
  }
  const lr = o.lastRun;
  if (isRecord(lr) && typeof lr.runId === 'number' && isString(lr.outcome) && isString(lr.kind) && isString(lr.finishedAt)) {
    s.lastRun = lr as LastRun;
  }
  if (isString(o.lastOkAt)) s.lastOkAt = o.lastOkAt;
  if (isString(o.nextRetryAt)) s.nextRetryAt = o.nextRetryAt;
  if (isString(o.integrated) && isOid(o.integrated)) s.integrated = o.integrated;
  const rc = o.repoConfig;
  if (isRecord(rc) && isString(rc.blob)) {
    const layer = RepoSchema.safeParse(rc.layer);
    if (layer.success) s.repoConfig = { blob: rc.blob, layer: layer.data as RepoInput };
  }
  const st = o.stuck;
  if (isRecord(st) && isString(st.head) && isString(st.remote) && isString(st.error) && isString(st.since)
    && (st.outcome === 'failed' || st.outcome === 'data-guard-stop')) {
    s.stuck = st as StuckRecord;
  }
  const nt = o.ntfy;
  if (isRecord(nt) && (nt.state === 'connected' || nt.state === 'disconnected') && isString(nt.since)
    && typeof nt.reconnects === 'number' && Number.isInteger(nt.reconnects) && nt.reconnects >= 0
    && NTFY_OPTIONAL.every((k) => nt[k] === undefined || isString(nt[k]))) {
    const h: NtfyHealth = { state: nt.state, since: nt.since, reconnects: nt.reconnects };
    for (const k of NTFY_OPTIONAL) if (isString(nt[k])) h[k] = nt[k];
    s.ntfy = h;
  }
  return s;
}

export function readState(path: string): StateFile | 'none' {
  const o = readJsonObject(path);
  return o === 'none' ? 'none' : normalizeState(o);
}

export function writeState(paths: StatePaths, s: StateFile): void {
  writeAtomic(paths.state, paths.stateTmp, s);
}

// ---------------------------------------------------------------------------------------------------------------
// Journal

function validRebase(v: unknown): v is RebaseJournal {
  return isRecord(v) && v.op === 'rebase-conflict' && (REBASE_PHASES as readonly unknown[]).includes(v.phase)
    && isString(v.local) && isString(v.remote) && isString(v.target) && isString(v.stash)
    && isStringArray(v.copies) && isOverridden(v.overridden) && isString(v.startedAt);
}

function validStash(v: unknown): v is StashJournal {
  return isRecord(v) && v.op === 'stash-replay' && (STASH_PHASES as readonly unknown[]).includes(v.phase)
    && isString(v.stash) && isString(v.head) && isString(v.target) && isString(v.workTree)
    && isStringArray(v.writes) && isStringArray(v.deletes) && isStringArray(v.copies)
    && isOverridden(v.overridden) && isString(v.startedAt);
}

const isRefStep = (v: unknown): v is RefStep => isRecord(v) && (v.kind === 'none'
  || (v.kind === 'update' && isString(v.ref) && isString(v.old) && (v.head === 'as-is' || v.head === 'attach')));
const isMoveTemp = (v: unknown): v is MoveTemp => isRecord(v) && isString(v.name) && isString(v.path)
  && (v.kind === 'temp' || v.kind === 'aside') && isString(v.expect) && isString(v.want) && (v.copy === undefined || isString(v.copy));
const isCopyRec = (v: unknown): v is MoveJournal['copies'][number] => isRecord(v) && isString(v.path) && isString(v.copy)
  && isString(v.blob);

function validMove(v: unknown): v is MoveJournal {
  if (!isRecord(v) || v.op !== 'move' || !(MOVE_REASONS as readonly unknown[]).includes(v.reason)
    || !(MOVE_PHASES as readonly unknown[]).includes(v.phase)) return false;
  const head = v.head;
  if (!isRecord(head) || !isString(head.sha) || !isString(head.ref)) return false;
  if (!isString(v.from) || !isString(v.to) || !isString(v.base) || !isRefStep(v.ref)
    || (v.index !== 'changed-paths' && v.index !== 'reset') || !Array.isArray(v.temps) || !v.temps.every(isMoveTemp)
    || !Array.isArray(v.copies) || !v.copies.every(isCopyRec) || !isString(v.startedAt)) return false;
  if (v.written !== undefined && (typeof v.written !== 'number' || !Number.isInteger(v.written) || v.written < 0)) return false;
  if (v.stash !== undefined) {
    const st = v.stash;
    if (!isRecord(st) || !isString(st.sha) || (st.keep !== 'keep-stash' && st.keep !== 'drop') || !isStringArray(st.paths)) return false;
  }
  if (v.quit !== undefined) {
    const q = v.quit;
    if (!isRecord(q) || !isString(q.op) || !Array.isArray(q.trees) || !isRecord(q.stages) || !isString(q.autoMerge)
      || !isString(q.stashBefore)) return false;
  }
  return true;
}

function validSettle(v: unknown): v is SettleEntry {
  if (!isRecord(v) || !isString(v.name) || !isString(v.path) || !isString(v.ino) || !isString(v.copy)
    || typeof v.since !== 'number') return false;
  const e = v.expect;
  if (e === 'inode') return true;
  return isRecord(e) && (e.kind === 'absent' || ((e.kind === 'file' || e.kind === 'symlink') && typeof e.size === 'number'
    && isString(e.sha256)));
}

function emptyJournal(j: Journal): boolean {
  return j.rebase === undefined && j.stash === undefined && j.move === undefined && (j.settle === undefined || j.settle.length === 0);
}

// Missing, unparsable or every part absent => 'none'. A malformed part counts as absent.
export function readJournal(path: string): Journal | 'none' {
  const o = readJsonObject(path);
  if (o === 'none') return 'none';
  const j: Journal = {};
  if (validRebase(o.rebase)) j.rebase = o.rebase;
  if (validStash(o.stash)) j.stash = o.stash;
  if (validMove(o.move)) j.move = o.move;
  if (Array.isArray(o.settle)) {
    const settle = o.settle.filter(validSettle);
    if (settle.length > 0) j.settle = settle;
  }
  return emptyJournal(j) ? 'none' : j;
}

// Atomic (via <path>.tmp, fsynced, folder fsynced). Writing a journal with no part deletes the file.
export function writeJournal(path: string, j: Journal): void {
  if (j.rebase !== undefined && j.rebase.op !== 'rebase-conflict') throw new Error('journal: rebase part must have op rebase-conflict');
  if (j.stash !== undefined && j.stash.op !== 'stash-replay') throw new Error('journal: stash part must have op stash-replay');
  if (j.move !== undefined && j.move.op !== 'move') throw new Error('journal: move part must have op move');
  if (emptyJournal(j)) {
    rmSync(path, { force: true });
    fsyncDir(dirname(path));
    return;
  }
  const out: Journal = {};
  if (j.rebase !== undefined) out.rebase = j.rebase;
  if (j.stash !== undefined) out.stash = j.stash;
  if (j.move !== undefined) out.move = j.move;
  if (j.settle !== undefined && j.settle.length > 0) out.settle = j.settle;
  writeAtomic(path, `${path}.tmp`, out);
}

// Replaces (or clears) one part and keeps the others. `v` is the whole part, not a patch.
// A part of the wrong shape is a programmer error (throws).
export function updateJournal(path: string, part: 'rebase' | 'stash' | 'move' | 'settle',
  v: RebaseJournal | StashJournal | MoveJournal | SettleEntry[] | 'clear'): void {
  const cur = readJournal(path);
  const next: Journal = cur === 'none' ? {} : { ...cur };
  if (v === 'clear') {
    delete next[part];
  } else if (part === 'settle') {
    if (!Array.isArray(v)) throw new Error('updateJournal: settle part needs a list');
    next.settle = v;
  } else if (Array.isArray(v)) {
    throw new Error(`updateJournal: ${part} part needs an object`);
  } else if (part === 'rebase') {
    if (v.op !== 'rebase-conflict') throw new Error('updateJournal: rebase part needs op rebase-conflict');
    next.rebase = v;
  } else if (part === 'stash') {
    if (v.op !== 'stash-replay') throw new Error('updateJournal: stash part needs op stash-replay');
    next.stash = v;
  } else {
    if (v.op !== 'move') throw new Error('updateJournal: move part needs op move');
    next.move = v;
  }
  writeJournal(path, next);
}

// Read, change and write the journal in one step (one atomic write): `fn` gets a copy of the current parts.
export function mutateJournal(path: string, fn: (j: Journal) => Journal): Journal {
  const cur = readJournal(path);
  const next = fn(cur === 'none' ? {} : { ...cur });
  writeJournal(path, next);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Local-only conflict copies

// Copies made while their original was gitignored or matched `ignore`. Whether a copy may be committed is decided
// when it is made: later the original can become tracked (another device force-adds `.env`), and a check made then
// would push this device's private version under the copy's name.
export function readLocalOnly(path: string): Set<string> {
  const o = readJsonObject(path);
  return new Set(o !== 'none' && isStringArray(o.copies) ? o.copies : []);
}

// Atomic; an empty list deletes the file.
export function writeLocalOnly(path: string, copies: Iterable<string>): void {
  const list = [...new Set(copies)].sort();
  if (list.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeAtomic(path, `${path}.tmp`, { version: 1, copies: list });
}

export function addLocalOnly(path: string, copies: readonly string[]): void {
  if (copies.length === 0) return;
  writeLocalOnly(path, [...readLocalOnly(path), ...copies]);
}
