import { describe, expect, it } from 'vitest';
import { CurlParseError, curlToHttpParameters, parseCurl, tokenizeCommand } from '../src/editor/params/curl';

describe('command tokenizer', () => {
  it('follows shell quoting: single, double, ANSI-C quotes, escapes and line continuations', () => {
    expect(tokenizeCommand(`curl 'a b' "c \\"d\\" $x" e\\ f`)).toEqual(['curl', 'a b', 'c "d" $x', 'e f']);
    expect(tokenizeCommand(`curl -H 'A: 1' \\\n  -H "B: 2"`)).toEqual(['curl', '-H', 'A: 1', '-H', 'B: 2']);
    expect(tokenizeCommand(`curl $'line1\\nline2 it\\'s \\x41\\u00e9'`)).toEqual(['curl', "line1\nline2 it's Aé"]);
    expect(tokenizeCommand(`curl -H'X: 1' ''`)).toEqual(['curl', '-HX: 1', '']);
    expect(tokenizeCommand('curl "https://x.test/a" `\n -X POST')).toEqual(['curl', 'https://x.test/a', '-X', 'POST']);
    // cmd.exe carets (Chrome "Copy as cURL (cmd)").
    expect(tokenizeCommand('curl ^"https://x.test/?a=1^&b=2^" ^\n  -H ^"accept: */*^"')).toEqual(['curl', 'https://x.test/?a=1&b=2', '-H', 'accept: */*']);
    expect(tokenizeCommand('curl ^"https://x.test^" --data-raw ^"^{^\\^"a^\\^":1^}^"')).toEqual(['curl', 'https://x.test', '--data-raw', '{"a":1}']);
    expect(() => tokenizeCommand(`curl 'oops`)).toThrow("A single quote (') is never closed");
    expect(() => tokenizeCommand(`curl "oops`)).toThrow('A double quote (") is never closed');
  });
});

