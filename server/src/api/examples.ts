import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import type { WorkflowNode } from '@flowforge/shared';
import type { AppServices } from '../app.js';
import { notFound } from '../http/errors.js';
import { ROOT_DIR } from '../paths.js';
import { importWorkflowBundle } from '../templates/index.js';

export const EXAMPLES_DIR = join(ROOT_DIR, 'examples');

export interface ExampleInfo {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
}

interface ExampleFile {
  name?: string;
  nodes?: WorkflowNode[];
  workflows?: Array<{ nodes?: WorkflowNode[] }>;
  meta?: { description?: string };
}

function readExample(dir: string, id: string): ExampleFile | undefined {
  if (!/^[\w-]+$/.test(id)) return undefined;
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as ExampleFile;
}

/** /api/examples — ready-made workflows from the repo's `examples/` folder, imported in one click. */
export function examplesRouter(s: AppServices, dir = EXAMPLES_DIR): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const list: ExampleInfo[] = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .flatMap((f) => {
            const id = f.slice(0, -5);
            try {
              const wf = readExample(dir, id);
              if (!wf) return [];
              return [{ id, name: wf.name ?? id, description: wf.meta?.description ?? '', nodeCount: (wf.workflows ? wf.workflows.flatMap((w) => w.nodes ?? []) : wf.nodes ?? []).filter((n) => n.type !== 'flowforge.stickyNote').length }];
            } catch {
              return [];
            }
          })
      : [];
    res.json(list);
  });

  router.post('/:id/import', (req, res) => {
    const example = readExample(dir, req.params.id);
    if (!example) throw notFound('Example not found');
    const [main, ...related] = importWorkflowBundle(s, example);
    // The main workflow, plus the other workflows of a multi-workflow example (error handler, sub-workflow…).
    res.status(201).json(related.length ? { ...main, related: related.map((r) => ({ id: r.id, name: r.name })) } : main);
  });

  return router;
}
