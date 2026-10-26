import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// Local stand-in for api.open-meteo.com and geocoding-api.open-meteo.com (fixed data, records every request).

export interface MeteoRequest {
  path: string;
  query: Record<string, string>;
}

export interface Override {
  status?: number;
  /** Object => JSON, string => sent as is. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Wait this long before answering (timeout tests). */
  delayMs?: number;
}

export interface OpenMeteoMock {
  /** Base URLs for the node options (`forecastUrl` / `geocodingUrl`). */
  forecastUrl: string;
  geocodingUrl: string;
  requests: MeteoRequest[];
  forecastRequests(): MeteoRequest[];
  geocodingRequests(): MeteoRequest[];
  /** Weather served by the next forecast calls. */
  data: { weatherCode: number; isDay: number };
  /** Replaces the answer of an endpoint until reset(). */
  override: { forecast?: Override; geocoding?: Override };
  reset(): void;
  close(): Promise<void>;
}

const PLACES = [
  { id: 2988507, name: 'Paris', latitude: 48.85341, longitude: 2.3488, elevation: 42, feature_code: 'PPLC', country_code: 'FR', timezone: 'Europe/Paris', population: 2138551, country: 'France', admin1: 'Île-de-France' },
  { id: 4717560, name: 'Paris', latitude: 33.66094, longitude: -95.55551, elevation: 180, feature_code: 'PPLA2', country_code: 'US', timezone: 'America/Chicago', population: 25171, country: 'United States', admin1: 'Texas' },
  { id: 2996944, name: 'Lyon', latitude: 45.74846, longitude: 4.84671, elevation: 175, feature_code: 'PPLA', country_code: 'FR', timezone: 'Europe/Paris', population: 522250, country: 'France', admin1: 'Auvergne-Rhône-Alpes' },
  { id: 2548885, name: 'Casablanca', latitude: 33.58831, longitude: -7.61138, elevation: 27, feature_code: 'PPLA', country_code: 'MA', timezone: 'Africa/Casablanca', population: 3144909, country: 'Morocco', admin1: 'Casablanca-Settat' },
];

const round1 = (n: number) => Math.round(n * 10) / 10;
const f = (c: number) => round1((c * 9) / 5 + 32);

