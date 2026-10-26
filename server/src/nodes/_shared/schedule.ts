import { Cron } from 'croner';
import { DateTime } from 'luxon';
import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';

export interface ScheduleRule {
  field?: 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'cronExpression';
  secondsInterval?: number;
  minutesInterval?: number;
  hoursInterval?: number;
  daysInterval?: number;
  weeksInterval?: number;
  monthsInterval?: number;
  triggerAtDay?: number[];
  triggerAtDayOfMonth?: number;
  triggerAtHour?: number;
  triggerAtMinute?: number;
  expression?: string;
}

const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Converts one rule to a croner pattern (6 fields, with seconds) plus an optional "every N weeks" filter. */
export function ruleToCron(rule: ScheduleRule): { pattern: string; everyWeeks?: number } {
  const minute = int(rule.triggerAtMinute, 0, 59, 0);
  const hour = int(rule.triggerAtHour, 0, 23, 0);
  switch (rule.field ?? 'days') {
    case 'seconds':
      return { pattern: `*/${int(rule.secondsInterval, 1, 59, 30)} * * * * *` };
    case 'minutes':
      return { pattern: `0 */${int(rule.minutesInterval, 1, 59, 5)} * * * *` };
    case 'hours':
      return { pattern: `0 ${minute} */${int(rule.hoursInterval, 1, 23, 1)} * * *` };
    case 'days':
      return { pattern: `0 ${minute} ${hour} */${int(rule.daysInterval, 1, 31, 1)} * *` };
    case 'weeks': {
      const days = (Array.isArray(rule.triggerAtDay) && rule.triggerAtDay.length ? rule.triggerAtDay : [1]).map((d) => int(d, 0, 6, 1));
      return { pattern: `0 ${minute} ${hour} * * ${[...new Set(days)].sort().join(',')}`, everyWeeks: int(rule.weeksInterval, 1, 52, 1) };
    }
    case 'months':
      return { pattern: `0 ${minute} ${hour} ${int(rule.triggerAtDayOfMonth, 1, 31, 1)} */${int(rule.monthsInterval, 1, 12, 1)} *` };
    case 'cronExpression': {
      const expression = String(rule.expression ?? '').trim();
      if (!expression) throw new NodeOperationError('The cron expression is empty', { hint: 'Example: "0 9 * * 1-5" = 9:00 on weekdays.' });
      return { pattern: expression };
    }
    default:
      throw new NodeOperationError(`Unknown schedule interval "${String(rule.field)}"`);
  }
}

/** Checks every rule (pattern + timezone) and returns them. Throws a readable error if one is invalid. */
export function compileRules(parameters: JsonObject, timezone: string): Array<{ pattern: string; everyWeeks?: number }> {
  const rules = ((parameters.rule as { interval?: ScheduleRule[] } | undefined)?.interval ?? []).filter(Boolean);
  if (rules.length === 0) throw new NodeOperationError('Add at least one trigger rule');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new NodeOperationError(`Unknown timezone "${timezone}"`, { hint: 'Pick a timezone in the workflow settings, e.g. Europe/Paris.' });
  }
  return rules.map((rule) => {
    const compiled = ruleToCron(rule);
    try {
      new Cron(compiled.pattern, { paused: true, timezone }).stop();
    } catch (err) {
      throw new NodeOperationError(`Invalid ${rule.field === 'cronExpression' ? 'cron expression' : 'schedule'} "${compiled.pattern}": ${(err as Error).message}`, {
        hint: 'Cron format: [seconds] minutes hours day-of-month month day-of-week, e.g. "*/10 * * * * *" = every 10 seconds.',
      });
    }
    return compiled;
  });
}

/** The item a Schedule Trigger emits (same fields as n8n). */
export function scheduleItem(timezone: string): JsonObject {
  const dt = DateTime.now().setZone(timezone);
  return {
    timestamp: dt.toISO(),
    'Readable date': dt.toFormat('MMMM d yyyy, h:mm:ss a'),
    'Readable time': dt.toFormat('h:mm:ss a'),
    'Day of week': dt.toFormat('cccc'),
    Year: dt.toFormat('yyyy'),
    Month: dt.toFormat('MMMM'),
    'Day of month': dt.toFormat('dd'),
    Hour: dt.toFormat('HH'),
    Minute: dt.toFormat('mm'),
    Second: dt.toFormat('ss'),
    Timezone: `${timezone} (UTC${dt.toFormat('ZZ')})`,
  };
}

/** ISO week number since the Unix epoch (used for "every N weeks"). */
export const weekNumber = (date: Date) => Math.floor((date.getTime() / 86_400_000 + 3) / 7);
