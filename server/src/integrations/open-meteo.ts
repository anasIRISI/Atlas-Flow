import { httpSend, redact } from '../nodes/_shared/http-client.js';
import { IntegrationError } from './errors.js';

// Open-Meteo client (weather forecast + place search). No API key.
// Docs:
//   Forecast API   https://open-meteo.com/en/docs
//   Geocoding API  https://open-meteo.com/en/docs/geocoding-api
//   Terms          https://open-meteo.com/en/terms  (free for non-commercial use: < 10 000 calls/day, 5 000/hour,
//                  600/minute; data is CC BY 4.0, attribution required)
// Both base URLs can be replaced (Open-Meteo can be self-hosted).

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';

const SERVICE = 'Open-Meteo';

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const CURRENT_VARIABLES = ['temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'is_day', 'precipitation', 'weather_code', 'cloud_cover', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
export const HOURLY_VARIABLES = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'precipitation_probability', 'precipitation', 'weather_code', 'wind_speed_10m', 'is_day'];
export const DAILY_VARIABLES = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max', 'apparent_temperature_min', 'sunrise', 'sunset', 'uv_index_max', 'precipitation_sum', 'precipitation_probability_max', 'wind_speed_10m_max'];

export const TEMPERATURE_UNITS = ['celsius', 'fahrenheit'];
export const WIND_SPEED_UNITS = ['kmh', 'ms', 'mph', 'kn'];
export const PRECIPITATION_UNITS = ['mm', 'inch'];

export interface Place {
  id?: number;
  name: string;
  latitude: number;
  longitude: number;
  elevation?: number;
  timezone?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  population?: number;
}

export interface GeocodeParams {
  count?: number;
  language?: string;
  countryCode?: string;
  baseUrl?: string;
}

export interface ForecastParams {
  latitude: number;
  longitude: number;
  current?: boolean;
  daily?: boolean;
  hourly?: boolean;
  forecastDays?: number;
  forecastHours?: number;
  temperatureUnit?: string;
  windSpeedUnit?: string;
  precipitationUnit?: string;
  timezone?: string;
  baseUrl?: string;
}

type Block = Record<string, unknown>;

export interface ForecastResponse {
  latitude: number;
  longitude: number;
  elevation?: number;
  timezone?: string;
  current_units?: Record<string, string>;
  current?: Block;
  hourly_units?: Record<string, string>;
  hourly?: Record<string, unknown[]>;
  daily_units?: Record<string, string>;
  daily?: Record<string, unknown[]>;
}

// ── Weather codes (WMO) ──────────────────────────────────────────────────────

const CODES: Record<number, [string, string]> = {
  0: ['Clear sky', '☀️'],
  1: ['Mainly clear', '🌤️'],
  2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Depositing rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Moderate drizzle', '🌦️'],
  55: ['Dense drizzle', '🌦️'],
  56: ['Light freezing drizzle', '🌧️'],
  57: ['Dense freezing drizzle', '🌧️'],
  61: ['Slight rain', '🌧️'],
  63: ['Moderate rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Light freezing rain', '🌧️'],
  67: ['Heavy freezing rain', '🌧️'],
  71: ['Slight snowfall', '🌨️'],
  73: ['Moderate snowfall', '🌨️'],
  75: ['Heavy snowfall', '🌨️'],
  77: ['Snow grains', '🌨️'],
  80: ['Slight rain showers', '🌦️'],
  81: ['Moderate rain showers', '🌦️'],
  82: ['Violent rain showers', '🌦️'],
  85: ['Slight snow showers', '🌨️'],
  86: ['Heavy snow showers', '🌨️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm with slight hail', '⛈️'],
  97: ['Heavy thunderstorm', '⛈️'],
  99: ['Thunderstorm with heavy hail', '⛈️'],
};

