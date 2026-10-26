import { Router } from 'express';
import type { DashboardStats, ExecutionListItem, ExecutionMode, ExecutionStatus } from '@flowforge/shared';
import type { AppServices } from '../app.js';

const DAYS = 14;
const DAY_MS = 86_400_000;

/** Local calendar day (YYYY-MM-DD) of an instant in a timezone. */
function localDay(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** The last `count` local days ending today, oldest first. Stepping by 24 h from noon avoids DST edge cases. */
export function lastDays(now: number, timezone: string, count = DAYS): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(localDay(now - i * DAY_MS, timezone));
  return [...new Set(out)].slice(-count);
}

/** Offset (ms) of the timezone from UTC at an instant. */
function offsetMs(ms: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const v = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)])) as Record<string, number>;
  return Date.UTC(v.year!, v.month! - 1, v.day!, v.hour!, v.minute!, v.second!) - Math.floor(ms / 1000) * 1000;
}

/** First instant of a local day. */
function startOfLocalDay(day: string, timezone: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!);
  return guess - offsetMs(guess - offsetMs(guess, timezone), timezone);
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** /api/dashboard — SQL aggregates over the executions of the last 14 days. Contract: docs/phase7-contracts.md (W5) */
export function dashboardRouter(s: AppServices): Router {
  const router = Router({ mergeParams: true });

  router.get('/', (_req, res) => {
    const configured = s.settings.all().timezone || s.config.timezone;
    const timezone = validTimezone(configured) ? configured : 'UTC';
    const now = Date.now();
    const days = lastDays(now, timezone);
    const cutoff = new Date(startOfLocalDay(days[0]!, timezone)).toISOString();

    const perDay = new Map(days.map((d) => [d, { day: d, success: 0, error: 0, other: 0 }]));
    const totals = { executions: 0, success: 0, error: 0, running: 0, waiting: 0 };
    let durationSum = 0;
    let durationCount = 0;
    const dayCache = new Map<string, string>();

    // One row per minute and status: small, and the local day can be computed exactly.
    const buckets = s.db
      .prepare(
        `SELECT substr(created_at, 1, 16) AS minute, status, COUNT(*) AS n,
                SUM(CASE WHEN started_at IS NOT NULL AND stopped_at IS NOT NULL AND status IN ('success','error')
                         THEN (julianday(stopped_at) - julianday(started_at)) * 86400000 END) AS dur,
                SUM(CASE WHEN started_at IS NOT NULL AND stopped_at IS NOT NULL AND status IN ('success','error') THEN 1 ELSE 0 END) AS durN
         FROM executions WHERE created_at >= ? GROUP BY minute, status`,
      )
      .all(cutoff) as Array<{ minute: string; status: string; n: number; dur: number | null; durN: number }>;
    for (const b of buckets) {
      let day = dayCache.get(b.minute);
      if (!day) {
        day = localDay(Date.parse(`${b.minute}:00Z`), timezone);
        dayCache.set(b.minute, day);
      }
      const slot = perDay.get(day);
      if (!slot) continue;
      totals.executions += b.n;
      if (b.status === "success") {
        slot.success += b.n;
        totals.success += b.n;
      }
      else if (b.status === "error") {
        slot.error += b.n;
        totals.error += b.n;
      }
      else {
        slot.other += b.n;
        if (b.status === 'running' || b.status === 'queued') totals.running += b.n;
        else if (b.status === 'waiting') totals.waiting += b.n;
      }
      durationSum += b.dur ?? 0;
      durationCount += b.durN;
    }

    const finishedCount = totals.success + totals.error;

    const failing = s.db
      .prepare(
        `SELECT workflow_id, workflow_name, COUNT(*) AS errors, MAX(id) AS last_id
         FROM executions WHERE status = 'error' AND created_at >= ? GROUP BY COALESCE(workflow_id, workflow_name)
         ORDER BY errors DESC, last_id DESC LIMIT 5`,
      )
      .all(cutoff) as Array<{ workflow_id: string | null; workflow_name: string; errors: number; last_id: number }>;
    const lastError = s.db.prepare('SELECT error_message FROM executions WHERE id = ?');
    const topFailing = failing.map((f) => ({
      workflowId: f.workflow_id,
      workflowName: f.workflow_name,
      errors: f.errors,
      lastError: (lastError.get(f.last_id) as { error_message: string | null } | undefined)?.error_message ?? null,
    }));

    const recent = (
      s.db
        .prepare(
          `SELECT id, workflow_id, workflow_name, mode, status, created_at, started_at, stopped_at, last_node, error_message, parent_execution_id, retry_of, wait_till, waiting_node
           FROM executions ORDER BY id DESC LIMIT 10`,
        )
        .all() as Array<Record<string, string | number | null>>
    ).map((r): ExecutionListItem => {
      const started = r.started_at ? Date.parse(String(r.started_at)) : NaN;
      const stopped = r.stopped_at ? Date.parse(String(r.stopped_at)) : NaN;
      return {
        id: String(r.id),
        workflowId: (r.workflow_id as string | null) ?? null,
        workflowName: String(r.workflow_name),
        mode: r.mode as ExecutionMode,
        status: r.status as ExecutionStatus,
        startedAt: (r.started_at as string | null) ?? null,
        stoppedAt: (r.stopped_at as string | null) ?? null,
        lastNodeExecuted: (r.last_node as string | null) ?? null,
        errorMessage: (r.error_message as string | null) ?? null,
        parentExecutionId: r.parent_execution_id === null ? null : String(r.parent_execution_id),
        waitTill: (r.wait_till as string | null) ?? null,
        waitingNode: (r.waiting_node as string | null) ?? null,
        createdAt: String(r.created_at),
        retryOf: r.retry_of === null ? null : String(r.retry_of),
        durationMs: Number.isNaN(started) || Number.isNaN(stopped) ? null : Math.max(0, stopped - started),
      };
    });

    const wfCounts = s.db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active FROM workflows').get() as { total: number; active: number };

    // Only names and counts: no credential data ever reaches this response.
    const saved = new Map<string, number>();
    for (const c of s.credentials.list()) saved.set(c.type, (saved.get(c.type) ?? 0) + 1);
    const integrations = s.credentials.types().map((t) => ({ type: t.name, displayName: t.displayName, count: saved.get(t.name) ?? 0, fromEnv: t.envConfigured }));

    const stats: DashboardStats = {
      perDay: days.map((d) => perDay.get(d)!),
      totals,
      successRate: finishedCount ? totals.success / finishedCount : null,
      avgDurationMs: durationCount ? Math.round(durationSum / durationCount) : null,
      topFailing,
      recent,
      workflows: { total: wfCounts.total, active: wfCounts.active },
      integrations,
    };
    res.json(stats);
  });

  return router;
}
