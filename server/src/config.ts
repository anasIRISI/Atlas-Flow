import { isAbsolute, resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { DEFAULT_PORT } from '@flowforge/shared';
import type { LogLevel } from './logger.js';
import { detectLanAddress } from './net.js';
import { ROOT_DIR, WEB_DIST_DIR } from './paths.js';

export interface AppConfig {
  port: number;
  host: string;
  /** Base URL for webhooks, forms and QR codes (LAN address unless PUBLIC_URL is set). */
  publicUrl: string;
  publicUrlSource: 'env' | 'lan' | 'localhost';
  localUrl: string;
  dataDir: string;
  webDistDir: string;
  sessionTtlMs: number;
  logLevel: LogLevel;
  /** Default execution timeout (a workflow setting can override it). 0 = no timeout. */
  executionTimeoutMs: number;
  maxConcurrentExecutions: number;
  /** Loop guard: a run stops after this many node executions. */
  maxNodeRuns: number;
  /** IANA timezone used for $now, schedules and dates. */
  timezone: string;
  /** Expose the development endpoint POST /api/dev/run. */
  devApi: boolean;
  /** Allow `$env` in expressions (FlowForge secrets are always hidden). */
  allowEnvAccess: boolean;
  /** Folder file nodes may read/write/watch. */
  filesRoot: string;
  webhookMaxBodyBytes: number;
  webhookRatePerMinute: number;
  /** Public forms: max submissions per minute per IP, and max upload size. */
  formRatePerMinute: number;
  formMaxBodyBytes: number;
  /** FLOWFORGE_ENCRYPTION_KEY (otherwise data/.encryption_key is used). */
  encryptionKey?: string;
}

const isTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export class ConfigError extends Error {}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
  HOST: z.string().min(1).default('0.0.0.0'),
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  FLOWFORGE_DATA_DIR: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().positive().max(365).default(7),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  EXECUTION_TIMEOUT_SECONDS: z.coerce.number().min(0).max(86_400).default(300),
  MAX_CONCURRENT_EXECUTIONS: z.coerce.number().int().min(1).max(100).default(5),
  MAX_NODE_RUNS: z.coerce.number().int().min(10).max(1_000_000).default(10_000),
  GENERIC_TIMEZONE: z
    .string()
    .refine(isTimezone, 'must be an IANA timezone such as Europe/Paris')
    .default(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
  FLOWFORGE_DEV_API: bool.default(true),
  FLOWFORGE_ALLOW_ENV_ACCESS: bool.default(true),
  FLOWFORGE_FILES_DIR: z.string().optional(),
  WEBHOOK_MAX_BODY_MB: z.coerce.number().positive().max(1024).default(16),
  WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),
  FORM_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  FORM_MAX_UPLOAD_MB: z.coerce.number().positive().max(1024).default(10),
  FLOWFORGE_ENCRYPTION_KEY: z.string().min(16, 'must be at least 16 characters').optional(),
});

/** Loads `.env` from the repo root (never overriding real environment variables). */
export function loadDotEnv(): void {
  dotenv.config({ path: resolve(ROOT_DIR, '.env'), quiet: true });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Blank values copied from .env.example mean "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration in .env / environment:\n${problems}`);
  }
  const e = parsed.data;
  const dataDir = e.FLOWFORGE_DATA_DIR
    ? isAbsolute(e.FLOWFORGE_DATA_DIR)
      ? e.FLOWFORGE_DATA_DIR
      : resolve(ROOT_DIR, e.FLOWFORGE_DATA_DIR)
    : resolve(ROOT_DIR, 'data');
  const localUrl = `http://localhost:${e.PORT}`;
  const lanHost = e.HOST === '0.0.0.0' || e.HOST === '::' ? detectLanAddress() : undefined;
  const publicUrl = (e.PUBLIC_URL ?? (lanHost ? `http://${lanHost}:${e.PORT}` : localUrl)).replace(/\/+$/, '');

  return {
    port: e.PORT,
    host: e.HOST,
    publicUrl,
    publicUrlSource: e.PUBLIC_URL ? 'env' : lanHost ? 'lan' : 'localhost',
    localUrl,
    dataDir,
    webDistDir: WEB_DIST_DIR,
    sessionTtlMs: e.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    logLevel: e.LOG_LEVEL,
    executionTimeoutMs: e.EXECUTION_TIMEOUT_SECONDS * 1000,
    maxConcurrentExecutions: e.MAX_CONCURRENT_EXECUTIONS,
    maxNodeRuns: e.MAX_NODE_RUNS,
    timezone: e.GENERIC_TIMEZONE,
    devApi: e.FLOWFORGE_DEV_API,
    allowEnvAccess: e.FLOWFORGE_ALLOW_ENV_ACCESS,
    filesRoot: e.FLOWFORGE_FILES_DIR
      ? isAbsolute(e.FLOWFORGE_FILES_DIR)
        ? e.FLOWFORGE_FILES_DIR
        : resolve(ROOT_DIR, e.FLOWFORGE_FILES_DIR)
      : resolve(dataDir, 'files'),
    webhookMaxBodyBytes: Math.round(e.WEBHOOK_MAX_BODY_MB * 1024 * 1024),
    webhookRatePerMinute: e.WEBHOOK_RATE_LIMIT_PER_MINUTE,
    formRatePerMinute: e.FORM_RATE_LIMIT_PER_MINUTE,
    formMaxBodyBytes: Math.round(e.FORM_MAX_UPLOAD_MB * 1024 * 1024),
    encryptionKey: e.FLOWFORGE_ENCRYPTION_KEY,
  };
}
