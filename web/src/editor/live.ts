/** Pure helpers for the live run visualization (particles, previews, timeline). */
import type { LogEntry } from './store';

export const MAX_PARTICLES_PER_EDGE = 8;
export const MAX_PARTICLES_GLOBAL = 60;
export const PREVIEW_MAX_ITEMS = 3;
export const PREVIEW_MAX_BYTES = 2048;

/** 1 item -> 1 particle, capped at 8; nothing when no data flowed. */
export function particleCount(items: number): number {
  if (!Number.isFinite(items) || items <= 0) return 0;
  return Math.min(MAX_PARTICLES_PER_EDGE, Math.max(1, Math.floor(items)));
}

/** Global particle budget shared by all edges. */
export class ParticleBudget {
  private used = 0;
  constructor(private readonly max = MAX_PARTICLES_GLOBAL) {}
  /** Reserves up to `want` particles, returns how many were granted. */
  acquire(want: number): number {
    const granted = Math.max(0, Math.min(want, this.max - this.used));
    this.used += granted;
    return granted;
  }
  release(n: number): void {
    this.used = Math.max(0, this.used - n);
  }
  get inUse(): number {
    return this.used;
  }
}
export const particleBudget = new ParticleBudget();

/** Shows at most 3 items and 2 KB of JSON. */
export function truncatePreview(items: unknown[] | undefined, maxItems = PREVIEW_MAX_ITEMS, maxBytes = PREVIEW_MAX_BYTES): { text: string; total: number; truncated: boolean } {
  const list = items ?? [];
  const shown = list.slice(0, maxItems).map((i) => (i && typeof i === 'object' && 'json' in i ? (i as { json: unknown }).json : i));
  let text = '';
  try {
    text = JSON.stringify(shown, null, 2) ?? '';
  } catch {
    text = '[unserializable]';
  }
  let truncated = list.length > maxItems;
  if (text.length > maxBytes) {
    text = `${text.slice(0, maxBytes)}…`;
    truncated = true;
  }
  return { text, total: list.length, truncated };
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '–';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export interface TimelineSegment {
  node: string;
  runIndex: number;
  status: string;
  executionTime: number;
  /** Width in percent of the bar (min 1.5 so tiny runs stay visible). */
  widthPct: number;
}

/** One segment per node run, width proportional to its duration. */
export function timelineSegments(log: LogEntry[], minPct = 1.5): TimelineSegment[] {
  if (!log.length) return [];
  const total = log.reduce((a, l) => a + Math.max(0, l.executionTime || 0), 0);
  const raw = log.map((l) => (total > 0 ? (Math.max(0, l.executionTime || 0) / total) * 100 : 100 / log.length));
  const widths = raw.map((w) => Math.max(minPct, w));
  const sum = widths.reduce((a, b) => a + b, 0);
  return log.map((l, i) => ({ node: l.node, runIndex: l.runIndex, status: l.status, executionTime: l.executionTime, widthPct: (widths[i]! / sum) * 100 }));
}
