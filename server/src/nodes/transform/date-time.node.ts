import { DateTime, IANAZone, type DateTimeUnit, type DurationUnit } from 'luxon';
import type { JsonObject, NodeProperty } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';

const UNITS = ['years', 'quarters', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'] as const;
const ROUND_UNITS = ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'] as const;
const PARTS = ['year', 'quarter', 'month', 'week', 'day', 'weekday', 'hour', 'minute', 'second'] as const;
const FORMATS: [string, string][] = [
  ['Custom Format', 'custom'],
  ['MM/DD/YYYY (03/14/2026)', 'MM/dd/yyyy'],
  ['DD/MM/YYYY (14/03/2026)', 'dd/MM/yyyy'],
  ['YYYY-MM-DD (2026-03-14)', 'yyyy-MM-dd'],
  ['YYYY/MM/DD (2026/03/14)', 'yyyy/MM/dd'],
  ['MMMM DD YYYY (March 14 2026)', 'MMMM dd yyyy'],
  ['Day, date and time (Sat, 14 Mar 2026, 09:30)', 'ccc, d LLL yyyy, HH:mm'],
  ['Time (09:30)', 'HH:mm'],
  ['Unix Timestamp (seconds)', 'X'],
  ['Unix Ms Timestamp', 'x'],
];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const show = (...operation: string[]): NodeProperty['displayOptions'] => ({ show: { operation } });

/** Reads ISO, SQL, RFC 2822 and HTTP dates, timestamps (seconds or milliseconds) and anything `new Date()` accepts. */
export function parseDate(value: unknown, zone: string, fromFormat?: string): DateTime {
  const fail = (): never => {
    throw new NodeOperationError(`${JSON.stringify(value) ?? 'undefined'} is not a date FlowForge can read`, {
      hint: fromFormat
        ? `It does not match the format "${fromFormat}".`
        : 'Use an ISO date such as 2026-03-14 or 2026-03-14T09:30:00, a timestamp, or set "From Date Format" in the options.',
    });
  };
  if (value === undefined || value === null || value === '') return fail();
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone });
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d{9,}(\.\d+)?$/.test(value.trim()) && !fromFormat)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fail();
    // 10 digits = seconds, 13 digits = milliseconds.
    return DateTime.fromMillis(Math.abs(n) < 1e11 ? n * 1000 : n, { zone });
  }
  if (typeof value !== 'string') return fail();
  const text = value.trim();
  if (fromFormat) {
    const parsed = DateTime.fromFormat(text, fromFormat, { zone });
    return parsed.isValid ? parsed : fail();
  }
  const options = { zone, setZone: true };
  for (const parsed of [DateTime.fromISO(text, options), DateTime.fromSQL(text, options), DateTime.fromRFC2822(text, options), DateTime.fromHTTP(text, options)]) {
    if (parsed.isValid) return parsed;
  }
  const js = new Date(text);
  return Number.isNaN(js.getTime()) ? fail() : DateTime.fromJSDate(js, { zone });
}

function requireZone(zone: unknown): string {
  const name = String(zone ?? '').trim();
  if (!name || !IANAZone.isValidZone(name)) {
    throw new NodeOperationError(`"${name}" is not a time zone`, { hint: 'Use a name such as Europe/Paris, America/New_York, Asia/Tokyo or UTC.' });
  }
  return name;
}

const outputField = (name: string, fallback: string, operation: string[]): NodeProperty => ({
  name,
  displayName: 'Output Field Name',
  type: 'string',
  default: fallback,
  displayOptions: show(...operation),
});