export async function startOpenMeteoMock(): Promise<OpenMeteoMock> {
  const requests: MeteoRequest[] = [];
  const state: Pick<OpenMeteoMock, 'data' | 'override'> = { data: { weatherCode: 2, isDay: 1 }, override: {} };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  // Like the real API, a qualifier after a comma ("Paris, France", "Paris, Texas", "Paris, US") picks the place.
  const geocoding = (query: Record<string, string>) => {
    const typed = (query.name ?? '').trim();
    if (typed.length < 2) return { generationtime_ms: 0.4 };
    const [name = '', ...rest] = typed.split(',');
    const qualifier = rest.join(',').trim().toLowerCase();
    const count = Number(query.count ?? 10);
    const results = PLACES.filter(
      (p) =>
        p.name.toLowerCase() === name.trim().toLowerCase() &&
        (!query.countryCode || p.country_code === query.countryCode) &&
        (!qualifier || [p.country, p.country_code, p.admin1].some((v) => v.toLowerCase() === qualifier)),
    ).slice(0, count);
    return results.length ? { results, generationtime_ms: 0.7 } : { generationtime_ms: 0.5 };
  };

  const forecast = (query: Record<string, string>): { status: number; body: unknown } => {
    const lat = Number(query.latitude);
    const lon = Number(query.longitude);
    if (!(lat >= -90 && lat <= 90)) return { status: 400, body: { error: true, reason: `Latitude must be in range of -90 to 90°. Given: ${query.latitude}.` } };
    if (!(lon >= -180 && lon <= 180)) return { status: 400, body: { error: true, reason: `Longitude must be in range of -180 to 180°. Given: ${query.longitude}.` } };
    const fahrenheit = query.temperature_unit === 'fahrenheit';
    const temp = (c: number) => (fahrenheit ? f(c) : c);
    const windFactor = { kmh: 1, ms: 0.2778, mph: 0.6214, kn: 0.54 }[(query.wind_speed_unit ?? 'kmh') as 'kmh'] ?? 1;
    const wind = (kmh: number) => round1(kmh * windFactor);
    const inch = query.precipitation_unit === 'inch';
    const rain = (mm: number) => (inch ? round1(mm / 25.4) : mm);
    const units = {
      temperature: fahrenheit ? '°F' : '°C',
      wind: { kmh: 'km/h', ms: 'm/s', mph: 'mp/h', kn: 'kn' }[(query.wind_speed_unit ?? 'kmh') as 'kmh'] ?? 'km/h',
      rain: inch ? 'inch' : 'mm',
    };
    const timezone = query.timezone && query.timezone !== 'auto' ? query.timezone : 'Europe/Paris';
    const body: Record<string, unknown> = { latitude: round1(lat), longitude: round1(lon), generationtime_ms: 0.1, utc_offset_seconds: 7200, timezone, timezone_abbreviation: 'CEST', elevation: 38 };
    const { weatherCode, isDay } = state.data;

    if (query.current) {
      body.current_units = { time: 'iso8601', interval: 'seconds', temperature_2m: units.temperature, relative_humidity_2m: '%', apparent_temperature: units.temperature, is_day: '', precipitation: units.rain, weather_code: 'wmo code', cloud_cover: '%', wind_speed_10m: units.wind, wind_direction_10m: '°', wind_gusts_10m: units.wind };
      body.current = { time: '2026-10-12T14:00', interval: 900, temperature_2m: temp(19.8), relative_humidity_2m: 62, apparent_temperature: temp(18.4), is_day: isDay, precipitation: rain(0.2), weather_code: weatherCode, cloud_cover: 55, wind_speed_10m: wind(10.8), wind_direction_10m: 240, wind_gusts_10m: wind(25.9) };
    }
    if (query.daily) {
      const days = Number(query.forecast_days ?? 7);
      const index = Array.from({ length: days }, (_v, i) => i);
      body.daily_units = { time: 'iso8601', weather_code: 'wmo code', temperature_2m_max: units.temperature, temperature_2m_min: units.temperature, apparent_temperature_max: units.temperature, apparent_temperature_min: units.temperature, sunrise: 'iso8601', sunset: 'iso8601', uv_index_max: '', precipitation_sum: units.rain, precipitation_probability_max: '%', wind_speed_10m_max: units.wind };
      body.daily = {
        time: index.map((i) => `2026-10-${String(12 + i).padStart(2, '0')}`),
        weather_code: index.map(() => weatherCode),
        temperature_2m_max: index.map((i) => temp(round1(20.6 - i))),
        temperature_2m_min: index.map((i) => temp(round1(12.1 - i))),
        apparent_temperature_max: index.map((i) => temp(round1(19.5 - i))),
        apparent_temperature_min: index.map((i) => temp(round1(11.2 - i))),
        sunrise: index.map((i) => `2026-10-${String(12 + i).padStart(2, '0')}T08:01`),
        sunset: index.map((i) => `2026-10-${String(12 + i).padStart(2, '0')}T19:12`),
        uv_index_max: index.map(() => 3.4),
        precipitation_sum: index.map(() => rain(1.3)),
        precipitation_probability_max: index.map(() => 20),
        wind_speed_10m_max: index.map(() => wind(18.2)),
      };
    }
    if (query.hourly) {
      const hours = Number(query.forecast_hours ?? Number(query.forecast_days ?? 7) * 24);
      const index = Array.from({ length: hours }, (_v, i) => i);
      body.hourly_units = { time: 'iso8601', temperature_2m: units.temperature, apparent_temperature: units.temperature, relative_humidity_2m: '%', precipitation_probability: '%', precipitation: units.rain, weather_code: 'wmo code', wind_speed_10m: units.wind, is_day: '' };
      body.hourly = {
        time: index.map((i) => `2026-10-${String(12 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00`),
        temperature_2m: index.map(() => temp(17.5)),
        apparent_temperature: index.map(() => temp(16.9)),
        relative_humidity_2m: index.map(() => 70),
        precipitation_probability: index.map(() => 10),
        precipitation: index.map(() => rain(0)),
        weather_code: index.map(() => weatherCode),
        wind_speed_10m: index.map(() => wind(9.4)),
        is_day: index.map((i) => (i % 24 >= 8 && i % 24 < 19 ? 1 : 0)),
      };
    }
    return { status: 200, body };
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const query = Object.fromEntries(url.searchParams.entries());
    requests.push({ path: url.pathname, query });
    const isForecast = url.pathname === '/v1/forecast';
    const isGeocoding = url.pathname === '/v1/search';
    if (!isForecast && !isGeocoding) return send(res, 404, { error: true, reason: 'Not found' });
    const override = isForecast ? state.override.forecast : state.override.geocoding;
    const respond = () => {
      if (override) return send(res, override.status ?? 200, override.body ?? {}, override.headers);
      if (isGeocoding) return send(res, 200, geocoding(query));
      const answer = forecast(query);
      send(res, answer.status, answer.body);
    };
    if (override?.delayMs) setTimeout(respond, override.delayMs);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    forecastUrl: `${base}/v1/forecast`,
    geocodingUrl: `${base}/v1/search`,
    requests,
    forecastRequests: () => requests.filter((r) => r.path === '/v1/forecast'),
    geocodingRequests: () => requests.filter((r) => r.path === '/v1/search'),
    data: state.data,
    override: state.override,
    reset() {
      requests.length = 0;
      state.data.weatherCode = 2;
      state.data.isDay = 1;
      delete state.override.forecast;
      delete state.override.geocoding;
    },
    close: () => new Promise<void>((resolve) => (server.closeAllConnections?.(), server.close(() => resolve()))),
  };
}
