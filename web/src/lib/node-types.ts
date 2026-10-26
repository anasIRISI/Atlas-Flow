import { useQuery } from '@tanstack/react-query';
import { icons, Box, type LucideIcon } from 'lucide-react';
import type { ConnectionSpec, NodeProperty, NodeTypeInfo, WorkflowNode } from '@flowforge/shared';
import { api } from './api';

export function useNodeTypes() {
  return useQuery({
    queryKey: ['node-types'],
    queryFn: async () => {
      const list = await api<NodeTypeInfo[]>('/node-types');
      return { list, byType: new Map(list.map((t) => [t.type, t])) };
    },
    staleTime: Infinity,
  });
}

/** "lucide:mouse-pointer-click" → the MousePointerClick component (fallback: Box). */
export function iconFor(icon: string | undefined): LucideIcon {
  if (!icon?.startsWith('lucide:')) return Box;
  const name = icon
    .slice(7)
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
  return (icons as Record<string, LucideIcon>)[name] ?? Box;
}

export const isTriggerType = (t: NodeTypeInfo | undefined) => Boolean(t && (t.group === 'trigger' || t.trigger));

function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), source);
}

/** Value of a parameter with the schema default applied (top level and simple nested paths). */
export function paramValue(type: NodeTypeInfo | undefined, node: WorkflowNode, path: string): unknown {
  const stored = readPath(node.parameters, path);
  if (stored !== undefined) return stored;
  const [head, ...rest] = path.split('.');
  const prop = type?.properties.find((p) => p.name === head);
  if (!prop) return undefined;
  if (!rest.length) return prop.default;
  if (prop.type === 'collection' && Array.isArray(prop.options)) {
    const child = (prop.options as NodeProperty[]).find((o) => o.name === rest[0]);
    if (child) return child.default;
  }
  return readPath(prop.default, rest.join('.'));
}

/** Resolves a subtitle template like "mode: {{mode}}" using option labels where possible. */
export function resolveSubtitle(type: NodeTypeInfo | undefined, node: WorkflowNode): string {
  if (!type?.subtitle) return '';
  return type.subtitle
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, name: string) => {
      const value = paramValue(type, node, name);
      if (typeof value === 'string' && value.startsWith('=')) return 'expression';
      const prop = type.properties.find((p) => p.name === name);
      if (prop?.type === 'options' && Array.isArray(prop.options)) {
        const option = (prop.options as Array<{ name: string; value: unknown }>).find((o) => o.value === value);
        if (option) return option.name;
      }
      return value === undefined || value === null ? '' : String(value);
    })
    .trim();
}

/** Static outputs + the error output when "On Error: continue (using error output)". */
export function staticOutputs(type: NodeTypeInfo | undefined, node: WorkflowNode): ConnectionSpec[] {
  const outputs = (type?.outputs ?? []).filter((o) => o.type === 'main');
  return node.onError === 'continueErrorOutput' && type?.group !== 'trigger' ? [...outputs, { type: 'main', displayName: 'error' }] : outputs;
}

/** AI slots of a cluster node (Chat Model, Memory, Tool): sub-nodes attach to them from below. */
export const aiSlots = (type: NodeTypeInfo | undefined): ConnectionSpec[] => (type?.inputs ?? []).filter((i) => i.type !== 'main');

/** For a sub-node: the slot type it plugs into (ai_languageModel, ai_memory or ai_tool). */
export const aiOutput = (type: NodeTypeInfo | undefined): ConnectionSpec['type'] | undefined => type?.outputs.find((o) => o.type !== 'main')?.type;

export const SLOT_LABELS: Record<string, string> = { ai_languageModel: 'Chat Model', ai_memory: 'Memory', ai_tool: 'Tool' };

export async function fetchOutputs(node: WorkflowNode): Promise<ConnectionSpec[]> {
  return api<ConnectionSpec[]>('/node-types/outputs', {
    method: 'POST',
    body: { node: { name: node.name, type: node.type, parameters: node.parameters, onError: node.onError } },
  });
}

export const GROUP_LABELS: Record<string, string> = {
  trigger: 'Triggers',
  flow: 'Flow',
  transform: 'Data transformation',
  files: 'Files & system',
  network: 'Network',
  integration: 'Integrations',
  ai: 'AI',
  'ai-sub': 'AI components',
  note: 'Other',
};