describe('parseCurl', () => {
  it('a simple GET with query string and headers', () => {
    const r = parseCurl(`curl 'https://api.example.com/users?page=2&q=a%20b' -H 'Accept: application/json' -H "X-Trace: abc:def"`);
    expect(r).toEqual({
      method: 'GET',
      url: 'https://api.example.com/users',
      query: [{ name: 'page', value: '2' }, { name: 'q', value: 'a b' }],
      headers: [{ name: 'Accept', value: 'application/json' }, { name: 'X-Trace', value: 'abc:def' }],
      insecure: false,
      warnings: [],
    });
  });

  it('a JSON POST as copied from API docs (multi-line, --data, -X)', () => {
    const r = parseCurl(`$ curl -X POST https://api.example.com/v1/orders \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer sk_test_123" \\
      --data '{"item":"pen","qty":2,"tags":["a","b"]}'`);
    expect(r.method).toBe('POST');
    expect(r.body).toEqual({ type: 'json', json: '{\n  "item": "pen",\n  "qty": 2,\n  "tags": [\n    "a",\n    "b"\n  ]\n}' });
    // The token is not left in the headers: it becomes a credential.
    expect(r.auth).toEqual({ type: 'bearer', token: 'sk_test_123' });
    expect(r.headers).toEqual([]);
  });

  it('form bodies: -d pairs, several -d, --data-urlencode, implicit POST', () => {
    const r = parseCurl(`curl https://x.test/login -d 'user=ada' -d pass=p%40ss --data-urlencode 'note=a b&c'`);
    expect(r.method).toBe('POST');
    expect(r.body).toEqual({ type: 'form', fields: [{ name: 'user', value: 'ada' }, { name: 'pass', value: 'p@ss' }, { name: 'note', value: 'a b&c' }] });
  });

  it('-G moves the data to the query string', () => {
    const r = parseCurl(`curl -G https://x.test/search -d q=flow -d limit=5`);
    expect(r).toMatchObject({ method: 'GET', query: [{ name: 'q', value: 'flow' }, { name: 'limit', value: '5' }] });
    expect(r.body).toBeUndefined();
  });

  it('multipart forms with fields and files', () => {
    const r = parseCurl(`curl -F 'title=My file' -F "file=@/tmp/report.pdf;type=application/pdf" https://x.test/upload`);
    expect(r.method).toBe('POST');
    expect(r.body).toEqual({ type: 'multipart', parts: [{ name: 'title', value: 'My file' }, { name: 'file', file: '/tmp/report.pdf' }] });
  });

  it('raw bodies keep their content type; --json; data that only looks like JSON', () => {
    expect(parseCurl(`curl -X PUT https://x.test/a -H 'Content-Type: text/xml' -d '<a>1</a>'`).body).toEqual({ type: 'raw', contentType: 'text/xml', text: '<a>1</a>' });
    expect(parseCurl(`curl https://x.test/a --json '{"a":1}'`).body).toEqual({ type: 'json', json: '{\n  "a": 1\n}' });
    expect(parseCurl(`curl https://x.test/a -d '{"a":1}'`).body).toEqual({ type: 'json', json: '{\n  "a": 1\n}' });
    expect(parseCurl(`curl https://x.test/a -H 'content-type: application/json' -d '{broken'`).body).toEqual({ type: 'raw', contentType: 'application/json', text: '{broken' });
  });

  it('authentication: -u, user:pass@host, Basic and Bearer headers', () => {
    expect(parseCurl(`curl -u ada:s3:cret https://x.test/a`).auth).toEqual({ type: 'basic', user: 'ada', password: 's3:cret' });
    const inUrl = parseCurl(`curl https://ada:p%40ss@x.test/a`);
    expect(inUrl.auth).toEqual({ type: 'basic', user: 'ada', password: 'p@ss' });
    expect(inUrl.url).toBe('https://x.test/a');
    expect(parseCurl(`curl https://x.test/a -H 'authorization: Basic YWRhOnPDqWNyZXQ='`).auth).toEqual({ type: 'basic', user: 'ada', password: 'sécret' });
    expect(parseCurl(`curl https://x.test/a --oauth2-bearer tok`).auth).toEqual({ type: 'bearer', token: 'tok' });
    // Other schemes stay a normal header.
    const other = parseCurl(`curl https://x.test/a -H 'Authorization: Token abc'`);
    expect(other.auth).toBeUndefined();
    expect(other.headers).toEqual([{ name: 'Authorization', value: 'Token abc' }]);
  });

  it('switches: combined short flags, attached values, -I, -k, -m, cookies, user agent', () => {
    const r = parseCurl(`curl -sSLk -XDELETE -m 2.5 -A 'my-agent/1' -b 'sid=abc; theme=dark' -e https://ref.test --compressed https://x.test/item/7`);
    expect(r).toMatchObject({
      method: 'DELETE',
      insecure: true,
      timeoutMs: 2500,
      headers: [{ name: 'User-Agent', value: 'my-agent/1' }, { name: 'Cookie', value: 'sid=abc; theme=dark' }, { name: 'Referer', value: 'https://ref.test' }],
    });
    expect(parseCurl('curl -I https://x.test').method).toBe('HEAD');
    expect(parseCurl('curl --header=Accept:text/plain --request=PATCH --url=https://x.test/y').headers).toEqual([{ name: 'Accept', value: 'text/plain' }]);
    expect(parseCurl('curl x.test/path').url).toBe('http://x.test/path');
  });

  it('a real "Copy as cURL" from Chrome', () => {
    const r = parseCurl(`curl 'https://api.github.com/repos/n8n-io/n8n/issues?state=open&per_page=5' \\
  -H 'accept: application/vnd.github+json' \\
  -H 'accept-language: en-GB,en;q=0.9' \\
  -H 'sec-ch-ua: "Chromium";v="124", "Not-A.Brand";v="99"' \\
  -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' \\
  --compressed`);
    expect(r.url).toBe('https://api.github.com/repos/n8n-io/n8n/issues');
    expect(r.query).toEqual([{ name: 'state', value: 'open' }, { name: 'per_page', value: '5' }]);
    expect(r.headers).toHaveLength(4);
    expect(r.headers[2]).toEqual({ name: 'sec-ch-ua', value: '"Chromium";v="124", "Not-A.Brand";v="99"' });
  });

  it('what cannot be imported is reported, not silently dropped', () => {
    const r = parseCurl(`curl https://x.test/a https://x.test/b -d @body.json --proxy http://p:8080 -b cookies.txt`);
    expect(r.warnings).toEqual([
      'Only the first URL was imported (ignored: https://x.test/b).',
      'The body comes from the file body.json: paste its content into the body.',
      'The option --proxy is not supported and was ignored.',
      'Cookies from the file cookies.txt were not imported.',
    ]);
  });

  it('errors are readable', () => {
    const fail = (command: string) => {
      try {
        parseCurl(command);
      } catch (err) {
        expect(err).toBeInstanceOf(CurlParseError);
        return (err as Error).message;
      }
      return 'no error';
    };
    expect(fail('')).toBe('Paste a curl command first');
    expect(fail('wget https://x.test')).toBe('The command must start with "curl"');
    expect(fail('curl -X POST')).toBe('No URL found in the command');
    expect(fail('curl -H')).toBe('The option -H needs a value');
    expect(fail('curl ftp://x.test/file')).toBe('Only http:// and https:// URLs can be imported (got ftp://)');
    expect(fail('curl "http://exa mple"')).toBe('"http://exa mple" is not a valid URL');
  });
});

