import type { CredentialTypeInfo, CredentialValue } from '@flowforge/shared';
import discordWebhookApi from './discord-webhook-api.credential.js';
import googlePalmApi from './google-gemini-api.credential.js';
import httpBasicAuth from './http-basic-auth.credential.js';
import httpBearerAuth from './http-bearer-auth.credential.js';
import httpHeaderAuth from './http-header-auth.credential.js';
import httpQueryAuth from './http-query-auth.credential.js';
import smtp from './smtp.credential.js';
import telegramApi from './telegram-api.credential.js';
import type { CredentialData, CredentialType } from './types.js';

const TYPES: CredentialType[] = [smtp, telegramApi, discordWebhookApi, googlePalmApi, httpBasicAuth, httpBearerAuth, httpHeaderAuth, httpQueryAuth];

export class CredentialTypeRegistry {
  private readonly types = new Map<string, CredentialType>();

  constructor(types: CredentialType[] = TYPES) {
    for (const t of types) this.types.set(t.name, t);
  }

  get(name: string): CredentialType | undefined {
    return this.types.get(name);
  }

  names(): string[] {
    return [...this.types.keys()];
  }

  info(env: NodeJS.ProcessEnv): CredentialTypeInfo[] {
    return [...this.types.values()].map((t) => ({
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      icon: t.icon,
      ...(t.docsAnchor ? { docsAnchor: t.docsAnchor } : {}),
      properties: t.properties,
      ...(t.presets ? { presets: t.presets } : {}),
      testable: typeof t.test === 'function',
      envConfigured: fromEnv(t, env) !== undefined,
    }));
  }
}

/** Converts a raw value (form field, .env string) to the property type. */
export function coerce(type: 'string' | 'number' | 'boolean' | 'options', value: unknown): CredentialValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (s === '') return undefined;
    return s === 'true' || s === '1' || s === 'yes' || s === 'on';
  }
  if (type === 'number') {
    if (typeof value === 'string' && value.trim() === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return typeof value === 'string' ? value : String(value);
}

/** Values found in `.env` for this type, or undefined when its required variables are not all set. */
export function fromEnv(type: CredentialType, env: NodeJS.ProcessEnv): CredentialData | undefined {
  const required = type.envRequired ?? type.properties.filter((p) => p.required && p.env).map((p) => p.env!);
  if (!required.length || required.some((name) => !env[name]?.trim())) return undefined;
  const data: CredentialData = {};
  for (const p of type.properties) {
    if (!p.env) continue;
    const value = coerce(p.type, env[p.env]?.trim());
    if (value !== undefined) data[p.name] = value;
  }
  return data;
}

/** Applies normalize() then the property defaults. */
export function completeData(type: CredentialType, data: CredentialData): CredentialData {
  const out = type.normalize ? type.normalize({ ...data }) : { ...data };
  for (const p of type.properties) {
    if ((out[p.name] === undefined || out[p.name] === '') && p.default !== undefined) out[p.name] = p.default;
  }
  return out;
}
