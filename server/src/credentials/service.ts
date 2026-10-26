import { randomUUID } from 'node:crypto';
import type {
  CredentialInput,
  CredentialSummary,
  CredentialTestRequest,
  CredentialTestResult,
  CredentialTypeInfo,
  CredentialValue,
  WorkflowNode,
} from '@flowforge/shared';
import type { CredentialRow, CredentialsRepo } from '../db/repositories/credentials.js';
import { CredentialError, MissingCredentialError } from '../engine/errors.js';
import type { CredentialsProvider, ResolvedCredential } from '../engine/types.js';
import { badRequest, notFound } from '../http/errors.js';
import type { Logger } from '../logger.js';
import { CredentialDecryptError, type CredentialCipher } from './cipher.js';
import { coerce, completeData, fromEnv, type CredentialTypeRegistry } from './registry.js';
import type { CredentialData, CredentialType } from './types.js';

export interface CredentialsServiceOptions {
  repo: CredentialsRepo;
  cipher: CredentialCipher;
  types: CredentialTypeRegistry;
  logger: Logger;
  /** Where `.env` fallbacks are read (process.env by default). */
  env?: NodeJS.ProcessEnv;
}

const MAX_VALUE_LENGTH = 10_000;

/**
 * Credentials: encrypted CRUD, Test button and lookup for nodes.
 * Secrets only leave this class decrypted towards nodes (in memory), never towards the API.
 */
export class CredentialsService implements CredentialsProvider {
  constructor(private readonly o: CredentialsServiceOptions) {}

  private get env(): NodeJS.ProcessEnv {
    return this.o.env ?? process.env;
  }

  types(): CredentialTypeInfo[] {
    return this.o.types.info(this.env);
  }

  list(type?: string): CredentialSummary[] {
    return this.o.repo.list(type).map((row) => this.summarize(row));
  }

  get(id: string): CredentialSummary | undefined {
    const row = this.o.repo.get(id);
    return row ? this.summarize(row) : undefined;
  }

  create(input: CredentialInput): CredentialSummary {
    const type = this.requireType(input.type);
    const name = this.cleanName(input.name, type);
    const data = this.cleanData(type, input.data, {});
    const id = randomUUID();
    this.o.repo.insert({ id, name, type: type.name, data: this.encrypt(id, data) }, input.isDefault === true);
    this.o.logger.info(`Credential "${name}" (${type.displayName}) created`);
    return this.get(id)!;
  }

  update(id: string, input: Partial<CredentialInput>): CredentialSummary {
    const row = this.o.repo.get(id);
    if (!row) throw notFound('Credential not found. It may have been deleted.');
    const type = this.requireType(row.type);
    if (input.type && input.type !== row.type) throw badRequest('The type of a credential cannot be changed', 'Create a new credential instead.');
    let current: CredentialData = {};
    try {
      current = this.decrypt(row);
    } catch {
      // Unreadable (key changed): the new values replace everything.
    }
    const patch: { name?: string; data?: string } = {};
    if (input.name !== undefined) patch.name = this.cleanName(input.name, type);
    if (input.data !== undefined) patch.data = this.encrypt(id, this.cleanData(type, input.data, current));
    this.o.repo.update(id, patch);
    if (input.isDefault !== undefined) this.o.repo.setDefault(id, input.isDefault);
    return this.get(id)!;
  }

  delete(id: string): boolean {
    const row = this.o.repo.get(id);
    const deleted = this.o.repo.delete(id);
    if (deleted && row) this.o.logger.info(`Credential "${row.name}" deleted`);
    return deleted;
  }

  /** Runs the type's connection test with the given values (secrets left empty come from the saved credential). */
  async test(req: CredentialTestRequest): Promise<CredentialTestResult> {
    const type = this.requireType(req.type);
    if (!type.test) return { ok: false, message: `${type.displayName} credentials cannot be tested`, durationMs: 0 };
    let saved: CredentialData = {};
    if (req.id) {
      const row = this.o.repo.get(req.id);
      if (!row || row.type !== type.name) throw notFound('Credential not found. It may have been deleted.');
      try {
        saved = this.decrypt(row);
      } catch (err) {
        return { ok: false, message: (err as Error).message, durationMs: 0 };
      }
    }
    const data = completeData(type, this.cleanData(type, req.data ?? {}, saved, false));
    return this.runTest(type, data);
  }

  /** Test of a saved credential, or of the `.env` values when `id` is "env". */
  async testSaved(id: string, typeName?: string): Promise<CredentialTestResult> {
    if (id === 'env') {
      const type = this.requireType(typeName ?? '');
      const data = fromEnv(type, this.env);
      if (!data) return { ok: false, message: `No ${type.displayName} settings in .env`, durationMs: 0 };
      return this.runTest(type, completeData(type, data));
    }
    const row = this.o.repo.get(id);
    if (!row) throw notFound('Credential not found. It may have been deleted.');
    return this.test({ type: row.type, data: {}, id });
  }

