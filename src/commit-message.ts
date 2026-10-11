// Commit message builders. Pure.
import { isoUtc } from './host';
import type { ChangeEntry, CommitPlan, OverriddenDelete } from './types';

export const MAX_LISTED_FILES = 20;

// At most MAX_LISTED_FILES lines, then `… and N more` (U+2026).
function capped(lines: readonly string[]): string {
  const shown = lines.slice(0, MAX_LISTED_FILES).join('\n');
  const rest = lines.length - MAX_LISTED_FILES;
  return rest > 0 ? `${shown}\n… and ${rest} more` : shown;
}

function section(title: string, lines: readonly string[]): string {
  return lines.length === 0 ? '' : `\n\n${title}\n${capped(lines)}`;
}

function appendToSubject(text: string, suffix: string): string {
  const nl = text.indexOf('\n');
  return nl === -1 ? text + suffix : text.slice(0, nl) + suffix + text.slice(nl);
}

export function buildCommitMessage(i: { plan: CommitPlan; host: string; now: Date; changes: ChangeEntry[] }): string {
  const messages: string[] = [];
  for (const raw of i.plan.messages) {
    const m = raw.trim();
    if (m !== '' && !messages.includes(m)) messages.push(m);
  }
  let text = messages.length === 0 ? `sync ${i.host} ${isoUtc(i.now)}` : messages.join('\n\n');
  if (i.plan.tag === 'auto') text = appendToSubject(text, ' (auto)');
  return text + section('Changed files:', i.changes.map((c) => `${c.status}\t${c.path}`));
}

// `kind` does not change the text: every replay commit is `sync <host> <ISO> (conflict)`.
export function buildConflictMessage(i: { host: string; now: Date; kind: 'rebase' | 'stash' | 'collision';
  copies: string[]; overridden: OverriddenDelete[]; replayedSubjects: string[] }): string {
  const overridden = i.overridden.map((o) => `${o.path} (deleted ${o.deletedBy === 'local' ? 'locally' : 'remotely'})`);
  return `sync ${i.host} ${isoUtc(i.now)} (conflict)`
    + section('Conflict copies:', i.copies)
    + section('Overridden deletes:', overridden)
    + section('Replayed local commits:', i.replayedSubjects);
}

export function subjectOf(message: string): string {
  return message.split('\n', 1)[0]?.replace(/\r$/, '') ?? '';
}
