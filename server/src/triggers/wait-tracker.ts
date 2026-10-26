import type { ExecutionsRepo } from '../db/repositories/executions.js';
import type { ExecutionService } from '../engine/execution-service.js';
import type { Logger } from '../logger.js';

/** Timers are only set for waits due soon; a periodic check picks up the rest. */
const LOOKAHEAD_MS = 70_000;

/**
 * Resumes executions paused by a Wait node when their time comes — also after a restart
 * (waiting executions are stored in the database with their engine state).
 */
export class WaitTracker {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private interval?: NodeJS.Timeout;

  constructor(
    private readonly o: { repo: ExecutionsRepo; executions: ExecutionService; logger: Logger; checkEveryMs?: number },
  ) {}

  init(): void {
    this.check();
    this.interval = setInterval(() => this.check(), this.o.checkEveryMs ?? 60_000);
    this.interval.unref();
  }

  /** Called when an execution starts waiting. */
  schedule(executionId: string, waitTill: Date | null): void {
    if (!waitTill) return; // waits for a webhook call / form, without time limit
    const delay = waitTill.getTime() - Date.now();
    if (delay > LOOKAHEAD_MS) return; // the periodic check will schedule it later
    clearTimeout(this.timers.get(executionId));
    const timer = setTimeout(() => this.resume(executionId), Math.max(0, delay));
    timer.unref();
    this.timers.set(executionId, timer);
  }

  shutdown(): void {
    if (this.interval) clearInterval(this.interval);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private check() {
    for (const w of this.o.repo.listWaiting()) {
      if (w.waitTill && !this.timers.has(w.id)) this.schedule(w.id, new Date(w.waitTill));
    }
  }

  private resume(executionId: string) {
    this.timers.delete(executionId);
    const started = this.o.executions.resume(executionId);
    if (started) this.o.logger.info(`Execution ${executionId} resumed after its wait time`);
  }
}
