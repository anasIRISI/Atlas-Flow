import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { ConnectionSpec, NodeTypeInfo, WorkflowNode } from '@flowforge/shared';
import { WorkflowOperationError } from '../engine/errors.js';
import { withDefaults } from '../engine/params.js';
import type { NodeType } from '../engine/types.js';

const NODES_DIR = dirname(fileURLToPath(import.meta.url));
const NODE_FILE = /\.node\.(ts|js)$/;

const ConnectionSpecSchema = z.object({
  type: z.enum(['main', 'ai_languageModel', 'ai_memory', 'ai_tool']),
  displayName: z.string().optional(),
  required: z.boolean().optional(),
  maxConnections: z.number().int().positive().optional(),
});

const PropertySchema: z.ZodType = z.lazy(() =>
  z.object({
    name: z.string().regex(/^[a-zA-Z_][\w]*$/, 'property names must be identifiers'),
    displayName: z.string().min(1),
    type: z.enum([
      'string', 'number', 'boolean', 'options', 'multiOptions', 'json', 'code', 'dateTime', 'color',
      'collection', 'fixedCollection', 'keyValue', 'conditions', 'assignments', 'formFields', 'workflowSelector', 'webhookUrls', 'curlImport', 'notice',
    ]),
    default: z.unknown(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    hint: z.string().optional(),
    placeholder: z.string().optional(),
    options: z
      .array(
        z.union([
          z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean()]), description: z.string().optional() }),
          z.object({ name: z.string(), displayName: z.string(), values: z.array(PropertySchema) }),
          PropertySchema,
        ]),
      )
      .optional(),
    displayOptions: z
      .object({ show: z.record(z.string(), z.array(z.unknown())).optional(), hide: z.record(z.string(), z.array(z.unknown())).optional() })
      .optional(),
    typeOptions: z.record(z.string(), z.unknown()).optional(),
    noDataExpression: z.boolean().optional(),
  }),
);

const DescriptionSchema = z.object({
  type: z.string().regex(/^[a-z][\w-]*\.[a-zA-Z][\w]*$/, 'type must look like "flowforge.myNode"'),
  displayName: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  group: z.enum(['trigger', 'flow', 'transform', 'files', 'network', 'integration', 'ai', 'ai-sub', 'note']),
  version: z.number().int().positive(),
  defaults: z.object({ name: z.string().min(1), color: z.string().optional() }),
  subtitle: z.string().optional(),
  inputs: z.array(ConnectionSpecSchema),
  outputs: z.array(ConnectionSpecSchema),
  dynamicOutputs: z.boolean().optional(),
  credentials: z
    .array(
      z.object({
        type: z.string(),
        required: z.boolean().optional(),
        displayOptions: z
          .object({ show: z.record(z.string(), z.array(z.unknown())).optional(), hide: z.record(z.string(), z.array(z.unknown())).optional() })
          .optional(),
      }),
    )
    .optional(),
  trigger: z.object({ kind: z.enum(['manual', 'webhook', 'schedule', 'poll', 'listener', 'event']) }).optional(),
  keywords: z.array(z.string()).optional(),
  docsUrl: z.string().optional(),
  hidden: z.boolean().optional(),
});

export class NodeRegistry {
  private readonly types = new Map<string, NodeType>();

  /** Validates and adds a node type. Throws a readable error for an invalid node file. */
  register(node: NodeType, source = node?.description?.type ?? 'unknown'): void {
    const parsed = DescriptionSchema.safeParse(node?.description);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new Error(`Invalid node description in ${source}: ${issue.path.join('.')} ${issue.message}`);
    }
    const props = z.array(PropertySchema).safeParse(node.properties);
    if (!props.success) {
      const issue = props.error.issues[0]!;
      throw new Error(`Invalid properties in ${source}: ${issue.path.join('.')} ${issue.message}`);
    }
    if (node.description.dynamicOutputs && typeof node.outputs !== 'function') {
      throw new Error(`Node ${source} declares dynamicOutputs but has no outputs() function`);
    }
    if (this.types.has(node.description.type)) {
      throw new Error(`Duplicate node type "${node.description.type}" (${source})`);
    }
    this.types.set(node.description.type, node);
  }

  get(type: string): NodeType | undefined {
    return this.types.get(type);
  }

  require(type: string): NodeType {
    const node = this.types.get(type);
    if (!node) {
      throw new WorkflowOperationError(`Unknown node type "${type}"`, {
        hint: 'The workflow uses a node that is not installed in this version of FlowForge.',
      });
    }
    return node;
  }

  /** Every node type with its parameter schema (what the editor needs). */
  list(includeHidden = false): NodeTypeInfo[] {
    return [...this.types.values()]
      .filter((t) => includeHidden || !t.description.hidden)
      .map((t) => ({ ...t.description, properties: t.properties }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Main outputs of a node instance, including the extra "error" output when enabled. */
  outputsFor(node: WorkflowNode): ConnectionSpec[] {
    const type = this.require(node.type);
    const outputs = type.outputs ? type.outputs(withDefaults(type.properties, node.parameters ?? {})) : type.description.outputs;
    const main = outputs.filter((o) => o.type === 'main');
    return node.onError === 'continueErrorOutput' && type.description.group !== 'trigger'
      ? [...main, { type: 'main', displayName: 'error' }]
      : main;
  }

  inputsFor(node: WorkflowNode): ConnectionSpec[] {
    return this.require(node.type).description.inputs.filter((i) => i.type === 'main');
  }

  get size(): number {
    return this.types.size;
  }
}

function findNodeFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findNodeFiles(full));
    else if (NODE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(full);
  }
  return files.sort();
}

/** Imports every `*.node.ts|js` file under `nodes/` (one node per file, default export). */
export async function loadNodeRegistry(dir = NODES_DIR): Promise<NodeRegistry> {
  const registry = new NodeRegistry();
  for (const file of findNodeFiles(dir)) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: NodeType };
    if (!mod.default) throw new Error(`Node file ${file} has no default export`);
    registry.register(mod.default, file.slice(dir.length + 1));
  }
  return registry;
}
