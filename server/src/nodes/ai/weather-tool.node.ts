import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { toNodeError } from '../../integrations/errors.js';
import { forecast, geocode, placeLabel, toWeatherOutput, WIND_SPEED_UNITS, TEMPERATURE_UNITS, type CallOptions } from '../../integrations/open-meteo.js';
import { toolIdentity, toolIdentityProperties } from '../_shared/ai-tool.js';

// Weather tool for the AI Agent. Uses the Open-Meteo client of the Weather node (no API key).
// Docs: https://open-meteo.com/en/docs and https://open-meteo.com/en/docs/geocoding-api

const DEFAULT_NAME = 'get_weather';
const DEFAULT_DESCRIPTION =
  'Gets the current weather and the daily forecast (1 to 7 days) for a city. Pass the city name, optionally followed by ' +
  'the country ("Paris, France"). Use it whenever the user asks about the weather, temperature, rain or wind somewhere.';

const clampDays = (value: unknown): number => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 7) : 3;
};

export default defineNode({
  description: {
    type: 'flowforge.weatherTool',
    displayName: 'Weather Tool',
    description: 'Lets the AI Agent look up the weather of any city (Open-Meteo, free, no API key).',
    icon: 'lucide:cloud-sun',
    group: 'ai-sub',
    version: 1,
    defaults: { name: 'Weather Tool', color: '#38bdf8' },
    subtitle: '{{toolName}}',
    inputs: [],
    outputs: [{ type: 'ai_tool' }],
    keywords: ['weather', 'forecast', 'temperature', 'rain', 'open-meteo', 'tool', 'agent', 'ai'],
  },
  properties: [
    ...toolIdentityProperties(DEFAULT_NAME, DEFAULT_DESCRIPTION),
    {
      name: 'temperatureUnit',
      displayName: 'Temperature Unit',
      type: 'options',
      default: 'celsius',
      options: [
        { name: 'Celsius (°C)', value: 'celsius' },
        { name: 'Fahrenheit (°F)', value: 'fahrenheit' },
      ],
    },
    {
      name: 'windSpeedUnit',
      displayName: 'Wind Speed Unit',
      type: 'options',
      default: 'kmh',
      options: [
        { name: 'km/h', value: 'kmh' },
        { name: 'm/s', value: 'ms' },
        { name: 'mph', value: 'mph' },
        { name: 'Knots', value: 'kn' },
      ],
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'forecastUrl', displayName: 'Forecast URL', type: 'string', default: '', placeholder: 'https://api.open-meteo.com/v1/forecast', description: 'Only for a self-hosted Open-Meteo. Empty: the public server.' },
        { name: 'geocodingUrl', displayName: 'Geocoding URL', type: 'string', default: '', placeholder: 'https://geocoding-api.open-meteo.com/v1/search', description: 'Only for a self-hosted Open-Meteo. Empty: the public server.' },
        { name: 'timeout', displayName: 'Timeout (Seconds)', type: 'number', default: 15, typeOptions: { minValue: 1, maxValue: 120 } },
      ],
    },
  ],
  supplyData(ctx, itemIndex) {
    const { name, description } = toolIdentity(ctx, itemIndex, DEFAULT_NAME, DEFAULT_DESCRIPTION);
    const temperatureUnit = String(ctx.getNodeParameter('temperatureUnit', itemIndex, 'celsius') || 'celsius');
    const windSpeedUnit = String(ctx.getNodeParameter('windSpeedUnit', itemIndex, 'kmh') || 'kmh');
    if (!TEMPERATURE_UNITS.includes(temperatureUnit)) throw new NodeOperationError(`Temperature unit "${temperatureUnit}" is not supported`, { itemIndex, hint: `Use one of: ${TEMPERATURE_UNITS.join(', ')}.` });
    if (!WIND_SPEED_UNITS.includes(windSpeedUnit)) throw new NodeOperationError(`Wind speed unit "${windSpeedUnit}" is not supported`, { itemIndex, hint: `Use one of: ${WIND_SPEED_UNITS.join(', ')}.` });
    const options = ctx.getNodeParameter<JsonObject>('options', itemIndex, {});
    const forecastUrl = String(options.forecastUrl ?? '').trim() || undefined;
    const geocodingUrl = String(options.geocodingUrl ?? '').trim() || undefined;
    const timeoutMs = Math.min(Math.max(Number(options.timeout ?? 15) || 15, 1), 120) * 1000;

    return {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name, optionally with the country, e.g. "Paris" or "Paris, France".' },
          days: { type: 'integer', description: 'Number of forecast days, from 1 to 7 (default 3).', minimum: 1, maximum: 7 },
        },
        required: ['city'],
      },
      invoke: async (args, { signal }) => {
        const city = typeof args.city === 'string' ? args.city.trim() : '';
        if (!city) throw new Error('The city is empty: give a city name such as "Paris"');
        const call: CallOptions = { signal, timeoutMs };
        try {
          const [place] = await geocode(city, { count: 10, language: 'en', baseUrl: geocodingUrl }, call);
          if (!place) throw new Error(`No place found for "${city}"`);
          const raw = await forecast(
            { latitude: place.latitude, longitude: place.longitude, current: true, daily: true, forecastDays: clampDays(args.days), temperatureUnit, windSpeedUnit, timezone: 'auto', baseUrl: forecastUrl },
            call,
          );
          const weather = toWeatherOutput(place, raw);
          const current = weather.current;
          return {
            location: placeLabel(weather.location),
            summary: weather.summary,
            current: current
              ? { temperature: current.temperature, feelsLike: current.feelsLike, description: current.description, windSpeed: current.windSpeed, humidity: current.humidity }
              : null,
            daily: (weather.daily ?? []).map((d) => ({
              date: d.date,
              description: d.description,
              temperatureMin: d.temperatureMin,
              temperatureMax: d.temperatureMax,
              precipitationProbability: d.precipitationProbability,
            })),
            units: { temperature: weather.units.temperature, windSpeed: weather.units.windSpeed },
            attribution: weather.attribution,
          };
        } catch (err) {
          throw toNodeError(err);
        }
      },
    };
  },
});
