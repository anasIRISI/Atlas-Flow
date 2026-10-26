import { Router } from 'express';
import { z } from 'zod';
import type { SettingsResponse } from '@flowforge/shared';
import type { AppServices } from '../app.js';
import { effectiveSettings } from '../settings/instance-settings.js';

const isTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const Policy = z.enum(['all', 'none']);

const PatchSchema = z.strictObject({
  executeCommandEnabled: z.boolean().optional(),
  timezone: z
    .string()
    .max(64)
    .refine((v) => v === '' || isTimezone(v), 'Must be an IANA timezone such as Europe/Paris, or empty')
    .optional(),
  executionTimeoutSeconds: z.number().int().min(0).max(86_400).optional(),
  maxConcurrentExecutions: z.number().int().min(0).max(50).optional(),
  allowEnvAccess: z.boolean().nullable().optional(),
  saveDataSuccess: Policy.optional(),
  saveDataError: Policy.optional(),
  saveDataManual: Policy.optional(),
  pruneMaxAgeDays: z.number().int().min(0).max(3650).optional(),
  pruneMaxCount: z.number().int().min(0).max(1_000_000).optional(),
});

/** /api/settings — instance switches and defaults (Settings page). */
export function settingsRouter(s: AppServices): Router {
  const router = Router();
  const respond = (): SettingsResponse => {
    const all = s.settings.all();
    return { ...all, effective: effectiveSettings(all, s.config) };
  };

  router.get('/', (_req, res) => {
    res.json(respond());
  });

  router.patch('/', async (req, res) => {
    const patch = PatchSchema.parse(req.body ?? {});
    const before = s.settings.all();
    const after = s.settings.update(patch);
    if (before.executeCommandEnabled !== after.executeCommandEnabled) {
      s.logger.warn(`Execute Command node ${after.executeCommandEnabled ? 'ENABLED' : 'disabled'} in Settings`);
    }
    const effective = effectiveSettings(after, s.config);
    s.executions.setMaxConcurrent(effective.maxConcurrentExecutions);
    // Schedules read the timezone when they start: restart the active workflows so they use the new one.
    if (effectiveSettings(before, s.config).timezone !== effective.timezone) {
      for (const id of s.workflowsRepo.listActiveIds()) await s.activeWorkflows.reactivateIfActive(id);
    }
    res.json(respond());
  });

  return router;
}
