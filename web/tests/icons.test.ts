import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Box } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { iconFor } from '../src/lib/node-types';

const NODES = join(import.meta.dirname, '..', '..', 'server', 'src', 'nodes');

function nodeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? nodeFiles(join(dir, e.name)) : e.name.endsWith('.node.ts') ? [join(dir, e.name)] : [],
  );
}

describe('node icons', () => {
  it('every node file uses an icon that exists in lucide (no generic fallback box)', () => {
    const files = nodeFiles(NODES);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const icon = /icon: '([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1];
      expect(icon, file).toBeDefined();
      expect(iconFor(icon), `${file}: ${icon}`).not.toBe(Box);
    }
  });
});
