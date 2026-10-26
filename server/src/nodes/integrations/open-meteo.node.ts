import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode, type ExecuteContext } from '../../engine/types.js';
import { geocode, forecast, placeLabel, PRECIPITATION_UNITS, TEMPERATURE_UNITS, toWeatherOutput, WIND_SPEED_UNITS, type CallOptions, type Place } from '../../integrations/open-meteo.js';
import { toNodeError } from '../../integrations/errors.js';

// Weather (Open-Meteo): no API key. Docs: https://open-meteo.com/en/docs and https://open-meteo.com/en/docs/geocoding-api

const BLOCKS = ['current', 'daily', 'hourly'] as const;

function blocksOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return list.map((v) => String(v).trim()).filter((v) => (BLOCKS as readonly string[]).includes(v));
}

/** Integer in [min, max] or a NodeOperationError (thrown before any network call). */
function intIn(ctx: ExecuteContext, name: string, label: string, i: number, fallback: number, min: number, max: number): number {
  const raw = ctx.getNodeParameter<unknown>(name, i, fallback);
  const n = typeof raw === 'string' && raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new NodeOperationError(`${label} must be a whole number from ${min} to ${max} (got "${String(raw)}")`, { itemIndex: i, hint: `Open-Meteo accepts ${min} to ${max}.` });
  }
  return n;
}

function coordinate(ctx: ExecuteContext, name: 'latitude' | 'longitude', i: number): number {
  const limit = name === 'latitude' ? 90 : 180;
  const raw = ctx.getNodeParameter<unknown>(name, i, '');
  const n = typeof raw === 'string' && raw.trim() === '' ? Number.NaN : Number(raw);
  const label = name === 'latitude' ? 'Latitude' : 'Longitude';
  if (!Number.isFinite(n)) throw new NodeOperationError(`${label} is empty or not a number`, { itemIndex: i, hint: `Enter a number from -${limit} to ${limit}, for example ${name === 'latitude' ? '48.85' : '2.35'}.` });
  if (n < -limit || n > limit) throw new NodeOperationError(`${label} must be between -${limit} and ${limit} (got ${n})`, { itemIndex: i, hint: name === 'latitude' ? 'Latitude goes from -90 (south pole) to 90 (north pole). Did you swap latitude and longitude?' : 'Longitude goes from -180 (west) to 180 (east).' });
  return n;
}

function oneOf(ctx: ExecuteContext, name: string, label: string, i: number, allowed: string[], fallback: string): string {
  const v = String(ctx.getNodeParameter(name, i, fallback) || fallback);
  if (!allowed.includes(v)) throw new NodeOperationError(`${label} "${v}" is not supported`, { itemIndex: i, hint: `Use one of: ${allowed.join(', ')}.` });
  return v;
}

function cityOf(ctx: ExecuteContext, i: number, parameter: 'city' | 'query' = 'city'): string {
  const city = String(ctx.getNodeParameter(parameter, i, '') ?? '').trim();
  if (!city) throw new NodeOperationError(parameter === 'query' ? 'The place name is empty' : 'The city is empty', {
      itemIndex: i,
      hint: parameter === 'query' ? 'Enter a place name such as "Paris", or use an expression such as {{ $json.city }}.' : 'Enter a city such as "Paris" or "Paris, France", or use an expression such as {{ $json.city }}. You can also switch "Location" to coordinates.',
    });
  if (city.length < 2) throw new NodeOperationError(`"${city}" is too short to search`, { itemIndex: i, hint: 'Open-Meteo needs at least 2 characters. Type the full city name.' });
  return city;
}

function notFound(city: string, i: number): NodeOperationError {
  return new NodeOperationError(`No place found for "${city}"`, {
    itemIndex: i,
    hint: 'Check the spelling, add the country ("Paris, France"), or switch "Location" to coordinates (latitude and longitude).',
  });
}

