import { Cron } from 'croner';
import type { NodeProperty } from '@flowforge/shared';
import { defineNode } from '../../engine/types.js';
import { compileRules, scheduleItem, weekNumber } from '../_shared/schedule.js';

const show = (...fields: string[]): NodeProperty['displayOptions'] => ({ show: { field: fields } });
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default defineNode({
  description: {
    type: 'flowforge.scheduleTrigger',
    displayName: 'Schedule Trigger',
    description: 'Starts the workflow at fixed intervals or times (cron supported).',
    icon: 'lucide:clock',
    group: 'trigger',
    version: 1,
    defaults: { name: 'Schedule Trigger', color: '#31c49f' },
    inputs: [],
    outputs: [{ type: 'main' }],
    trigger: { kind: 'schedule' },
    keywords: ['cron', 'timer', 'interval', 'every', 'daily', 'hourly'],
  },
  properties: [
    {
      name: 'rule',
      displayName: 'Trigger Rules',
      type: 'fixedCollection',
      typeOptions: { multipleValues: true },
      default: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 0 }] },
      options: [
        {
          name: 'interval',
          displayName: 'Trigger Interval',
          values: [
            {
              name: 'field',
              displayName: 'Trigger Interval',
              type: 'options',
              default: 'days',
              options: [
                { name: 'Seconds', value: 'seconds' },
                { name: 'Minutes', value: 'minutes' },
                { name: 'Hours', value: 'hours' },
                { name: 'Days', value: 'days' },
                { name: 'Weeks', value: 'weeks' },
                { name: 'Months', value: 'months' },
                { name: 'Custom (Cron)', value: 'cronExpression' },
              ],
            },
            { name: 'secondsInterval', displayName: 'Seconds Between Triggers', type: 'number', default: 30, typeOptions: { minValue: 1, maxValue: 59 }, displayOptions: show('seconds') },
            { name: 'minutesInterval', displayName: 'Minutes Between Triggers', type: 'number', default: 5, typeOptions: { minValue: 1, maxValue: 59 }, displayOptions: show('minutes') },
            { name: 'hoursInterval', displayName: 'Hours Between Triggers', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 23 }, displayOptions: show('hours') },
            { name: 'daysInterval', displayName: 'Days Between Triggers', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 31 }, displayOptions: show('days') },
            { name: 'weeksInterval', displayName: 'Weeks Between Triggers', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 52 }, displayOptions: show('weeks') },
            { name: 'monthsInterval', displayName: 'Months Between Triggers', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 12 }, displayOptions: show('months') },
            {
              name: 'triggerAtDay',
              displayName: 'Trigger on Weekdays',
              type: 'multiOptions',
              default: [1],
              options: WEEKDAYS.map((d, i) => ({ name: d, value: i })),
              displayOptions: show('weeks'),
            },
            { name: 'triggerAtDayOfMonth', displayName: 'Trigger at Day of Month', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 31 }, displayOptions: show('months') },
            { name: 'triggerAtHour', displayName: 'Trigger at Hour (0–23)', type: 'number', default: 0, typeOptions: { minValue: 0, maxValue: 23 }, displayOptions: show('days', 'weeks', 'months') },
            { name: 'triggerAtMinute', displayName: 'Trigger at Minute (0–59)', type: 'number', default: 0, typeOptions: { minValue: 0, maxValue: 59 }, displayOptions: show('hours', 'days', 'weeks', 'months') },
            {
              name: 'expression',
              displayName: 'Cron Expression',
              type: 'string',
              default: '',
              placeholder: 'e.g. 0 9 * * 1-5   or   */10 * * * * *',
              description: '5 fields (minute hour day month weekday) or 6 with seconds first.',
              displayOptions: show('cronExpression'),
            },
          ],
        },
      ],
    },
    {
      name: 'notice',
      displayName: 'Times use the workflow timezone (Workflow settings), or the server timezone by default.',
      type: 'notice',
      default: '',
    },
  ],
  validate(ctx) {
    compileRules({ rule: ctx.getNodeParameter('rule') }, ctx.timezone);
  },
  trigger(ctx) {
    const rules = compileRules({ rule: ctx.getNodeParameter('rule') }, ctx.timezone);
    const anchor = weekNumber(new Date());
    const jobs = rules.map(
      (rule) =>
        new Cron(rule.pattern, { timezone: ctx.timezone, protect: true, catch: (err) => ctx.emitError(err as Error) }, () => {
          if (rule.everyWeeks && rule.everyWeeks > 1 && (weekNumber(new Date()) - anchor) % rule.everyWeeks !== 0) return;
          ctx.emit([{ json: scheduleItem(ctx.timezone) }]);
        }),
    );
    return { close: () => jobs.forEach((job) => job.stop()) };
  },
  // Manual run / "Listen for test event": one tick right now.
  execute: (ctx) => [[{ json: scheduleItem(ctx.getTimezone()) }]],
});
