import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@flowforge/shared';
import { describeWeatherCode, geocode, forecast } from '../src/integrations/open-meteo.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { startOpenMeteoMock, type OpenMeteoMock } from './open-meteo-mock.js';
import { chain, node, signedIn, type Agent } from './trigger-helpers.js';

let t: TestApp;
let agent: Agent;
let mock: OpenMeteoMock;

beforeAll(async () => {
  mock = await startOpenMeteoMock();
  t = await makeTestApp();
  agent = await signedIn(t);
});
afterAll(async () => {
  await t?.close();
  await mock?.close();
});
beforeEach(() => mock.reset());

interface RunSummary {
  status: string;
  error?: { message: string; hint?: string; node?: string; itemIndex?: number };
  output: JsonObject[][];
}

/** Manual Trigger → (items) → Weather, run through the dev API. The options point to the local mock. */
async function weather(parameters: JsonObject, items: JsonObject[] = [{}], extra: JsonObject = {}, options: JsonObject = {}): Promise<RunSummary> {
  const nodes = [
    node('Start', 'manualTrigger'),
    node('Items', 'code', { jsCode: `return ${JSON.stringify(items)}.map((json) => ({ json }));` }),
    node('Weather', 'openMeteo', { options: { forecastUrl: mock.forecastUrl, geocodingUrl: mock.geocodingUrl, ...options }, ...parameters }, extra),
  ];
  const res = await agent.post('/api/dev/run').send({ name: 'Weather', nodes, connections: chain('Start', 'Items', 'Weather') });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as RunSummary;
}

const first = (run: RunSummary) => run.output[0]![0] as Record<string, any>;
const calls = () => mock.forecastRequests();