/** WMO weather code to text and emoji. At night (`isDay` false / 0) a clear sky is a moon. */
export function describeWeatherCode(code: unknown, isDay: unknown = true): { description: string; emoji: string } {
  const n = typeof code === 'number' ? code : Number.NaN;
  const known = Number.isInteger(n) ? CODES[n] : undefined;
  if (!known) return { description: `Unknown (code ${String(code)})`, emoji: '🌡️' };
  const night = isDay === 0 || isDay === false;
  return { description: known[0], emoji: n === 0 && night ? '🌙' : known[1] };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function endpoint(base: string | undefined, fallback: string, defaultPath: string): string {
  const text = (base ?? '').trim();
  if (!text) return fallback;
  try {
    const url = new URL(text);
    if (url.pathname === '/' || url.pathname === '') url.pathname = defaultPath;
    return url.toString();
  } catch {
    return text; // httpSend explains an invalid URL
  }
}

async function getJson(url: string, query: Record<string, string>, what: string, o: CallOptions): Promise<Record<string, unknown>> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  const result = await httpSend({
    method: 'GET',
    url: target.toString(),
    headers: { accept: 'application/json', 'user-agent': 'FlowForge' },
    timeoutMs: o.timeoutMs ?? 15000,
    followRedirects: true,
    maxRedirects: 3,
    ignoreSsl: false,
    signal: o.signal ?? new AbortController().signal,
    secrets: [],
  });
  const text = result.body.toString('utf8');
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const status = result.statusCode;

  if (status === 429) {
    const wait = Number(result.headers['retry-after']);
    throw new IntegrationError(SERVICE, `${SERVICE} says there are too many requests`, {
      status,
      code: 'rate_limit',
      retryAfterMs: Number.isFinite(wait) && wait > 0 ? wait * 1000 : undefined,
      hint: 'The free limits are 600 calls per minute, 5 000 per hour and 10 000 per day. Wait a moment, or enable "Retry On Fail" in the node settings.',
    });
  }
  if (status >= 500) {
    throw new IntegrationError(SERVICE, `${SERVICE} has a problem (HTTP ${status})`, { status, code: 'server_error', hint: 'The problem is on the Open-Meteo side: try again in a few minutes, or enable "Retry On Fail" in the node settings.' });
  }
  if (status >= 400 || (isObject(body) && body.error === true)) {
    const reason = isObject(body) && typeof body.reason === 'string' ? redact(body.reason, []).slice(0, 300) : `HTTP ${status}`;
    throw new IntegrationError(SERVICE, reason, {
      status,
      code: 'bad_request',
      hint: status === 404 ? 'Nothing exists at this address: check the Forecast URL / Geocoding URL in the options.' : 'Check the coordinates, the units and the time zone.',
    });
  }
  if (!isObject(body)) {
    throw new IntegrationError(SERVICE, `${SERVICE} sent an answer that is not valid JSON (${what})`, {
      status,
      code: 'malformed',
      hint: 'If you changed the Forecast URL / Geocoding URL in the options, check that it points to an Open-Meteo server.',
    });
  }
  return body;
}

// ── Geocoding ────────────────────────────────────────────────────────────────

function toPlace(raw: Record<string, unknown>): Place | undefined {
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (typeof raw.name !== 'string' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    id: num(raw.id),
    name: raw.name,
    latitude,
    longitude,
    elevation: num(raw.elevation),
    timezone: text(raw.timezone),
    country: text(raw.country),
    countryCode: text(raw.country_code),
    region: text(raw.admin1),
    population: num(raw.population),
  };
}

/**
 * Searches places by name. An unknown name is NOT an error: the API answers 200 without a `results` key, and this
 * returns an empty list. Names shorter than 2 characters never match (API rule). The text is sent as typed: the API
 * resolves "Paris, Texas" or "Springfield, IL" itself.
 */
export async function geocode(input: string, p: GeocodeParams = {}, o: CallOptions = {}): Promise<Place[]> {
  const name = input.trim();
  if (name.length < 2) return [];
  const count = Math.min(Math.max(Math.trunc(p.count ?? 10), 1), 100);
  const query: Record<string, string> = { name, count: String(count), language: p.language || 'en', format: 'json' };
  if (p.countryCode) query.countryCode = p.countryCode.toUpperCase();
  const body = await getJson(endpoint(p.baseUrl, GEOCODING_URL, '/v1/search'), query, 'place search', o);
  if (body.results === undefined) return [];
  if (!Array.isArray(body.results)) throw new IntegrationError(SERVICE, `${SERVICE} sent an unexpected answer for the place search`, { code: 'malformed', hint: 'Check the Geocoding URL in the options.' });
  const raws = (body.results as unknown[]).filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);
  return raws
    .slice(0, count)
    .map(toPlace)
    .filter((place): place is Place => place !== undefined);
}

// ── Forecast ─────────────────────────────────────────────────────────────────

function blockIsValid(block: unknown, kind: 'current' | 'list'): boolean {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return false;
  const time = (block as Record<string, unknown>).time;
  return kind === 'current' ? typeof time === 'string' : Array.isArray(time);
}

