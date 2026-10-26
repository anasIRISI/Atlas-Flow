import type { CredentialPreset, CredentialPropertyInfo, CredentialValue } from '@flowforge/shared';

export type CredentialData = Record<string, CredentialValue>;

export interface CredentialTestOutcome {
  ok: boolean;
  message: string;
  hint?: string;
}

/** One file per credential type in this folder (smtp.credential.ts, …). */
export interface CredentialType {
  /** n8n-compatible name, e.g. "smtp", "httpBasicAuth". */
  name: string;
  displayName: string;
  description: string;
  /** lucide icon name. */
  icon: string;
  /** Section of API_SETUP.md, e.g. "#email-smtp". */
  docsAnchor?: string;
  properties: CredentialPropertyInfo[];
  presets?: CredentialPreset[];
  /** `.env` variables that must be set for the fallback to apply (default: those of the required properties). */
  envRequired?: string[];
  /** Fills values that depend on each other (e.g. SMTP: port 465 ⇒ SSL/TLS on) before defaults apply. */
  normalize?(data: CredentialData): CredentialData;
  /** Connection check used by the Test button and `npm run check:email`. */
  test?(data: CredentialData, options: { signal?: AbortSignal }): Promise<CredentialTestOutcome>;
}

/** Identity helper giving credential files full type checking. */
export function defineCredential(type: CredentialType): CredentialType {
  return type;
}
