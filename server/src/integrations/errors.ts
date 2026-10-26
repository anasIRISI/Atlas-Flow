import { CredentialError, NodeOperationError } from '../engine/errors.js';
import type { ResolvedCredential } from '../engine/types.js';

export interface IntegrationErrorInfo {
  /** HTTP status of the answer, when there was one. */
  status?: number;
  /** Machine-readable reason given by the service (e.g. "API_KEY_INVALID"). */
  code?: string;
  /** What the user can do about it. */
  hint?: string;
  /** True when the key / token / URL of the credential is wrong or revoked. */
  auth?: boolean;
  /** The service asked to wait this long before trying again (429). */
  retryAfterMs?: number;
}

/**
 * A failed call to an external service, already put in plain words by the client in this folder.
 * The message and the hint never contain a secret (clients pass every text through `redact()`).
 */
export class IntegrationError extends Error {
  readonly service: string;
  readonly status?: number;
  readonly code?: string;
  readonly hint?: string;
  readonly auth: boolean;
  readonly retryAfterMs?: number;

  constructor(service: string, message: string, info: IntegrationErrorInfo = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.service = service;
    this.status = info.status;
    this.code = info.code;
    this.hint = info.hint;
    this.auth = info.auth === true;
    this.retryAfterMs = info.retryAfterMs;
  }
}

/**
 * Turns a client error into the error a node throws: a `CredentialError` when the key is wrong (the UI then shows
 * "Open Credentials" for the right credential), a `NodeOperationError` otherwise. Other errors pass through.
 */
export function toNodeError(err: unknown, o: { credentialType?: string; credential?: ResolvedCredential; envVars?: string; docsAnchor?: string; itemIndex?: number } = {}): unknown {
  if (!(err instanceof IntegrationError)) return err;
  if (err.auth && o.credentialType) {
    const fromEnv = o.credential?.source === 'env' && o.envVars ? ` The value comes from .env (${o.envVars}).` : '';
    return new CredentialError(err.message, {
      credentialType: o.credentialType,
      credentialId: o.credential?.id,
      docsAnchor: o.docsAnchor,
      hint: `${err.hint ?? ''}${fromEnv}`.trim() || undefined,
      itemIndex: o.itemIndex,
    });
  }
  return new NodeOperationError(err.message, { hint: err.hint, itemIndex: o.itemIndex });
}
