import type { WorkflowData } from '@flowforge/shared';
import type { UrlPrefix } from '../engine/types.js';

export type WebhookKind = 'prod' | 'test';

export interface WebhookRegistration {
  kind: WebhookKind;
  /** "/webhook/…" or "/form/…": separate namespaces. */
  prefix?: UrlPrefix;
  workflowId: string;
  /** Workflow snapshot that runs when the webhook is called. */
  workflow: WorkflowData;
  nodeName: string;
  methods: string[];
  /** Normalized path, may contain ":param" segments. */
  path: string;
  /** Test listeners are single-shot: called after the first request. */
  onUse?: () => void;
  /** Demo Mode: set only by TestListeners.listen(..., { demo: true }) (test registrations only). */
  demo?: boolean;
}

export class WebhookPathError extends Error {}

const MAX_PATH_LENGTH = 255;
const SEGMENT = /^(:[A-Za-z_][\w]*|[\w.\-~@]+)$/;

/** "/User//:id/" → "user/:id" style normalization (case kept). Throws for invalid paths. */
export function normalizePath(path: string): string {
  const clean = path.trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!clean) throw new WebhookPathError('The webhook path is empty');
  if (clean.length > MAX_PATH_LENGTH) throw new WebhookPathError(`The webhook path is longer than ${MAX_PATH_LENGTH} characters`);
  for (const segment of clean.split('/')) {
    if (!SEGMENT.test(segment)) {
      throw new WebhookPathError(`Invalid character in webhook path segment "${segment}"`);
    }
  }
  return clean;
}

const shape = (path: string) =>
  path
    .split('/')
    .map((s) => (s.startsWith(':') ? ':' : s))
    .join('/');

/**
 * All registered webhooks (production = active workflows, test = "Listen for test event").
 * Static paths win over dynamic ones ("user/me" before "user/:id").
 */
export class WebhookRegistry {
  private regs: WebhookRegistration[] = [];

  /** A production webhook already using one of these methods on this path (other workflow or node). */
  findConflict(methods: string[], path: string, workflowId: string, nodeName: string, prefix: UrlPrefix = 'webhook'): WebhookRegistration | undefined {
    const target = shape(path);
    return this.regs.find(
      (r) =>
        r.kind === 'prod' &&
        (r.prefix ?? 'webhook') === prefix &&
        shape(r.path) === target &&
        r.methods.some((m) => methods.includes(m)) &&
        !(r.workflowId === workflowId && r.nodeName === nodeName),
    );
  }

  add(reg: WebhookRegistration): void {
    if (reg.kind === 'test') {
      // Latest listener wins for the same method + path.
      this.regs = this.regs.filter(
        (r) =>
          !(r.kind === 'test' && (r.prefix ?? 'webhook') === (reg.prefix ?? 'webhook') && shape(r.path) === shape(reg.path) && r.methods.some((m) => reg.methods.includes(m))),
      );
    } else {
      const conflict = this.findConflict(reg.methods, reg.path, reg.workflowId, reg.nodeName, reg.prefix);
      if (conflict) {
        throw new WebhookPathError(
          `The path "${reg.path}" (${reg.methods.join(', ')}) is already used by the active workflow "${conflict.workflow.name}"`,
        );
      }
    }
    this.regs.push(reg);
  }

  remove(reg: WebhookRegistration): void {
    this.regs = this.regs.filter((r) => r !== reg);
  }

  removeWorkflow(kind: WebhookKind, workflowId: string): void {
    this.regs = this.regs.filter((r) => !(r.kind === kind && r.workflowId === workflowId));
  }

  count(kind?: WebhookKind): number {
    return kind ? this.regs.filter((r) => r.kind === kind).length : this.regs.length;
  }

  /** Finds the registration for a request; `methods` lists what the path accepts when the method does not match. */
  match(
    kind: WebhookKind,
    method: string,
    rawPath: string,
    prefix: UrlPrefix = 'webhook',
  ): { reg: WebhookRegistration; params: Record<string, string> } | { methods: string[] } | null {
    let path: string;
    try {
      path = normalizePath(decodeURIComponent(rawPath));
    } catch {
      return null;
    }
    const segments = path.split('/');
    const candidates = this.regs.filter((r) => r.kind === kind && (r.prefix ?? 'webhook') === prefix);
    const matchOne = (reg: WebhookRegistration): Record<string, string> | null => {
      const parts = reg.path.split('/');
      if (parts.length !== segments.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]!;
        if (p.startsWith(':')) params[p.slice(1)] = segments[i]!;
        else if (p !== segments[i]) return null;
      }
      return params;
    };
    // Static paths first, then dynamic ones.
    const ordered = [...candidates.filter((r) => !r.path.includes(':')), ...candidates.filter((r) => r.path.includes(':'))];
    const allowed = new Set<string>();
    for (const reg of ordered) {
      const params = matchOne(reg);
      if (!params) continue;
      if (reg.methods.includes(method)) return { reg, params };
      reg.methods.forEach((m) => allowed.add(m));
    }
    return allowed.size ? { methods: [...allowed] } : null;
  }
}