describe('Open-Meteo: get weather', () => {
  it('city: geocodes, then asks the forecast for the place and builds a readable summary', async () => {
    const run = await weather({ city: 'Paris, France' });
    expect(run.status).toBe('success');
    expect(mock.geocodingRequests()).toHaveLength(1);
    expect(mock.geocodingRequests()[0]!.query).toMatchObject({ name: 'Paris, France', language: 'en', format: 'json' });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.query).toMatchObject({ latitude: '48.85341', longitude: '2.3488', timezone: 'auto', temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm', forecast_days: '3' });

    const out = first(run);
    expect(out.location).toEqual({ name: 'Paris', country: 'France', countryCode: 'FR', region: 'Île-de-France', latitude: 48.9, longitude: 2.3, timezone: 'Europe/Paris', elevation: 38 });
    expect(out.current).toMatchObject({ time: '2026-10-12T14:00', temperature: 19.8, feelsLike: 18.4, humidity: 62, precipitation: 0.2, cloudCover: 55, windSpeed: 10.8, windDirection: 240, windGusts: 25.9, isDay: true, weatherCode: 2, description: 'Partly cloudy', emoji: '⛅' });
    expect(out.daily).toHaveLength(3);
    expect(out.daily[0]).toEqual({
      date: '2026-10-12',
      weatherCode: 2,
      description: 'Partly cloudy',
      emoji: '⛅',
      temperatureMax: 20.6,
      temperatureMin: 12.1,
      feelsLikeMax: 19.5,
      feelsLikeMin: 11.2,
      sunrise: '2026-10-12T08:01',
      sunset: '2026-10-12T19:12',
      uvIndexMax: 3.4,
      precipitationSum: 1.3,
      precipitationProbability: 20,
      windSpeedMax: 18.2,
    });
    expect(out.daily[2].date).toBe('2026-10-14');
    expect(out.hourly).toBeUndefined();
    expect(out.units).toEqual({ temperature: '°C', windSpeed: 'km/h', precipitation: 'mm' });
    expect(out.summary).toBe('Paris, France: ⛅ Partly cloudy, 19.8 °C (feels like 18.4 °C), wind 11 km/h. Today 12.1 to 20.6 °C, rain 20 %.');
    expect(out.attribution).toBe('Weather data by Open-Meteo.com (CC BY 4.0)');
  });

  it('coordinates skip the geocoding call', async () => {
    const run = await weather({ locationMode: 'coordinates', latitude: 48.85, longitude: 2.35 });
    expect(run.status).toBe('success');
    expect(mock.geocodingRequests()).toHaveLength(0);
    expect(calls()[0]!.query).toMatchObject({ latitude: '48.85', longitude: '2.35' });
    expect(first(run).location).toMatchObject({ name: '48.85, 2.35', country: '', latitude: 48.9, longitude: 2.4 });
    expect(first(run).summary).toMatch(/^48\.85, 2\.35: ⛅ Partly cloudy, 19\.8 °C/);
  });

  it.each([
    [['current'], { current: true, daily: false, hourly: false }],
    [['daily'], { current: false, daily: true, hourly: false }],
    [['hourly'], { current: false, daily: false, hourly: true }],
    [['current', 'hourly'], { current: true, daily: false, hourly: true }],
    [['current', 'daily', 'hourly'], { current: true, daily: true, hourly: true }],
  ])('include %j requests and returns only those blocks', async (include, expected) => {
    const run = await weather({ locationMode: 'coordinates', latitude: 48.85, longitude: 2.35, include, forecastDays: 2, hourlyHours: 12 });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    const query = calls()[0]!.query;
    expect('current' in query).toBe(expected.current);
    expect('daily' in query).toBe(expected.daily);
    expect('hourly' in query).toBe(expected.hourly);
    expect('forecast_days' in query).toBe(expected.daily || expected.hourly);
    expect(query.forecast_hours).toBe(expected.hourly ? '12' : undefined);
    const out = first(run);
    expect(out.current !== undefined).toBe(expected.current);
    expect(out.daily !== undefined).toBe(expected.daily);
    expect(out.hourly !== undefined).toBe(expected.hourly);
    if (expected.hourly) {
      expect(out.hourly).toHaveLength(12);
      expect(out.hourly[0]).toEqual({ time: '2026-10-12T00:00', temperature: 17.5, feelsLike: 16.9, humidity: 70, precipitationProbability: 10, precipitation: 0, weatherCode: 2, description: 'Partly cloudy', emoji: '⛅', windSpeed: 9.4, isDay: false });
      expect(out.hourly[9].isDay).toBe(true);
    }
    if (expected.daily) expect(out.daily).toHaveLength(2);
    expect(out.summary.length).toBeGreaterThan(10);
  });

  it('daily only: the summary describes the day', async () => {
    const run = await weather({ locationMode: 'coordinates', latitude: 1, longitude: 2, include: ['daily'] });
    expect(first(run).summary).toBe('1, 2: ⛅ Partly cloudy, today 12.1 to 20.6 °C, rain 20 %.');
  });

  it('units and time zone are sent, and reflected in the output and the summary', async () => {
    const run = await weather({ city: 'Paris', temperatureUnit: 'fahrenheit', windSpeedUnit: 'mph', precipitationUnit: 'inch', timezone: 'America/New_York' });
    expect(run.status).toBe('success');
    expect(calls()[0]!.query).toMatchObject({ temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch', timezone: 'America/New_York' });
    const out = first(run);
    expect(out.units).toEqual({ temperature: '°F', windSpeed: 'mp/h', precipitation: 'inch' });
    expect(out.location.timezone).toBe('America/New_York');
    expect(out.current.temperature).toBe(67.6);
    expect(out.summary).toBe('Paris, France: ⛅ Partly cloudy, 67.6 °F (feels like 65.1 °F), wind 7 mp/h. Today 53.8 to 69.1 °F, rain 20 %.');
  });

  it('night variant: clear sky at night is a moon', async () => {
    mock.data.weatherCode = 0;
    mock.data.isDay = 0;
    const run = await weather({ locationMode: 'coordinates', latitude: 48, longitude: 2, include: ['current'] });
    expect(first(run).current).toMatchObject({ isDay: false, weatherCode: 0, description: 'Clear sky', emoji: '🌙' });
    expect(first(run).summary).toMatch(/^48, 2: 🌙 Clear sky, 19\.8 °C/);
    mock.data.isDay = 1;
    const day = await weather({ locationMode: 'coordinates', latitude: 48, longitude: 2, include: ['current'] });
    expect(first(day).current).toMatchObject({ isDay: true, emoji: '☀️' });
  });

  it('an unknown weather code does not break anything', async () => {
    mock.data.weatherCode = 1234;
    const run = await weather({ locationMode: 'coordinates', latitude: 48, longitude: 2, include: ['current', 'daily'] });
    expect(run.status).toBe('success');
    expect(first(run).current).toMatchObject({ weatherCode: 1234, description: 'Unknown (code 1234)', emoji: '🌡️' });
    expect(first(run).summary).toContain('🌡️ Unknown (code 1234)');
  });

  it('"Paris, Texas" is sent as typed and the API picks the place; an unmatched qualifier is "not found"', async () => {
    const texas = await weather({ city: ' Paris, Texas ', include: ['current'] });
    expect(mock.geocodingRequests()[0]!.query.name).toBe('Paris, Texas');
    expect(first(texas).location).toMatchObject({ country: 'United States', region: 'Texas', countryCode: 'US' });
    expect(calls()[0]!.query.latitude).toBe('33.66094');
    const nope = await weather({ city: 'Paris, Germany' });
    expect(nope.status).toBe('error');
    expect(nope.error!.message).toBe('No place found for "Paris, Germany"');
  });

  it('options: language, country code and timeout reach the geocoding call', async () => {
    const run = await weather({ city: 'Paris', include: ['current'] }, [{}], {}, { language: 'fr', countryCode: 'us' });
    expect(run.status).toBe('success');
    expect(mock.geocodingRequests()[0]!.query).toMatchObject({ language: 'fr', countryCode: 'US' });
    expect(first(run).location.country).toBe('United States');
  });

  it('the city can be an expression', async () => {
    const run = await weather({ city: '={{ $json.city }}', include: ['current'] }, [{ city: 'Lyon' }, { city: 'Casablanca' }]);
    expect(run.output[0]!.map((o) => (o.location as JsonObject).name)).toEqual(['Lyon', 'Casablanca']);
  });
});

describe('Open-Meteo: search location', () => {
  it('returns one item per place', async () => {
    const run = await weather({ operation: 'searchLocation', query: 'Paris', limit: 5 });
    expect(run.status).toBe('success');
    expect(mock.forecastRequests()).toHaveLength(0);
    expect(mock.geocodingRequests()[0]!.query.count).toBe('5');
    expect(run.output[0]).toHaveLength(2);
    expect(run.output[0]![0]).toEqual({ id: 2988507, name: 'Paris', country: 'France', countryCode: 'FR', region: 'Île-de-France', latitude: 48.85341, longitude: 2.3488, elevation: 42, timezone: 'Europe/Paris', population: 2138551 });
    expect(run.output[0]![1]).toMatchObject({ country: 'United States', region: 'Texas' });
  });

  it('limit is respected and an unknown name is a clear error', async () => {
    const one = await weather({ operation: 'searchLocation', query: 'Paris', limit: 1 });
    expect(one.output[0]).toHaveLength(1);
    const none = await weather({ operation: 'searchLocation', query: 'Xyzzy' });
    expect(none.status).toBe('error');
    expect(none.error!.message).toBe('No place found for "Xyzzy"');
  });
});

describe('Open-Meteo: errors', () => {
  it('city not found (HTTP 200 without "results") is a helpful error, not a crash', async () => {
    const run = await weather({ city: 'Xyzzy' });
    expect(run.status).toBe('error');
    expect(run.error).toMatchObject({ message: 'No place found for "Xyzzy"', node: 'Weather', itemIndex: 0 });
    expect(run.error!.hint).toMatch(/spelling/);
    expect(run.error!.hint).toMatch(/country/);
    expect(run.error!.hint).toMatch(/coordinates/);
    expect(calls()).toHaveLength(0);
  });

  it('parameter problems are reported before any network call', async () => {
    const cases: [JsonObject, RegExp][] = [
      [{ city: '' }, /The city is empty/],
      [{ city: '   ' }, /The city is empty/],
      [{ city: 'P' }, /too short/],
      [{ city: 'Paris', include: [] }, /"Include" is empty/],
      [{ city: 'Paris', forecastDays: 0 }, /Forecast Days must be a whole number from 1 to 16/],
      [{ city: 'Paris', forecastDays: 17 }, /Forecast Days must be a whole number from 1 to 16/],
      [{ city: 'Paris', include: ['hourly'], hourlyHours: 169 }, /Hourly Hours must be a whole number from 1 to 168/],
      [{ locationMode: 'coordinates', latitude: 91, longitude: 2 }, /Latitude must be between -90 and 90 \(got 91\)/],
      [{ locationMode: 'coordinates', latitude: 948.85, longitude: 2 }, /Latitude must be between -90 and 90/],
      [{ locationMode: 'coordinates', latitude: 10, longitude: -181 }, /Longitude must be between -180 and 180/],
      [{ locationMode: 'coordinates', latitude: '', longitude: 2 }, /Latitude is empty or not a number/],
      [{ city: 'Paris', temperatureUnit: 'kelvin' }, /Temperature unit "kelvin" is not supported/],
    ];
    for (const [params, message] of cases) {
      const run = await weather(params);
      expect(run.status, JSON.stringify(params)).toBe('error');
      expect(run.error!.message, JSON.stringify(params)).toMatch(message);
      expect(run.error!.hint, JSON.stringify(params)).toBeTruthy();
    }
    expect(mock.requests).toHaveLength(0);
  });

  it('a 400 from the API shows its reason', async () => {
    mock.override.forecast = { status: 400, body: { error: true, reason: 'Latitude must be in range of -90 to 90°. Given: 948.85.' } };
    const run = await weather({ locationMode: 'coordinates', latitude: 10, longitude: 10 });
    expect(run.status).toBe('error');
    expect(run.error!.message).toBe('Latitude must be in range of -90 to 90°. Given: 948.85.');
  });

  it('429: too many requests', async () => {
    mock.override.forecast = { status: 429, body: { error: true, reason: 'Too many requests' }, headers: { 'retry-after': '30' } };
    const run = await weather({ locationMode: 'coordinates', latitude: 10, longitude: 10 });
    expect(run.status).toBe('error');
    expect(run.error!.message).toBe('Open-Meteo says there are too many requests');
    expect(run.error!.hint).toMatch(/Retry On Fail/);
    await expect(forecast({ latitude: 1, longitude: 1, current: true, baseUrl: mock.forecastUrl })).rejects.toMatchObject({ status: 429, retryAfterMs: 30000 });
  });

  it('500: a server problem', async () => {
    mock.override.geocoding = { status: 500, body: 'Internal Server Error' };
    const run = await weather({ city: 'Paris' });
    expect(run.status).toBe('error');
    expect(run.error!.message).toBe('Open-Meteo has a problem (HTTP 500)');
    expect(run.error!.hint).toMatch(/try again/);
  });

  it('timeout: no answer within the configured time', async () => {
    mock.override.forecast = { status: 200, body: {}, delayMs: 2500 };
    const run = await weather({ locationMode: 'coordinates', latitude: 10, longitude: 10 }, [{}], {}, { timeout: 1 });
    expect(run.status).toBe('error');
    expect(run.error!.message).toMatch(/No answer from 127\.0\.0\.1:\d+ within 1 s/);
  });

  it('malformed answers (not JSON, wrong shape) are clear errors', async () => {
    mock.override.forecast = { status: 200, body: '<html>maintenance</html>' };
    const html = await weather({ locationMode: 'coordinates', latitude: 10, longitude: 10 });
    expect(html.status).toBe('error');
    expect(html.error!.message).toMatch(/not valid JSON/);
    expect(html.error!.hint).toMatch(/Forecast URL/);

    mock.override.forecast = { status: 200, body: { latitude: 1, longitude: 2 } };
    const noCurrent = await weather({ locationMode: 'coordinates', latitude: 10, longitude: 10, include: ['current'] });
    expect(noCurrent.error!.message).toBe('Open-Meteo sent a forecast without the current weather');

    mock.override.geocoding = { status: 200, body: '{{{' };
    const geo = await weather({ city: 'Paris' });
    expect(geo.error!.message).toMatch(/not valid JSON/);
  });

  it('per-item errors follow "On Error"', async () => {
    const items = [{ city: 'Lyon' }, { city: 'Xyzzy' }, { city: 'Casablanca' }];
    const params = { city: '={{ $json.city }}', include: ['current'] };

    const stop = await weather(params, items);
    expect(stop.status).toBe('error');
    expect(stop.error).toMatchObject({ message: 'No place found for "Xyzzy"', itemIndex: 1 });

    const keepGoing = await weather(params, items, { onError: 'continueRegularOutput' });
    expect(keepGoing.status).toBe('success');
    expect(keepGoing.output[0]).toHaveLength(3);
    expect(keepGoing.output[0]!.map((o) => (o.error ? 'error' : (o.location as JsonObject).name))).toEqual(['Lyon', 'error', 'Casablanca']);
    expect(keepGoing.output[0]![1]).toEqual({ error: 'No place found for "Xyzzy"' });

    const errorOutput = await weather(params, items, { onError: 'continueErrorOutput' });
    expect(errorOutput.output[0]).toHaveLength(2);
    expect(errorOutput.output[1]).toHaveLength(1);
  });
});

describe('Open-Meteo client', () => {
  it('geocode: no match returns an empty list (no throw); a 1-letter name makes no request', async () => {
    expect(await geocode('Xyzzy', { baseUrl: mock.geocodingUrl })).toEqual([]);
    expect(mock.requests).toHaveLength(1);
    expect(await geocode('P', { baseUrl: mock.geocodingUrl })).toEqual([]);
    expect(await geocode('  P ', { baseUrl: mock.geocodingUrl })).toEqual([]);
    expect(mock.requests).toHaveLength(1);
  });

  it('a base URL without a path gets the default endpoint path', async () => {
    const origin = new URL(mock.geocodingUrl).origin;
    expect((await geocode('Lyon', { baseUrl: origin })).map((p) => p.name)).toEqual(['Lyon']);
    expect((await forecast({ latitude: 1, longitude: 1, current: true, baseUrl: origin })).latitude).toBe(1);
  });

  it('geocode sends the typed text unchanged', async () => {
    expect((await geocode('Casablanca, Morocco', { baseUrl: mock.geocodingUrl })).map((p) => p.countryCode)).toEqual(['MA']);
    expect(mock.requests[0]!.query.name).toBe('Casablanca, Morocco');
  });
});

describe('describeWeatherCode', () => {
  const table: [number, string, string][] = [
    [0, 'Clear sky', '☀️'],
    [1, 'Mainly clear', '🌤️'],
    [2, 'Partly cloudy', '⛅'],
    [3, 'Overcast', '☁️'],
    [45, 'Fog', '🌫️'],
    [48, 'Depositing rime fog', '🌫️'],
    [51, 'Light drizzle', '🌦️'],
    [53, 'Moderate drizzle', '🌦️'],
    [55, 'Dense drizzle', '🌦️'],
    [56, 'Light freezing drizzle', '🌧️'],
    [57, 'Dense freezing drizzle', '🌧️'],
    [61, 'Slight rain', '🌧️'],
    [63, 'Moderate rain', '🌧️'],
    [65, 'Heavy rain', '🌧️'],
    [66, 'Light freezing rain', '🌧️'],
    [67, 'Heavy freezing rain', '🌧️'],
    [71, 'Slight snowfall', '🌨️'],
    [73, 'Moderate snowfall', '🌨️'],
    [75, 'Heavy snowfall', '🌨️'],
    [77, 'Snow grains', '🌨️'],
    [80, 'Slight rain showers', '🌦️'],
    [81, 'Moderate rain showers', '🌦️'],
    [82, 'Violent rain showers', '🌦️'],
    [85, 'Slight snow showers', '🌨️'],
    [86, 'Heavy snow showers', '🌨️'],
    [95, 'Thunderstorm', '⛈️'],
    [96, 'Thunderstorm with slight hail', '⛈️'],
    [97, 'Heavy thunderstorm', '⛈️'],
    [99, 'Thunderstorm with heavy hail', '⛈️'],
  ];
  it.each(table)('code %i = %s %s', (code, description, emoji) => {
    expect(describeWeatherCode(code, true)).toEqual({ description, emoji });
    expect(describeWeatherCode(code)).toEqual({ description, emoji });
    // only the clear sky changes at night
    expect(describeWeatherCode(code, 0)).toEqual({ description, emoji: code === 0 ? '🌙' : emoji });
    expect(describeWeatherCode(code, false)).toEqual({ description, emoji: code === 0 ? '🌙' : emoji });
  });
  it.each([[4], [-1], [100], [2.5], [null], [undefined], ['2']])('unknown code %j', (code) => {
    expect(describeWeatherCode(code, true)).toEqual({ description: `Unknown (code ${String(code)})`, emoji: '🌡️' });
  });
});
