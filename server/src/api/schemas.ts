import { z } from 'zod';

const NodeSchema = z.looseObject({
  id: z.string().min(1).default(() => crypto.randomUUID()),
  name: z.string().trim().min(1, 'Every node needs a name').max(128),
  type: z.string().min(1),
  typeVersion: z.number().default(1),
  position: z.tuple([z.number(), z.number()]).default([0, 0]),
  parameters: z.record(z.string(), z.unknown()).default({}),
  disabled: z.boolean().optional(),
  notes: z.string().max(10_000).optional(),
  retryOnFail: z.boolean().optional(),
  maxTries: z.number().int().min(1).max(5).optional(),
  waitBetweenTries: z.number().int().min(0).max(5000).optional(),
  onError: z.enum(['stopWorkflow', 'continueRegularOutput', 'continueErrorOutput']).optional(),
  alwaysOutputData: z.boolean().optional(),
  executeOnce: z.boolean().optional(),
});

/** Validates a workflow body (editor saves, dev runs, imports). */
export const WorkflowBodySchema = z
  .looseObject({
    id: z.string().optional(),
    name: z.string().trim().min(1, 'The workflow needs a name').max(128).default('My workflow'),
    nodes: z.array(NodeSchema).default([]),
    connections: z.record(z.string(), z.unknown()).default({}),
    settings: z.record(z.string(), z.unknown()).default({}),
    pinData: z.record(z.string(), z.array(z.unknown())).default({}),
  })
  .superRefine((wf, ctx) => {
    const seen = new Set<string>();
    wf.nodes.forEach((node, i) => {
      if (seen.has(node.name)) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'name'], message: `Two nodes are named "${node.name}"` });
      seen.add(node.name);
    });
  });