export default defineNode({
  description: {
    type: 'flowforge.dateTime',
    displayName: 'Date & Time',
    description: 'Add or subtract time, format, compare, round or convert dates between time zones.',
    icon: 'lucide:calendar-clock',
    group: 'transform',
    version: 1,
    defaults: { name: 'Date & Time', color: '#9b6dd7' },
    subtitle: '{{operation}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['date', 'time', 'format', 'timezone', 'duration', 'luxon', 'calendar', 'now', 'today'],
  },
  properties: [
    {
      name: 'operation',
      displayName: 'Operation',
      type: 'options',
      default: 'formatDate',
      options: [
        { name: 'Add to a Date', value: 'addToDate' },
        { name: 'Subtract From a Date', value: 'subtractFromDate' },
        { name: 'Format a Date', value: 'formatDate' },
        { name: 'Get Time Between Dates', value: 'getTimeBetweenDates' },
        { name: 'Round a Date', value: 'roundDate' },
        { name: 'Extract Part of a Date', value: 'extractDate' },
        { name: 'Convert to Time Zone', value: 'setTimezone' },
        { name: 'Get Current Date', value: 'getCurrentDate' },
      ],
    },
    { name: 'magnitude', displayName: 'Date', type: 'string', default: '', placeholder: 'e.g. 2026-03-14 or {{ $json.createdAt }}', displayOptions: show('addToDate', 'subtractFromDate') },
    { name: 'timeUnit', displayName: 'Time Unit', type: 'options', default: 'days', options: UNITS.map((u) => ({ name: cap(u), value: u })), displayOptions: show('addToDate', 'subtractFromDate') },
    { name: 'duration', displayName: 'Duration', type: 'number', default: 1, description: 'How many units to add or subtract.', displayOptions: show('addToDate', 'subtractFromDate') },
    outputField('outputFieldName', 'newDate', ['addToDate', 'subtractFromDate']),

    { name: 'date', displayName: 'Date', type: 'string', default: '', placeholder: 'e.g. 2026-03-14 or {{ $json.createdAt }}', displayOptions: show('formatDate', 'roundDate', 'extractDate', 'setTimezone') },
    { name: 'format', displayName: 'Format', type: 'options', default: 'yyyy-MM-dd', options: FORMATS.map(([name, value]) => ({ name, value })), displayOptions: show('formatDate') },
    {
      name: 'customFormat',
      displayName: 'Custom Format',
      type: 'string',
      default: 'dd LLL yyyy, HH:mm',
      description: 'Luxon tokens: yyyy year, MM month, LLL month name, dd day, ccc weekday, HH hour, mm minute, ss second, ZZ offset.',
      displayOptions: { show: { operation: ['formatDate'], format: ['custom'] } },
    },
    outputField('formattedFieldName', 'formattedDate', ['formatDate']),

    { name: 'startDate', displayName: 'Start Date', type: 'string', default: '', placeholder: 'e.g. 2026-01-01', displayOptions: show('getTimeBetweenDates') },
    { name: 'endDate', displayName: 'End Date', type: 'string', default: '', placeholder: 'e.g. {{ $now }}', displayOptions: show('getTimeBetweenDates') },
    { name: 'units', displayName: 'Units', type: 'multiOptions', default: ['days'], options: UNITS.filter((u) => u !== 'quarters').map((u) => ({ name: cap(u), value: u })), displayOptions: show('getTimeBetweenDates') },
    outputField('differenceFieldName', 'timeDifference', ['getTimeBetweenDates']),

    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'roundDown',
      options: [
        { name: 'Round Down', value: 'roundDown' },
        { name: 'Round Up', value: 'roundUp' },
      ],
      displayOptions: show('roundDate'),
    },
    { name: 'toNearest', displayName: 'To Nearest', type: 'options', default: 'day', options: ROUND_UNITS.map((u) => ({ name: cap(u), value: u })), displayOptions: show('roundDate') },
    outputField('roundedFieldName', 'roundedDate', ['roundDate']),

    { name: 'part', displayName: 'Part', type: 'options', default: 'month', options: PARTS.map((u) => ({ name: u === 'weekday' ? 'Day of the Week (1 = Monday)' : u === 'week' ? 'Week Number' : cap(u), value: u })), displayOptions: show('extractDate') },
    outputField('partFieldName', 'datePart', ['extractDate']),

    { name: 'timezone', displayName: 'Time Zone', type: 'string', default: 'UTC', placeholder: 'e.g. Europe/Paris', displayOptions: show('setTimezone') },
    outputField('convertedFieldName', 'convertedDate', ['setTimezone']),

    { name: 'includeTime', displayName: 'Include Current Time', type: 'boolean', default: true, description: 'Off: the date at 00:00.', displayOptions: show('getCurrentDate') },
    outputField('currentFieldName', 'currentDate', ['getCurrentDate']),

    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'includeInputFields', displayName: 'Include Input Fields', type: 'boolean', default: true, description: 'Keep the fields of the input item next to the result.' },
        { name: 'timezone', displayName: 'Time Zone', type: 'string', default: '', placeholder: 'e.g. Europe/Paris', description: 'Zone used to read dates without an offset and to write the result (default: the workflow time zone).' },
        { name: 'fromFormat', displayName: 'From Date Format', type: 'string', default: '', placeholder: 'e.g. dd/MM/yyyy HH:mm', description: 'How to read the input date when it is not ISO (Luxon tokens).' },
        { name: 'isoString', displayName: 'Output As ISO Duration', type: 'boolean', default: false, description: 'Get Time Between Dates: return e.g. "P3DT4H" instead of numbers.' },
      ],
    },
  ],
  async execute(ctx) {
    const out = await ctx.forEachItem((item, i) => {
      const operation = String(ctx.getNodeParameter('operation', i, 'formatDate'));
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      const zone = options.timezone ? requireZone(options.timezone) : ctx.getTimezone();
      const fromFormat = String(options.fromFormat ?? '').trim() || undefined;
      const read = (name: string) => {
        try {
          return parseDate(ctx.getNodeParameter(name, i, ''), zone, fromFormat);
        } catch (err) {
          if (err instanceof NodeOperationError) err.itemIndex = i;
          throw err;
        }
      };
      const iso = (d: DateTime) => d.setZone(zone).toISO();
      const field = (name: string, fallback: string) => String(ctx.getNodeParameter(name, i, fallback) || fallback);
      let key: string;
      let value: unknown;

      switch (operation) {
        case 'addToDate':
        case 'subtractFromDate': {
          const amount = Number(ctx.getNodeParameter('duration', i, 1));
          if (!Number.isFinite(amount)) throw new NodeOperationError('Duration must be a number', { itemIndex: i });
          const unit = String(ctx.getNodeParameter('timeUnit', i, 'days'));
          const date = read('magnitude');
          key = field('outputFieldName', 'newDate');
          value = iso(operation === 'addToDate' ? date.plus({ [unit]: amount }) : date.minus({ [unit]: amount }));
          break;
        }
        case 'formatDate': {
          const chosen = String(ctx.getNodeParameter('format', i, 'yyyy-MM-dd'));
          const format = chosen === 'custom' ? String(ctx.getNodeParameter('customFormat', i, '')) : chosen;
          if (!format.trim()) throw new NodeOperationError('The custom format is empty', { itemIndex: i, hint: 'Example: dd LLL yyyy, HH:mm' });
          const text = read('date').setZone(zone).toFormat(format);
          key = field('formattedFieldName', 'formattedDate');
          value = format === 'X' || format === 'x' ? Number(text) : text;
          break;
        }
        case 'getTimeBetweenDates': {
          const units = ctx.getNodeParameter<string[]>('units', i, ['days']);
          const list = (Array.isArray(units) && units.length ? units : ['days']) as DurationUnit[];
          const duration = read('endDate').diff(read('startDate'), list);
          key = field('differenceFieldName', 'timeDifference');
          value = options.isoString === true ? duration.toISO() : Object.fromEntries(list.map((u) => [u, Math.round(duration.get(u) * 1000) / 1000]));
          break;
        }
        case 'roundDate': {
          const unit = String(ctx.getNodeParameter('toNearest', i, 'day')) as DateTimeUnit;
          const date = read('date').setZone(zone);
          const floor = date.startOf(unit);
          key = field('roundedFieldName', 'roundedDate');
          value = iso(ctx.getNodeParameter<string>('mode', i, 'roundDown') === 'roundUp' && floor.toMillis() !== date.toMillis() ? floor.plus({ [`${unit}s`]: 1 }) : floor);
          break;
        }
        case 'extractDate': {
          const part = String(ctx.getNodeParameter('part', i, 'month'));
          const date = read('date').setZone(zone);
          key = field('partFieldName', 'datePart');
          value = part === 'week' ? date.weekNumber : (date[part as 'year'] as number);
          break;
        }
        case 'setTimezone': {
          const target = requireZone(ctx.getNodeParameter('timezone', i, 'UTC'));
          key = field('convertedFieldName', 'convertedDate');
          value = read('date').setZone(target).toISO();
          break;
        }
        case 'getCurrentDate': {
          const now = DateTime.now().setZone(zone);
          key = field('currentFieldName', 'currentDate');
          value = (ctx.getNodeParameter<boolean>('includeTime', i, true) === false ? now.startOf('day') : now).toISO();
          break;
        }
        default:
          throw new NodeOperationError(`Unknown operation "${operation}"`);
      }
      return { json: { ...(options.includeInputFields === false ? {} : item.json), [key]: value as JsonObject[string] } };
    });
    return [out];
  },
});