export default defineNode({
  description: {
    type: 'flowforge.openMeteo',
    displayName: 'Weather (Open-Meteo)',
    description: 'Current weather and forecast for any city or coordinates, or search a place. Free, no API key.',
    icon: 'lucide:cloud-sun',
    group: 'integration',
    version: 1,
    defaults: { name: 'Weather', color: '#38bdf8' },
    // The canvas only fills simple {{parameter}} placeholders (web/src/lib/node-types.ts resolveSubtitle).
    subtitle: '{{operation}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['weather', 'forecast', 'temperature', 'rain', 'meteo', 'open-meteo', 'geocoding', 'city', 'wind'],
  },
  properties: [
    {
      name: 'operation',
      displayName: 'Operation',
      type: 'options',
      default: 'getWeather',
      options: [
        { name: 'Get Weather', value: 'getWeather', description: 'Current weather and forecast for a place' },
        { name: 'Search Location', value: 'searchLocation', description: 'Find places (coordinates, country, time zone) by name' },
      ],
    },
    {
      name: 'locationMode',
      displayName: 'Location',
      type: 'options',
      default: 'city',
      options: [
        { name: 'City Name', value: 'city' },
        { name: 'Coordinates', value: 'coordinates' },
      ],
      displayOptions: { show: { operation: ['getWeather'] } },
    },
    {
      name: 'city',
      displayName: 'City',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'Paris or Paris, France',
      description: 'City name, optionally followed by the country: "Paris, France".',
      displayOptions: { show: { operation: ['getWeather'], locationMode: ['city'] } },
    },
    {
      name: 'query',
      displayName: 'Place Name',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'Paris',
      description: 'Name of the place to search, optionally with the country or region: "Paris, Texas".',
      displayOptions: { show: { operation: ['searchLocation'] } },
    },
    {
      name: 'latitude',
      displayName: 'Latitude',
      type: 'number',
      default: 48.85,
      description: 'From -90 to 90.',
      typeOptions: { minValue: -90, maxValue: 90 },
      displayOptions: { show: { operation: ['getWeather'], locationMode: ['coordinates'] } },
    },
    {
      name: 'longitude',
      displayName: 'Longitude',
      type: 'number',
      default: 2.35,
      description: 'From -180 to 180.',
      typeOptions: { minValue: -180, maxValue: 180 },
      displayOptions: { show: { operation: ['getWeather'], locationMode: ['coordinates'] } },
    },
    {
      name: 'limit',
      displayName: 'Limit',
      type: 'number',
      default: 5,
      typeOptions: { minValue: 1, maxValue: 100 },
      description: 'Maximum number of places returned.',
      displayOptions: { show: { operation: ['searchLocation'] } },
    },
    {
      name: 'include',
      displayName: 'Include',
      type: 'multiOptions',
      default: ['current', 'daily'],
      options: [
        { name: 'Current Weather', value: 'current' },
        { name: 'Daily Forecast', value: 'daily' },
        { name: 'Hourly Forecast', value: 'hourly' },
      ],
      description: 'Only the blocks you choose are requested and returned.',
      displayOptions: { show: { operation: ['getWeather'] } },
    },
    {
      name: 'forecastDays',
      displayName: 'Forecast Days',
      type: 'number',
      default: 3,
      typeOptions: { minValue: 1, maxValue: 16 },
      description: 'Number of days (1 to 16).',
      displayOptions: { show: { operation: ['getWeather'], include: ['daily', 'hourly'] } },
    },
    {
      name: 'hourlyHours',
      displayName: 'Hourly Hours',
      type: 'number',
      default: 24,
      typeOptions: { minValue: 1, maxValue: 168 },
      description: 'Number of hours in the hourly forecast (1 to 168).',
      displayOptions: { show: { operation: ['getWeather'], include: ['hourly'] } },
    },
    {
      name: 'temperatureUnit',
      displayName: 'Temperature Unit',
      type: 'options',
      default: 'celsius',
      options: [
        { name: 'Celsius (°C)', value: 'celsius' },
        { name: 'Fahrenheit (°F)', value: 'fahrenheit' },
      ],
      displayOptions: { show: { operation: ['getWeather'] } },
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
      displayOptions: { show: { operation: ['getWeather'] } },
    },
    {
      name: 'precipitationUnit',
      displayName: 'Precipitation Unit',
      type: 'options',
      default: 'mm',
      options: [
        { name: 'Millimeters', value: 'mm' },
        { name: 'Inches', value: 'inch' },
      ],
      displayOptions: { show: { operation: ['getWeather'] } },
    },
    {
      name: 'timezone',
      displayName: 'Time Zone',
      type: 'string',
      default: 'auto',
      placeholder: 'auto or Europe/Paris',
      description: '"auto" uses the time zone of the place.',
      displayOptions: { show: { operation: ['getWeather'] } },
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'language', displayName: 'Language', type: 'string', default: 'en', description: 'Language of place names (fr, de, ar…).' },
        { name: 'countryCode', displayName: 'Country Code', type: 'string', default: '', placeholder: 'FR', description: 'Only search places in this country (2-letter ISO code).' },
        { name: 'forecastUrl', displayName: 'Forecast URL', type: 'string', default: '', placeholder: 'https://api.open-meteo.com/v1/forecast', description: 'Only for a self-hosted Open-Meteo. Empty: the public server.' },
        { name: 'geocodingUrl', displayName: 'Geocoding URL', type: 'string', default: '', placeholder: 'https://geocoding-api.open-meteo.com/v1/search', description: 'Only for a self-hosted Open-Meteo. Empty: the public server.' },
        { name: 'timeout', displayName: 'Timeout (Seconds)', type: 'number', default: 15, typeOptions: { minValue: 1, maxValue: 120 } },
      ],
    },
  ],
  async execute(ctx) {
    const items = await ctx.forEachItem(async (_item, i) => {
      const operation = String(ctx.getNodeParameter('operation', i, 'getWeather'));
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      const call: CallOptions = { signal: ctx.signal, timeoutMs: Math.min(Math.max(Number(options.timeout ?? 15) || 15, 1), 120) * 1000 };
      const language = String(options.language ?? '').trim() || 'en';
      const countryCode = String(options.countryCode ?? '').trim();
      if (countryCode && !/^[A-Za-z]{2}$/.test(countryCode)) {
        throw new NodeOperationError(`Country code "${countryCode}" is not valid`, { itemIndex: i, hint: 'Use the 2-letter ISO code, for example FR, DE, MA, US.' });
      }
      const geocodingUrl = String(options.geocodingUrl ?? '').trim() || undefined;
      const forecastUrl = String(options.forecastUrl ?? '').trim() || undefined;

      try {
        if (operation === 'searchLocation') {
          const city = cityOf(ctx, i, 'query');
          const limit = intIn(ctx, 'limit', 'Limit', i, 5, 1, 100);
          const places = await geocode(city, { count: limit, language, countryCode, baseUrl: geocodingUrl }, call);
          if (!places.length) throw notFound(city, i);
          return places.map((p) => ({
            json: {
              id: p.id ?? null,
              name: p.name,
              country: p.country ?? '',
              countryCode: p.countryCode ?? '',
              region: p.region ?? '',
              latitude: p.latitude,
              longitude: p.longitude,
              elevation: p.elevation ?? null,
              timezone: p.timezone ?? '',
              population: p.population ?? null,
            },
          }));
        }

        // getWeather: validate everything before the first network call.
        const mode = String(ctx.getNodeParameter('locationMode', i, 'city'));
        let city = '';
        let latitude = 0;
        let longitude = 0;
        if (mode === 'coordinates') {
          latitude = coordinate(ctx, 'latitude', i);
          longitude = coordinate(ctx, 'longitude', i);
        } else {
          city = cityOf(ctx, i);
        }
        const include = blocksOf(ctx.getNodeParameter<unknown>('include', i, ['current', 'daily']));
        if (!include.length) throw new NodeOperationError('Nothing to fetch: "Include" is empty', { itemIndex: i, hint: 'Choose at least one of Current Weather, Daily Forecast, Hourly Forecast.' });
        const wantsDaily = include.includes('daily');
        const wantsHourly = include.includes('hourly');
        const forecastDays = wantsDaily || wantsHourly ? intIn(ctx, 'forecastDays', 'Forecast Days', i, 3, 1, 16) : undefined;
        const forecastHours = wantsHourly ? intIn(ctx, 'hourlyHours', 'Hourly Hours', i, 24, 1, 168) : undefined;
        const temperatureUnit = oneOf(ctx, 'temperatureUnit', 'Temperature unit', i, TEMPERATURE_UNITS, 'celsius');
        const windSpeedUnit = oneOf(ctx, 'windSpeedUnit', 'Wind speed unit', i, WIND_SPEED_UNITS, 'kmh');
        const precipitationUnit = oneOf(ctx, 'precipitationUnit', 'Precipitation unit', i, PRECIPITATION_UNITS, 'mm');
        const timezone = String(ctx.getNodeParameter('timezone', i, 'auto') || 'auto').trim() || 'auto';

        let place: Pick<Place, 'name' | 'country' | 'countryCode' | 'region' | 'latitude' | 'longitude'>;
        if (mode === 'coordinates') {
          place = { name: `${latitude}, ${longitude}`, latitude, longitude };
        } else {
          const [found] = await geocode(city, { count: 10, language, countryCode, baseUrl: geocodingUrl }, call);
          if (!found) throw notFound(city, i);
          place = found;
        }

        const raw = await forecast(
          {
            latitude: place.latitude,
            longitude: place.longitude,
            current: include.includes('current'),
            daily: wantsDaily,
            hourly: wantsHourly,
            forecastDays,
            forecastHours,
            temperatureUnit,
            windSpeedUnit,
            precipitationUnit,
            timezone,
            baseUrl: forecastUrl,
          },
          call,
        );
        const weather = toWeatherOutput(place, raw);
        ctx.addLog(`Weather for ${placeLabel(weather.location)}`);
        return { json: weather as unknown as JsonObject };
      } catch (err) {
        throw toNodeError(err, { itemIndex: i });
      }
    });
    return [items];
  },
});
