import { DEFAULT_INSTANCE_SETTINGS, type EffectiveSettings, type InstanceSettings } from '@flowforge/shared';
import type { SettingsRepo } from '../db/repositories/settings.js';

const KEY = (name: string) => `instance.${name}`;

/** Typed access to the switches of the Settings page (stored in the `settings` table). */
export class InstanceSettingsService {
  constructor(private readonly repo: SettingsRepo) {}

  all(): InstanceSettings {
    const out = { ...DEFAULT_INSTANCE_SETTINGS };
    const target = out as Record<string, unknown>;
    for (const name of Object.keys(out) as (keyof InstanceSettings)[]) target[name] = this.repo.get(KEY(name), DEFAULT_INSTANCE_SETTINGS[name]);
    return out;
  }

  /** Value of one setting; unknown names are undefined. */
  get(name: string): unknown {
    return name in DEFAULT_INSTANCE_SETTINGS ? this.repo.get(KEY(name), DEFAULT_INSTANCE_SETTINGS[name as keyof InstanceSettings]) : undefined;
  }

  update(patch: Partial<InstanceSettings>): InstanceSettings {
    for (const [name, value] of Object.entries(patch)) {
      if (name in DEFAULT_INSTANCE_SETTINGS && value !== undefined) this.repo.set(KEY(name), value);
    }
    return this.all();
  }
}

/** Settings page first, then the .env value (what GET /api/settings reports as `effective`). */
export function effectiveSettings(
  s: InstanceSettings,
  config: { timezone: string; executionTimeoutMs: number; maxConcurrentExecutions: number; allowEnvAccess: boolean },
): EffectiveSettings {
  return {
    timezone: s.timezone || config.timezone,
    executionTimeoutSeconds: s.executionTimeoutSeconds > 0 ? s.executionTimeoutSeconds : Math.round(config.executionTimeoutMs / 1000),
    maxConcurrentExecutions: s.maxConcurrentExecutions > 0 ? s.maxConcurrentExecutions : config.maxConcurrentExecutions,
    allowEnvAccess: s.allowEnvAccess ?? config.allowEnvAccess,
  };
}