describe('curlToHttpParameters', () => {
  it('fills the HTTP Request parameters; secrets are left for a credential', () => {
    const request = parseCurl(`curl -X POST 'https://api.example.com/v1/orders?dry=1' -H 'X-Trace: 1' -H 'Authorization: Bearer sk_123' -k -m 3 -d '{"qty":2}'`);
    expect(curlToHttpParameters(request)).toEqual({
      method: 'POST',
      url: 'https://api.example.com/v1/orders',
      authentication: 'bearerAuth',
      sendQuery: true,
      specifyQuery: 'keypair',
      queryParameters: [{ name: 'dry', value: '1' }],
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: [{ name: 'X-Trace', value: '1' }],
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '{\n  "qty": 2\n}',
      options: { allowUnauthorizedCerts: true, timeout: 3000 },
    });
    expect(JSON.stringify(curlToHttpParameters(request))).not.toContain('sk_123');
    // When the user prefers to keep the secret in the node, it stays a header.
    const inline = curlToHttpParameters(request, { inlineAuth: true });
    expect(inline.authentication).toBe('none');
    expect(inline.headerParameters).toEqual([{ name: 'X-Trace', value: '1' }, { name: 'Authorization', value: 'Bearer sk_123' }]);
    expect(curlToHttpParameters(parseCurl('curl -u ada:pw https://x.test'), { inlineAuth: true }).headerParameters).toEqual([{ name: 'Authorization', value: 'Basic YWRhOnB3' }]);
  });

  it('form, multipart and raw bodies; a plain GET', () => {
    expect(curlToHttpParameters(parseCurl('curl https://x.test -d a=1'))).toMatchObject({ method: 'POST', sendBody: true, contentType: 'form-urlencoded', formParameters: [{ name: 'a', value: '1' }] });
    expect(curlToHttpParameters(parseCurl('curl https://x.test -F a=1 -F f=@x.png'))).toMatchObject({
      contentType: 'multipart-form-data',
      multipartParameters: { values: [{ parameterType: 'formData', name: 'a', value: '1', inputDataFieldName: 'data' }, { parameterType: 'formBinaryData', name: 'f', value: '', inputDataFieldName: 'data' }] },
    });
    expect(curlToHttpParameters(parseCurl(`curl https://x.test -H 'Content-Type: text/csv' -d 'a,b'`))).toMatchObject({ contentType: 'raw', rawContentType: 'text/csv', body: 'a,b', sendHeaders: false });
    expect(curlToHttpParameters(parseCurl('curl https://x.test/y'))).toEqual({ method: 'GET', url: 'https://x.test/y', authentication: 'none', sendQuery: false, sendHeaders: false, sendBody: false, options: {} });
    expect(curlToHttpParameters(parseCurl('curl -X PURGE https://x.test/y')).method).toBe('GET');
  });
});
