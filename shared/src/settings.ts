// Instance settings switched on the Settings page.

/** "all" = keep the execution and its data, "none" = delete it once it has finished (after a short grace period). */
export type SaveDataPolicy = 'all' | 'none';

export interface InstanceSettings {
  /** The Execute Command node may run shell commands on this computer. Off by default. */
  executeCommandEnabled: boolean;
  /** IANA timezone for $now, schedules and dates. Empty = the GENERIC_TIMEZONE of .env. */
  timezone: string;
  /** Default execution timeout in seconds (a workflow's own setting wins). 0 = the .env value. */
  executionTimeoutSeconds: number;
  /** How many executions run at the same time. 0 = the .env value (MAX_CONCURRENT_EXECUTIONS). */
  maxConcurrentExecutions: number;
  /** Expressions and the Code node may read $env (secret-looking variables are always hidden). null = the .env value. */
  allowEnvAccess: boolean | null;
  /** Keep the data of successful / failed production runs and of manual runs. */
  saveDataSuccess: SaveDataPolicy;
  saveDataError: SaveDataPolicy;
  saveDataManual: SaveDataPolicy;
  /** Delete finished executions older than N days (0 = never). Waiting / running executions are never deleted. */
  pruneMaxAgeDays: number;
  /** Keep at most N finished executions (0 = no limit). */
  pruneMaxCount: number;
}

export const DEFAULT_INSTANCE_SETTINGS: InstanceSettings = {
  executeCommandEnabled: false,
  timezone: '',
  executionTimeoutSeconds: 0,
  maxConcurrentExecutions: 0,
  allowEnvAccess: null,
  saveDataSuccess: 'all',
  saveDataError: 'all',
  saveDataManual: 'all',
  pruneMaxAgeDays: 14,
  pruneMaxCount: 10000,
};

/** Values in effect: Settings page first, then .env (GET /api/settings → `effective`). */
export interface EffectiveSettings {
  timezone: string;
  executionTimeoutSeconds: number;
  maxConcurrentExecutions: number;
  allowEnvAccess: boolean;
}

export interface SettingsResponse extends InstanceSettings {
  effective: EffectiveSettings;
}
