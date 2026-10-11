// Short hostname and the two timestamp formats.
import { hostname } from 'node:os';

export function shortHostname(): string {
  return hostname().split('.')[0] || 'localhost';
}

// '2026-10-08T12:34:56Z' (UTC, no ms) — commit messages
export function isoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

// LOCAL time 'YYYY-MM-DD HHmm' — conflict copies
export function conflictStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}
