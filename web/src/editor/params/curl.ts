// "Import cURL" of the HTTP Request node: parses a curl command (bash, zsh, PowerShell or cmd style
// quoting, as copied from browser dev tools or API docs) into the node's parameters.

export interface NameValue {
  name: string;
  value: string;
}

export type CurlBody =
  | { type: 'json'; json: string }
  | { type: 'form'; fields: NameValue[] }
  | { type: 'multipart'; parts: Array<{ name: string; value?: string; file?: string }> }
  | { type: 'raw'; contentType: string; text: string };

export type CurlAuth = { type: 'basic'; user: string; password: string } | { type: 'bearer'; token: string };

export interface CurlRequest {
  method: string;
  /** URL without its query string. */
  url: string;
  query: NameValue[];
  /** Headers without Content-Type of JSON / form bodies and without the Authorization moved to `auth`. */
  headers: NameValue[];
  body?: CurlBody;
  /** Secrets found in -u or in an Authorization header: better stored as a credential than in the node. */
  auth?: CurlAuth;
  insecure: boolean;
  timeoutMs?: number;
  /** Things that could not be imported, for the user. */
  warnings: string[];
}

export class CurlParseError extends Error {}

// ── Tokenizer ────────────────────────────────────────────────────────────────

const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/** Splits a command line into arguments, following shell quoting rules. */
export function tokenizeCommand(input: string): string[] {
  // Line continuations: "\" (bash), "`" (PowerShell), "^" (cmd) at the end of a line.
  let text = input.trim().replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const cmd = /\^"/.test(text) || /\^[&%]/.test(text);
  // cmd.exe (Chrome "Copy as cURL (cmd)"): ^ escapes the next character, so ^" is a normal quote
  // and ^\^" a quote inside the text.
  if (cmd) text = text.replace(/\^([\s\S])/g, '$1');
  const tokens: string[] = [];
  let current = '';
  let has = false;
  let i = 0;
  const push = () => {
    if (has) tokens.push(current);
    current = '';
    has = false;
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      push();
      i++;
    } else if (ch === "'" || (ch === '$' && text[i + 1] === "'")) {
      const ansi = ch === '$';
      i += ansi ? 2 : 1;
      has = true;
      for (; i < text.length && text[i] !== "'"; i++) {
        if (ansi && text[i] === '\\' && i + 1 < text.length) {
          const next = text[++i]!;
          if (next === 'x' || next === 'u') {
            const hex = /^[0-9a-fA-F]+/.exec(text.slice(i + 1, i + 1 + (next === 'x' ? 2 : 4)))?.[0] ?? '';
            current += hex ? String.fromCharCode(parseInt(hex, 16)) : next;
            i += hex.length;
          } else current += ANSI_ESCAPES[next] ?? `\\${next}`;
        } else current += text[i];
      }
      if (i >= text.length) throw new CurlParseError("A single quote (') is never closed");
      i++;
    } else if (ch === '"') {
      i++;
      has = true;
      for (; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1]!)) current += text[++i];
        else current += text[i];
      }
      if (i >= text.length) throw new CurlParseError('A double quote (") is never closed');
      i++;
    } else if (ch === '\\' && i + 1 < text.length) {
      current += text[i + 1];
      has = true;
      i += 2;
    } else {
      current += ch;
      has = true;
      i++;
    }
  }
  push();
  return tokens;
}

// ── Options ──────────────────────────────────────────────────────────────────

/** Options that take a value → canonical name. */
const WITH_VALUE: Record<string, string> = {
  '-X': 'request', '--request': 'request',
  '-H': 'header', '--header': 'header',
  '-d': 'data', '--data': 'data', '--data-ascii': 'data', '--data-raw': 'data-raw', '--data-binary': 'data-raw', '--data-urlencode': 'data-urlencode', '--json': 'json',
  '-F': 'form', '--form': 'form', '--form-string': 'form-string',
  '-u': 'user', '--user': 'user', '--oauth2-bearer': 'bearer',
  '-A': 'user-agent', '--user-agent': 'user-agent',
  '-e': 'referer', '--referer': 'referer',
  '-b': 'cookie', '--cookie': 'cookie',
  '--url': 'url',
  '-m': 'max-time', '--max-time': 'max-time', '--connect-timeout': 'ignored',
  '-o': 'ignored', '--output': 'ignored', '-w': 'ignored', '--write-out': 'ignored', '-c': 'ignored', '--cookie-jar': 'ignored',
  '--retry': 'ignored', '--retry-delay': 'ignored', '--retry-max-time': 'ignored', '-x': 'unsupported', '--proxy': 'unsupported',
  '--cacert': 'unsupported', '--cert': 'unsupported', '-E': 'unsupported', '--key': 'unsupported', '-T': 'unsupported', '--upload-file': 'unsupported',
  '--resolve': 'unsupported', '--interface': 'ignored', '--limit-rate': 'ignored', '-r': 'unsupported', '--range': 'unsupported', '-K': 'unsupported', '--config': 'unsupported',
};
const SHORT_WITH_VALUE = new Set(Object.keys(WITH_VALUE).filter((k) => k.length === 2));

