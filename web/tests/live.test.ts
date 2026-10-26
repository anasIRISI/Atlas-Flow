import { describe, expect, it } from 'vitest';
import { formatDuration, ParticleBudget, particleCount, timelineSegments, truncatePreview } from '../src/editor/live';

describe('live helpers', () => {
  it('particleCount scales and caps', () => {
    expect(particleCount(0)).toBe(0);
    expect(particleCount(1)).toBe(1);
    expect(particleCount(5)).toBe(5);
    expect(particleCount(500)).toBe(8);
    expect(particleCount(NaN)).toBe(0);
  });
  it('budget is global and releasable', () => {
    const b = new ParticleBudget(10);
    expect(b.acquire(8)).toBe(8);
    expect(b.acquire(8)).toBe(2);
    expect(b.acquire(1)).toBe(0);
    b.release(10);
    expect(b.inUse).toBe(0);
    b.release(5);
    expect(b.inUse).toBe(0);
  });
  it('truncatePreview limits items and bytes', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ json: { i } }));
    const p = truncatePreview(items);
    expect(p.total).toBe(10);
    expect(p.truncated).toBe(true);
    expect(JSON.parse(p.text)).toHaveLength(3);
    const big = truncatePreview([{ json: { s: 'x'.repeat(5000) } }]);
    expect(big.text.length).toBeLessThanOrEqual(2049);
    expect(big.truncated).toBe(true);
    expect(truncatePreview(undefined).text).toBe('[]');
  });
  it('formatDuration', () => {
    expect(formatDuration(0.2)).toBe('<1 ms');
    expect(formatDuration(120)).toBe('120 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(undefined)).toBe('–');
  });
  it('timelineSegments widths sum to 100 and are proportional', () => {
    const log = [10, 30, 60].map((t, i) => ({ node: `n${i}`, runIndex: 0, status: 'success' as const, executionTime: t, itemCounts: [1] }));
    const seg = timelineSegments(log);
    expect(seg.reduce((a, s) => a + s.widthPct, 0)).toBeCloseTo(100);
    expect(seg[2]!.widthPct).toBeGreaterThan(seg[0]!.widthPct);
    expect(timelineSegments([])).toEqual([]);
  });
});
