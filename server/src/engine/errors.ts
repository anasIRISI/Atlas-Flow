import type { SerializedError } from '@flowforge/shared';

/** Base class for every user-facing error: message + optional description/hint shown in the UI. */
export class FlowError extends Error {
  description?: string;
  hint?: string;
  node?: string;
  itemIndex?: number;

  constructor(message: string, options: { description?: string; hint?: string; node?: string; itemIndex?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.description = options.description;
    this.hint = options.hint;
    this.node = options.node;
    this.itemIndex = options.itemIndex;
  }
}

/** A node failed while doing its job (bad parameter, failed conversion, Stop and Error, …). */
export class NodeOperationError extends FlowError {}

/** An `{{ expression }}` could not be parsed or evaluated. */
export class ExpressionError extends FlowError {
  expression?: string;
  constructor(message: string, options: ConstructorParameters<typeof FlowError>[1] & { expression?: string } = {}) {
    super(message, options);
    this.expression = options.expression;
  }
}

/** The workflow itself is invalid or the run had to stop (unknown node, loop guard, timeout, cancel). */
export class WorkflowOperationError extends FlowError {}

export class ExecutionTimeoutError extends WorkflowOperationError {}

/** Thrown by the Wait node: the execution pauses and is resumed later (time, webhook call or form). */
export class WaitSignal extends Error {
  constructor(
    readonly resumeAt: Date | null,
    readonly kind: 'time' | 'webhook' | 'form',
  ) {
    super('Execution is waiting');
  }
}

/** A credential problem (missing, wrong password…): the UI offers "Open Credentials". */
export class CredentialError extends NodeOperationError {
  readonly credentialType: string;
  /** Saved credential that was used (absent when the values came from .env). */
  readonly credentialId?: string;
  readonly envVar?: string;
  readonly docsAnchor?: string;

  constructor(
    message: string,
    options: ConstructorParameters<typeof FlowError>[1] & { credentialType: string; credentialId?: string; envVar?: string; docsAnchor?: string },
  ) {
    super(message, options);
    this.credentialType = options.credentialType;
    this.credentialId = options.credentialId;
    this.envVar = options.envVar;
    this.docsAnchor = options.docsAnchor;
  }
}

/** A node needs credentials that are not configured. */
export class MissingCredentialError extends CredentialError {
  constructor(credentialType: string, displayName: string, envVar?: string, docsAnchor?: string) {
    super(`${displayName} credentials are missing`, {
      credentialType,
      envVar,
      docsAnchor,
      hint: `Add them on the Credentials page${envVar ? ` or set ${envVar} in .env` : ''}${docsAnchor ? ` (see API_SETUP.md${docsAnchor})` : ''}.`,
    });
  }
}

export class ExecutionCanceledError extends WorkflowOperationError {}

export function serializeError(err: unknown, node?: string): SerializedError {
  if (err instanceof FlowError) {
    const out: SerializedError = { name: err.name, message: err.message };
    if (err.description) out.description = err.description;
    if (err.hint) out.hint = err.hint;
    if (err.node ?? node) out.node = err.node ?? node;
    if (err.itemIndex !== undefined) out.itemIndex = err.itemIndex;
    if (err instanceof ExpressionError && err.expression) out.expression = err.expression;
    if (err instanceof CredentialError) {
      out.credentialType = err.credentialType;
      if (err.credentialId) out.credentialId = err.credentialId;
      if (err.envVar) out.envVar = err.envVar;
      if (err.docsAnchor) out.docsAnchor = err.docsAnchor;
    }
    return out;
  }
  if (err instanceof Error) return { name: err.name || 'Error', message: err.message, ...(node ? { node } : {}) };
  return { name: 'Error', message: String(err), ...(node ? { node } : {}) };
}

/** Wraps anything thrown by a node into a FlowError that knows which node failed. */
export function toFlowError(err: unknown, node: string): FlowError {
  if (err instanceof FlowError) {
    err.node ??= node;
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new NodeOperationError(message, { node, cause: err });
}