  /**
   * Values for a node: the credential selected on the node (by id, then by name for imported workflows),
   * else the default credential of the type, else `.env`, else MissingCredentialError.
   */
  resolve(node: WorkflowNode, typeName: string): ResolvedCredential {
    const type = this.o.types.get(typeName);
    if (!type) throw new CredentialError(`Unknown credential type "${typeName}"`, { credentialType: typeName });
    const selected = node.credentials?.[typeName];
    const byId = selected?.id ? this.o.repo.get(selected.id) : undefined;
    const row =
      (byId?.type === typeName ? byId : undefined) ??
      (selected?.name ? this.o.repo.findByName(typeName, selected.name) : undefined) ??
      this.o.repo.defaultFor(typeName);
    if (row) {
      let data: CredentialData;
      try {
        data = this.decrypt(row);
      } catch (err) {
        throw new CredentialError(`Credential "${row.name}" cannot be used`, {
          credentialType: typeName,
          credentialId: row.id,
          description: (err as Error).message,
          docsAnchor: type.docsAnchor,
        });
      }
      return { data: completeData(type, data), source: 'credential', id: row.id, name: row.name };
    }
    const env = fromEnv(type, this.env);
    if (env) return { data: completeData(type, env), source: 'env', name: '.env' };
    const envVar = type.envRequired?.[0] ?? type.properties.find((p) => p.required && p.env)?.env;
    throw new MissingCredentialError(typeName, type.displayName, envVar, type.docsAnchor);
  }

  // ── internals ──

  private async runTest(type: CredentialType, data: CredentialData): Promise<CredentialTestResult> {
    const missing = type.properties.filter((p) => p.required && (data[p.name] === undefined || data[p.name] === ''));
    if (missing.length) {
      return { ok: false, message: `Fill in: ${missing.map((p) => p.displayName).join(', ')}`, durationMs: 0 };
    }
    const started = Date.now();
    try {
      const outcome = await type.test!(data, {});
      return { ...outcome, durationMs: Date.now() - started };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started };
    }
  }

  private requireType(name: string): CredentialType {
    const type = this.o.types.get(name);
    if (!type) throw badRequest(`Unknown credential type "${name}"`, `Known types: ${this.o.types.names().join(', ')}`);
    return type;
  }

  private cleanName(name: unknown, type: CredentialType): string {
    const clean = String(name ?? '').trim() || `${type.displayName} account`;
    if (clean.length > 128) throw badRequest('The credential name is too long (128 characters max)');
    return clean;
  }

  /**
   * Validates and merges submitted values with the saved ones. Secrets left empty keep their saved value,
   * `null` clears a value. Unknown fields are dropped.
   */
  private cleanData(type: CredentialType, input: Record<string, CredentialValue | null>, saved: CredentialData, enforceRequired = true): CredentialData {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('"data" must be an object');
    const out: CredentialData = {};
    for (const p of type.properties) {
      const given = input[p.name];
      if (given === null) continue;
      const keepSaved = given === undefined || (p.password && given === '');
      const value = keepSaved ? saved[p.name] : coerce(p.type, given);
      if (given !== undefined && !keepSaved && value === undefined && String(given).trim() !== '') {
        throw badRequest(`${p.displayName} must be a ${p.type}`);
      }
      if (value === undefined || value === '') continue;
      if (typeof value === 'string' && value.length > MAX_VALUE_LENGTH) throw badRequest(`${p.displayName} is too long`);
      if (p.type === 'options' && p.options && !p.options.some((o) => o.value === value)) throw badRequest(`${p.displayName} has an invalid value`);
      out[p.name] = value;
    }
    if (enforceRequired) {
      const missing = type.properties.filter((p) => p.required && p.default === undefined && out[p.name] === undefined);
      if (missing.length) throw badRequest(`Fill in: ${missing.map((p) => p.displayName).join(', ')}`);
    }
    return out;
  }

  private encrypt(id: string, data: CredentialData): string {
    return this.o.cipher.encrypt(JSON.stringify(data), id);
  }

  private decrypt(row: CredentialRow): CredentialData {
    const parsed = JSON.parse(this.o.cipher.decrypt(row.data, row.id)) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new CredentialDecryptError('Credential data is invalid');
    return parsed as CredentialData;
  }

  private summarize(row: CredentialRow): CredentialSummary {
    const type = this.o.types.get(row.type);
    const base = { id: row.id, name: row.name, type: row.type, isDefault: row.is_default === 1, createdAt: row.created_at, updatedAt: row.updated_at };
    let data: CredentialData;
    try {
      data = this.decrypt(row);
    } catch (err) {
      return { ...base, data: {}, secrets: [], error: (err as Error).message };
    }
    const visible: CredentialData = {};
    const secrets: string[] = [];
    for (const p of type?.properties ?? []) {
      const value = data[p.name];
      if (value === undefined || value === '') continue;
      if (p.password) secrets.push(p.name);
      else visible[p.name] = value;
    }
    return { ...base, data: visible, secrets };
  }
}