/** Requests ONLY the blocks asked for (`current=`, `daily=`, `hourly=` are absent otherwise). */
export async function forecast(p: ForecastParams, o: CallOptions = {}): Promise<ForecastResponse> {
  const query: Record<string, string> = { latitude: String(p.latitude), longitude: String(p.longitude) };
  if (p.current) query.current = CURRENT_VARIABLES.join(',');
  if (p.hourly) query.hourly = HOURLY_VARIABLES.join(',');
  if (p.daily) query.daily = DAILY_VARIABLES.join(',');
  if (p.temperatureUnit) query.temperature_unit = p.temperatureUnit;
  if (p.windSpeedUnit) query.wind_speed_unit = p.windSpeedUnit;
  if (p.precipitationUnit) query.precipitation_unit = p.precipitationUnit;
  query.timezone = p.timezone || 'auto';
  if ((p.daily || p.hourly) && p.forecastDays !== undefined) query.forecast_days = String(p.forecastDays);
  if (p.hourly && p.forecastHours !== undefined) query.forecast_hours = String(p.forecastHours);

  const body = await getJson(endpoint(p.baseUrl, FORECAST_URL, '/v1/forecast'), query, 'forecast', o);
  const bad = (what: string) => new IntegrationError(SERVICE, `${SERVICE} sent a forecast without ${what}`, { code: 'malformed', hint: 'If you changed the Forecast URL in the options, check that it points to an Open-Meteo server.' });
  if (!Number.isFinite(Number(body.latitude)) || !Number.isFinite(Number(body.longitude))) throw bad('a location');
  if (p.current && !blockIsValid(body.current, 'current')) throw bad('the current weather');
  if (p.daily && !blockIsValid(body.daily, 'list')) throw bad('the daily forecast');
  if (p.hourly && !blockIsValid(body.hourly, 'list')) throw bad('the hourly forecast');
  return body as unknown as ForecastResponse;
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface WeatherUnits {
  temperature: string;
  windSpeed: string;
  precipitation: string;
}

export interface WeatherLocation {
  name: string;
  country: string;
  countryCode: string;
  region: string;
  latitude: number;
  longitude: number;
  timezone: string;
  elevation: number | null;
}

export interface WeatherOutput {
  location: WeatherLocation;
  current?: Record<string, unknown>;
  daily?: Record<string, unknown>[];
  hourly?: Record<string, unknown>[];
  units: WeatherUnits;
  summary: string;
  attribution: string;
}

const value = (v: unknown): number | string | null => (typeof v === 'number' || typeof v === 'string' ? v : null);
const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function unitOf(...sources: (Record<string, string> | undefined)[]) {
  return (...keys: string[]): string => {
    for (const source of sources) for (const key of keys) if (source?.[key] !== undefined) return source[key]!;
    return '';
  };
}

export function placeLabel(location: Pick<WeatherLocation, 'name' | 'country'>): string {
  return location.country && !location.name.includes(location.country) ? `${location.name}, ${location.country}` : location.name;
}

const num = (n: number | null | undefined): string => (n === null || n === undefined ? '?' : String(n));
const withUnit = (n: number | null | undefined, unit: string): string => `${num(n)}${unit ? ` ${unit}` : ''}`;

/** One readable line, e.g. "Paris, France: ⛅ Partly cloudy, 19.8 °C (feels like 18.4 °C), wind 11 km/h. Today 12.1 to 20.6 °C, rain 20 %." */
export function summarize(label: string, parts: { current?: Record<string, unknown>; today?: Record<string, unknown>; nextHour?: Record<string, unknown> }, units: WeatherUnits, percent = '%'): string {
  const { current, today, nextHour } = parts;
  const sentences: string[] = [];
  if (current) {
    let line = `${label}: ${current.emoji} ${current.description}, ${withUnit(current.temperature as number | null, units.temperature)}`;
    if (typeof current.feelsLike === 'number') line += ` (feels like ${withUnit(current.feelsLike, units.temperature)})`;
    if (typeof current.windSpeed === 'number') line += `, wind ${withUnit(Math.round(current.windSpeed), units.windSpeed)}`;
    sentences.push(`${line}.`);
  } else if (!today && nextHour) {
    sentences.push(`${label}: ${nextHour.emoji} ${nextHour.description}, ${withUnit(nextHour.temperature as number | null, units.temperature)} at ${String(nextHour.time).replace('T', ' ')}.`);
  }
  if (today) {
    let line = current ? 'Today' : `${label}: ${today.emoji} ${today.description}, today`;
    line += ` ${num(today.temperatureMin as number | null)} to ${withUnit(today.temperatureMax as number | null, units.temperature)}`;
    if (typeof today.precipitationProbability === 'number') line += `, rain ${today.precipitationProbability} ${percent}`;
    else if (typeof today.precipitationSum === 'number' && today.precipitationSum > 0) line += `, ${withUnit(today.precipitationSum, units.precipitation)} of precipitation`;
    sentences.push(`${line}.`);
  }
  return sentences.join(' ');
}

/** Builds the node output (camelCase, readable) from a place and the raw forecast. */
export function toWeatherOutput(place: { name: string; country?: string; countryCode?: string; region?: string }, raw: ForecastResponse): WeatherOutput {
  const location: WeatherLocation = {
    name: place.name,
    country: place.country ?? '',
    countryCode: place.countryCode ?? '',
    region: place.region ?? '',
    latitude: Number(raw.latitude),
    longitude: Number(raw.longitude),
    timezone: raw.timezone ?? '',
    elevation: numberOrNull(raw.elevation),
  };
  const unit = unitOf(raw.current_units, raw.daily_units, raw.hourly_units);
  const units: WeatherUnits = {
    temperature: unit('temperature_2m', 'temperature_2m_max'),
    windSpeed: unit('wind_speed_10m', 'wind_speed_10m_max'),
    precipitation: unit('precipitation', 'precipitation_sum'),
  };
  const out: WeatherOutput = { location, units, summary: '', attribution: ATTRIBUTION };

  if (raw.current) {
    const c = raw.current;
    const isDay = numberOrNull(c.is_day);
    const code = numberOrNull(c.weather_code);
    out.current = {
      time: value(c.time),
      temperature: numberOrNull(c.temperature_2m),
      feelsLike: numberOrNull(c.apparent_temperature),
      humidity: numberOrNull(c.relative_humidity_2m),
      precipitation: numberOrNull(c.precipitation),
      cloudCover: numberOrNull(c.cloud_cover),
      windSpeed: numberOrNull(c.wind_speed_10m),
      windDirection: numberOrNull(c.wind_direction_10m),
      windGusts: numberOrNull(c.wind_gusts_10m),
      isDay: isDay === null ? null : isDay === 1,
      weatherCode: code,
      ...describeWeatherCode(code ?? c.weather_code, isDay === null ? true : isDay),
    };
  }
  if (raw.daily) {
    const d = raw.daily;
    out.daily = (d.time ?? []).map((date, i) => {
      const code = numberOrNull(d.weather_code?.[i]);
      return {
        date: value(date),
        weatherCode: code,
        ...describeWeatherCode(code ?? d.weather_code?.[i], true),
        temperatureMax: numberOrNull(d.temperature_2m_max?.[i]),
        temperatureMin: numberOrNull(d.temperature_2m_min?.[i]),
        feelsLikeMax: numberOrNull(d.apparent_temperature_max?.[i]),
        feelsLikeMin: numberOrNull(d.apparent_temperature_min?.[i]),
        sunrise: value(d.sunrise?.[i]),
        sunset: value(d.sunset?.[i]),
        uvIndexMax: numberOrNull(d.uv_index_max?.[i]),
        precipitationSum: numberOrNull(d.precipitation_sum?.[i]),
        precipitationProbability: numberOrNull(d.precipitation_probability_max?.[i]),
        windSpeedMax: numberOrNull(d.wind_speed_10m_max?.[i]),
      };
    });
  }
  if (raw.hourly) {
    const h = raw.hourly;
    out.hourly = (h.time ?? []).map((time, i) => {
      const code = numberOrNull(h.weather_code?.[i]);
      const isDay = numberOrNull(h.is_day?.[i]);
      return {
        time: value(time),
        temperature: numberOrNull(h.temperature_2m?.[i]),
        feelsLike: numberOrNull(h.apparent_temperature?.[i]),
        humidity: numberOrNull(h.relative_humidity_2m?.[i]),
        precipitationProbability: numberOrNull(h.precipitation_probability?.[i]),
        precipitation: numberOrNull(h.precipitation?.[i]),
        weatherCode: code,
        ...describeWeatherCode(code ?? h.weather_code?.[i], isDay === null ? true : isDay),
        windSpeed: numberOrNull(h.wind_speed_10m?.[i]),
        isDay: isDay === null ? null : isDay === 1,
      };
    });
  }
  const percent = raw.daily_units?.precipitation_probability_max ?? raw.hourly_units?.precipitation_probability ?? '%';
  out.summary = summarize(placeLabel(location), { current: out.current, today: out.daily?.[0], nextHour: out.hourly?.[0] }, units, percent);
  return out;
}