const splitPair = (text: string, separator: string): NameValue => {
  const at = text.indexOf(separator);
  return at === -1 ? { name: text.trim(), value: '' } : { name: text.slice(0, at).trim(), value: text.slice(at + 1).trim() };
};
const decode = (text: string) => {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
};
const parseForm = (text: string): NameValue[] =>
  text
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const { name, value } = splitPair(pair, '=');
      return { name: decode(name), value: decode(value) };
    });

/** Parses a curl command. Throws CurlParseError with a readable message. */
export function parseCurl(command: string): CurlRequest {
  const tokens = tokenizeCommand(command.replace(/^\s*\$\s+/, ''));
  if (tokens.length === 0) throw new CurlParseError('Paste a curl command first');
  if (!/^curl(\.exe)?$/i.test(tokens[0]!)) throw new CurlParseError('The command must start with "curl"');

  const warnings: string[] = [];
  const headers: NameValue[] = [];
  const data: string[] = [];
  const parts: Array<{ name: string; value?: string; file?: string }> = [];
  let url: string | undefined;
  let method: string | undefined;
  let jsonFlag = false;
  let get = false;
  let head = false;
  let insecure = false;
  let timeoutMs: number | undefined;
  let auth: CurlAuth | undefined;

  const apply = (name: string, value: string, flag: string) => {
    switch (name) {
      case 'request':
        method = value.toUpperCase();
        break;
      case 'header': {
        const header = splitPair(value.replace(/;$/, ':'), ':');
        if (header.name) headers.push(header);
        break;
      }
      case 'json':
        jsonFlag = true;
        data.push(value);
        break;
      case 'data':
      case 'data-raw':
        if (name === 'data' && value.startsWith('@')) warnings.push(`The body comes from the file ${value.slice(1)}: paste its content into the body.`);
        data.push(value);
        break;
      case 'data-urlencode': {
        const at = value.indexOf('=');
        data.push(at === -1 ? encodeURIComponent(value) : `${value.slice(0, at)}=${encodeURIComponent(value.slice(at + 1))}`);
        break;
      }
      case 'form':
      case 'form-string': {
        const { name: field, value: content } = splitPair(value, '=');
        if (name === 'form' && content.startsWith('@')) parts.push({ name: field, file: content.slice(1).split(';')[0] });
        else parts.push({ name: field, value: name === 'form' && content.startsWith('<') ? '' : content.replace(/^"(.*)"$/, '$1') });
        break;
      }
      case 'user': {
        const at = value.indexOf(':');
        auth = { type: 'basic', user: at === -1 ? value : value.slice(0, at), password: at === -1 ? '' : value.slice(at + 1) };
        break;
      }
      case 'bearer':
        auth = { type: 'bearer', token: value };
        break;
      case 'user-agent':
        headers.push({ name: 'User-Agent', value });
        break;
      case 'referer':
        headers.push({ name: 'Referer', value });
        break;
      case 'cookie':
        if (value.includes('=')) headers.push({ name: 'Cookie', value });
        else warnings.push(`Cookies from the file ${value} were not imported.`);
        break;
      case 'url':
        url ??= value;
        break;
      case 'max-time': {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds > 0) timeoutMs = Math.round(seconds * 1000);
        break;
      }
      case 'unsupported':
        warnings.push(`The option ${flag} is not supported and was ignored.`);
        break;
      default:
        break;
    }
  };

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--') continue;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const flag = eq === -1 ? token : token.slice(0, eq);
      if (flag in WITH_VALUE) {
        const value = eq === -1 ? tokens[++i] : token.slice(eq + 1);
        if (value === undefined) throw new CurlParseError(`The option ${flag} needs a value`);
        apply(WITH_VALUE[flag]!, value, flag);
      } else if (flag === '--get') get = true;
      else if (flag === '--head') head = true;
      else if (flag === '--insecure') insecure = true;
      // Other long switches (--location, --compressed, --silent, --http2…) need no translation.
    } else if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      // Short options can be combined (-sSL) and carry their value (-XPOST).
      for (let c = 1; c < token.length; c++) {
        const flag = `-${token[c]}`;
        if (SHORT_WITH_VALUE.has(flag)) {
          const attached = token.slice(c + 1);
          const value = attached || tokens[++i];
          if (value === undefined) throw new CurlParseError(`The option ${flag} needs a value`);
          apply(WITH_VALUE[flag]!, value, flag);
          break;
        }
        if (flag === '-G') get = true;
        else if (flag === '-I') head = true;
        else if (flag === '-k') insecure = true;
      }
    } else if (url === undefined) url = token;
    else warnings.push(`Only the first URL was imported (ignored: ${token}).`);
  }

  if (!url) throw new CurlParseError('No URL found in the command');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CurlParseError(`"${url}" is not a valid URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new CurlParseError(`Only http:// and https:// URLs can be imported (got ${parsed.protocol}//)`);
  // user:password@host in the URL is basic authentication too.
  if (parsed.username && !auth) auth = { type: 'basic', user: decode(parsed.username), password: decode(parsed.password) };
  parsed.username = '';
  parsed.password = '';

  const query: NameValue[] = [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value }));
  parsed.search = '';
  parsed.hash = '';

  // Authorization header → auth (so the secret can go to a credential).
  const authIndex = headers.findIndex((h) => h.name.toLowerCase() === 'authorization');
  if (authIndex !== -1 && !auth) {
    const value = headers[authIndex]!.value;
    const bearer = /^Bearer\s+(.+)$/i.exec(value);
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(value);
    if (bearer) auth = { type: 'bearer', token: bearer[1]!.trim() };
    else if (basic) {
      const text = decodeBase64(basic[1]!);
      const at = text.indexOf(':');
      if (at !== -1) auth = { type: 'basic', user: text.slice(0, at), password: text.slice(at + 1) };
    }
    if (auth) headers.splice(authIndex, 1);
  }

  let body: CurlBody | undefined;
  const typeIndex = headers.findIndex((h) => h.name.toLowerCase() === 'content-type');
  const contentType = typeIndex === -1 ? '' : headers[typeIndex]!.value;
  const joined = data.join('&');
  if (get && data.length) {
    query.push(...parseForm(joined));
  } else if (parts.length) {
    body = { type: 'multipart', parts };
    if (typeIndex !== -1) headers.splice(typeIndex, 1);
  } else if (data.length) {
    const text = data.length === 1 ? data[0]! : joined;
    const looksJson = /^\s*[[{]/.test(text);
    if (jsonFlag || /json/i.test(contentType) || (!contentType && looksJson && isJson(text))) {
      body = isJson(text) ? { type: 'json', json: JSON.stringify(JSON.parse(text), null, 2) } : { type: 'raw', contentType: contentType || 'application/json', text };
      if (typeIndex !== -1) headers.splice(typeIndex, 1);
    } else if (!contentType || /x-www-form-urlencoded/i.test(contentType)) {
      body = { type: 'form', fields: parseForm(joined) };
      if (typeIndex !== -1) headers.splice(typeIndex, 1);
    } else {
      body = { type: 'raw', contentType, text };
      headers.splice(typeIndex, 1);
    }
  }

  return {
    method: method ?? (head ? 'HEAD' : body ? 'POST' : 'GET'),
    url: parsed.toString(),
    query,
    headers,
    ...(body ? { body } : {}),
    ...(auth ? { auth } : {}),
    insecure,
    ...(timeoutMs ? { timeoutMs } : {}),
    warnings,
  };
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function decodeBase64(text: string): string {
  try {
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Parameters of the HTTP Request node for a parsed command. `auth` is NOT written into the parameters
 * unless `inlineAuth` is set: the editor stores it as a credential instead.
 */
export function curlToHttpParameters(request: CurlRequest, options: { inlineAuth?: boolean } = {}): Record<string, unknown> {
  const headers = [...request.headers];
  if (request.auth && options.inlineAuth) {
    headers.push({
      name: 'Authorization',
      value: request.auth.type === 'bearer' ? `Bearer ${request.auth.token}` : `Basic ${btoa(unescape(encodeURIComponent(`${request.auth.user}:${request.auth.password}`)))}`,
    });
  }
  const p: Record<string, unknown> = {
    method: METHODS.includes(request.method) ? request.method : 'GET',
    url: request.url,
    authentication: request.auth && !options.inlineAuth ? (request.auth.type === 'bearer' ? 'bearerAuth' : 'basicAuth') : 'none',
    sendQuery: request.query.length > 0,
    sendHeaders: headers.length > 0,
    sendBody: Boolean(request.body),
  };
  if (request.query.length) Object.assign(p, { specifyQuery: 'keypair', queryParameters: request.query });
  if (headers.length) Object.assign(p, { specifyHeaders: 'keypair', headerParameters: headers });
  const body = request.body;
  if (body?.type === 'json') Object.assign(p, { contentType: 'json', specifyBody: 'json', jsonBody: body.json });
  else if (body?.type === 'form') Object.assign(p, { contentType: 'form-urlencoded', formParameters: body.fields });
  else if (body?.type === 'multipart') {
    Object.assign(p, {
      contentType: 'multipart-form-data',
      multipartParameters: {
        values: body.parts.map((part) => (part.file !== undefined ? { parameterType: 'formBinaryData', name: part.name, value: '', inputDataFieldName: 'data' } : { parameterType: 'formData', name: part.name, value: part.value ?? '', inputDataFieldName: 'data' })),
      },
    });
  } else if (body?.type === 'raw') Object.assign(p, { contentType: 'raw', rawContentType: body.contentType, body: body.text });
  const extra: Record<string, unknown> = {};
  if (request.insecure) extra.allowUnauthorizedCerts = true;
  if (request.timeoutMs) extra.timeout = request.timeoutMs;
  p.options = extra;
  return p;
}
