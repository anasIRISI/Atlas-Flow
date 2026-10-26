// Credentials: encrypted logins/API keys used by integration nodes. Secrets never travel back to the browser.

export type CredentialValue = string | number | boolean;

export interface CredentialPropertyInfo {
  name: string;
  displayName: string;
  type: 'string' | 'number' | 'boolean' | 'options';
  default?: CredentialValue;
  required?: boolean;
  /** Secret value: stored encrypted, never sent back to the browser (the UI shows it masked). */
  password?: boolean;
  placeholder?: string;
  description?: string;
  options?: { name: string; value: CredentialValue }[];
  /** `.env` variable used as a fallback when no credential is saved. */
  env?: string;
}

/** One-click values for well-known providers (e.g. Gmail, Brevo). */
export interface CredentialPreset {
  id: string;
  name: string;
  description: string;
  values: Record<string, CredentialValue>;
}

export interface CredentialTypeInfo {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  /** Section of API_SETUP.md explaining how to get the values, e.g. "#email-smtp". */
  docsAnchor?: string;
  properties: CredentialPropertyInfo[];
  presets?: CredentialPreset[];
  /** The type has a "Test" action (connection check). */
  testable: boolean;
  /** Every required `.env` variable is set: nodes work even without a saved credential. */
  envConfigured: boolean;
}

export interface CredentialSummary {
  id: string;
  name: string;
  type: string;
  /** Used by nodes that did not pick a credential. */
  isDefault: boolean;
  /** Non-secret values only. */
  data: Record<string, CredentialValue>;
  /** Names of the secret fields that have a value (the values are never sent). */
  secrets: string[];
  createdAt: string;
  updatedAt: string;
  /** Set when the credential cannot be decrypted (encryption key changed). */
  error?: string;
}

/**
 * Create / update body. On update, a secret field that is missing (or an empty string) keeps its saved
 * value; `null` clears it.
 */
export interface CredentialInput {
  name: string;
  type: string;
  data: Record<string, CredentialValue | null>;
  isDefault?: boolean;
}

export interface CredentialTestRequest {
  type: string;
  data: Record<string, CredentialValue | null>;
  /** Saved credential whose secrets fill the fields left empty (testing while editing). */
  id?: string;
}

export interface CredentialTestResult {
  ok: boolean;
  message: string;
  hint?: string;
  durationMs: number;
}

/** Reference to a credential stored on a workflow node (n8n format). */
export interface NodeCredentialRef {
  id: string;
  name: string;
}
