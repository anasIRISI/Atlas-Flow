import type { InstanceSettings } from '@flowforge/shared';
import type { ExecutionsRepo } from '../db/repositories/executions.js';
import type { BinaryStore } from './binary-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Manual runs are kept at least this long when "save manual executions" is off. */
export const MANUAL_GRACE_MS = 10 * 60 * 1000;

export type PruneSettings = Pick<InstanceSettings, 'pruneMaxAgeDays' | 'pruneMaxCount' | 'saveDataManual'>;

/**
 * Deletes finished executions (success | error | canceled | crashed) that are too old, beyond the newest
 * `pruneMaxCount`, or manual runs when manual data is not saved. Never touches queued / running / waiting.
 * A limit of 0 means "no limit". Returns the number of deleted executions.
 */
export async function pruneExecutions(
  deps: { repo: ExecutionsRepo; binaryStore: BinaryStore },
  settings: PruneSettings,
  now: Date = new Date(),
): Promise<number> {
  const ids = deps.repo.findPrunable({
    olderThan: settings.pruneMaxAgeDays > 0 ? new Date(now.getTime() - settings.pruneMaxAgeDays * DAY_MS).toISOString() : null,
    keepNewest: settings.pruneMaxCount > 0 ? settings.pruneMaxCount : null,
    manualOlderThan: settings.saveDataManual === 'none' ? new Date(now.getTime() - MANUAL_GRACE_MS).toISOString() : null,
  });
  for (const id of ids) {
    deps.repo.delete(id);
    await deps.binaryStore.deleteExecution(id).catch(() => undefined);
  }
  return ids.length;
}
