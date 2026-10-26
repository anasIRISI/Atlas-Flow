/**
 * JavaScript that runs INSIDE the expression sandbox (a separate V8 realm, see realm.ts).
 * It receives a host "bridge" function, keeps it in a closure (never on the global object),
 * builds the $-API on top of it, installs n8n-style helper methods and freezes the built-ins.
 * Only JSON strings cross the bridge, so no host object can leak into the sandbox.
 */
export const BOOTSTRAP_SOURCE = String.raw`
(function setup(bridge, blockedKeys) {
  'use strict';
  const { DateTime, Duration, Interval, Settings, Info, FixedOffsetZone, IANAZone } = luxon;
  const BLOCKED = new Set(blockedKeys);
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const defineGlobal = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: false, configurable: false, enumerable: false });
  const defineGetter = (name, get) =>
    Object.defineProperty(globalThis, name, { get, configurable: false, enumerable: false });

  function call(op, args) {
    const envelope = parse(bridge(op, stringify(args === undefined ? [] : args)));
    if (envelope.e !== undefined) {
      const error = new Error(envelope.e);
      if (envelope.h) error.hint = envelope.h;
      throw error;
    }
    return envelope.u ? undefined : envelope.v;
  }

  // Runtime guard for obj[key] (inserted by the AST guard around every computed key).
  defineGlobal('__ffKey', function (key) {
    if (typeof key === 'symbol') return key;
    if (typeof key === 'number') return key;
    const name = String(key);
    if (BLOCKED.has(name)) throw new Error('"' + name + '" is not allowed in expressions');
    return name;
  });

  // Result export: DateTime/Date/Duration become ISO strings through their toJSON().
  defineGlobal('__ffExport', function (value) {
    if (typeof value === 'function') {
      throw new TypeError('The expression returned a function. Did you forget the () to call it?');
    }
    if (value === undefined) return undefined;
    return stringify({ v: value }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  });

  // ── $ API ────────────────────────────────────────────────────────────────
  function nodeAccessor(name) {
    if (typeof name !== 'string' || name === '') {
      throw new Error('$() needs a node name, for example $("HTTP Request")');
    }
    return Object.freeze({
      all: (branchIndex, runIndex) => call('node.all', [name, branchIndex, runIndex]),
      first: (branchIndex, runIndex) => call('node.first', [name, branchIndex, runIndex]),
      last: (branchIndex, runIndex) => call('node.last', [name, branchIndex, runIndex]),
      itemMatching: (index) => call('node.itemMatching', [name, index]),
      get item() { return call('node.item', [name]); },
      get isExecuted() { return call('node.isExecuted', [name]); },
      get params() { return call('node.params', [name]); },
      get runIndex() { return call('node.runIndex', [name]); },
    });
  }
  defineGlobal('$', nodeAccessor);

  defineGlobal('$node', new Proxy(Object.freeze({}), {
    get(_target, name) {
      if (typeof name !== 'string') return undefined;
      return Object.freeze({
        get json() { return call('legacy.json', [name]); },
        get binary() { return call('legacy.binary', [name]); },
        get parameter() { return call('node.params', [name]); },
        get runIndex() { return call('node.runIndex', [name]); },
      });
    },
  }));

  defineGlobal('$input', Object.freeze({
    all: (inputIndex) => call('input.all', [inputIndex]),
    first: (inputIndex) => call('input.first', [inputIndex]),
    last: (inputIndex) => call('input.last', [inputIndex]),
    get item() { return call('input.item', []); },
    get params() { return call('input.params', []); },
  }));

  defineGlobal('$items', (nodeName, outputIndex, runIndex) => call('items', [nodeName, outputIndex, runIndex]));
  defineGetter('$prevNode', () => call('prevNode', []));
  defineGetter('$workflow', () => call('workflow', []));
  defineGetter('$execution', () => call('execution', []));
  defineGetter('$env', () => call('env', []));
  defineGetter('$vars', () => call('vars', []));
  // HTTP Request pagination: the previous response and the number of requests made so far.
  defineGetter('$response', () => call('extra', ['$response']));
  defineGetter('$pageCount', () => call('extra', ['$pageCount']));
  defineGetter('$now', () => DateTime.now().setZone(call('tz', [])));
  defineGetter('$today', () => DateTime.now().setZone(call('tz', [])).startOf('day'));
  defineGlobal('DateTime', DateTime);
  defineGlobal('Duration', Duration);
  defineGlobal('Interval', Interval);

  const isEmptyValue = (v) =>
    v === undefined || v === null || v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
  defineGlobal('$jmespath', (data, expression) => call('jmespath', [data, expression]));
  defineGlobal('$if', (condition, whenTrue, whenFalse) => (condition ? whenTrue : whenFalse));
  defineGlobal('$ifEmpty', (value, fallback) => (isEmptyValue(value) ? fallback : value));
  defineGlobal('$min', (...values) => Math.min(...values));
  defineGlobal('$max', (...values) => Math.max(...values));

  // ── n8n-style data transformation functions ──────────────────────────────
  // Installed as accessors: reading returns the method, but assigning (e.g. Luxon's this.values = …)
  // creates an own property instead of failing on the frozen prototype ("override mistake").
  const extend = (proto, methods) => {
    for (const [name, fn] of Object.entries(methods)) {
      Object.defineProperty(proto, name, {
        get() { return fn; },
        set(value) {
          if (this === proto) throw new TypeError('Cannot change built-in method ' + name);
          Object.defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });
        },
        configurable: false,
        enumerable: false,
      });
    }
  };
  const words = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
  const URL_RE = /https?:\/\/[^\s"'<>]+/;
  const toDateTime = (value) => {
    if (typeof value === 'number') return DateTime.fromMillis(value, { zone: call('tz', []) });
    const s = String(value);
    let dt = DateTime.fromISO(s, { zone: call('tz', []) });
    if (!dt.isValid) dt = DateTime.fromRFC2822(s);
    if (!dt.isValid) dt = DateTime.fromHTTP(s);
    if (!dt.isValid) dt = DateTime.fromSQL(s);
    if (!dt.isValid) throw new Error('"' + s + '" is not a recognised date');
    return dt;
  };

  extend(String.prototype, {
    isEmpty() { return this.length === 0; },
    isNotEmpty() { return this.length > 0; },
    toTitleCase() { return this.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()); },
    toSentenceCase() { const s = this.toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); },
    toSnakeCase() { return words(String(this)).map((w) => w.toLowerCase()).join('_'); },
    toCamelCase() {
      return words(String(this)).map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
    },
    extractEmail() { const m = EMAIL.exec(this); return m ? m[0] : undefined; },
    extractUrl() { const m = URL_RE.exec(this); return m ? m[0] : undefined; },
    extractDomain() {
      const s = String(this);
      const m = EMAIL.test(s) && !URL_RE.test(s) ? /@([\w.-]+)/.exec(s) : /^(?:https?:\/\/)?([^/:?#]+)/.exec(s);
      return m ? m[1].replace(/^www\./, '') : undefined;
    },
    isEmail() { return /^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(this); },
    isUrl() { return /^https?:\/\/[^\s]+$/.test(this); },
    isNumeric() { return this.trim() !== '' && !Number.isNaN(Number(this)); },
    toNumber() {
      const n = Number(this);
      if (this.trim() === '' || Number.isNaN(n)) throw new Error('"' + this + '" cannot be converted to a number');
      return n;
    },
    toBoolean() { return !['false', '0', 'no', 'off', ''].includes(this.trim().toLowerCase()); },
    toDateTime() { return toDateTime(this); },
    removeTags() { return this.replace(/<[^>]*>/g, ''); },
    replaceSpecialChars() { return this.normalize('NFD').replace(/[̀-ͯ]/g, ''); },
    urlEncode() { return encodeURIComponent(this); },
    urlDecode() { return decodeURIComponent(this); },
    base64Encode() { return call('base64', [String(this), 'encode']); },
    base64Decode() { return call('base64', [String(this), 'decode']); },
    hash(algorithm = 'md5') { return call('hash', [String(this), algorithm]); },
    quote(mark = '"') { return mark + this.replaceAll(mark, '\\' + mark) + mark; },
    parseJson() { return parse(this); },
  });

  extend(Array.prototype, {
    first() { return this[0]; },
    last() { return this[this.length - 1]; },
    isEmpty() { return this.length === 0; },
    isNotEmpty() { return this.length > 0; },
    sum() { return this.reduce((a, b) => a + Number(b), 0); },
    average() { return this.length ? this.sum() / this.length : 0; },
    min() { return Math.min(...this); },
    max() { return Math.max(...this); },
    removeDuplicates(key) {
      const seen = new Set();
      return this.filter((v) => {
        const k = stringify(key && v && typeof v === 'object' ? v[key] : v);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    },
    unique(key) { return this.removeDuplicates(key); },
    compact() { return this.filter((v) => !isEmptyValue(v)); },
    chunk(size) {
      const out = [];
      for (let i = 0; i < this.length; i += size) out.push(this.slice(i, i + size));
      return out;
    },
    pluck(...fields) {
      return this.map((v) => (fields.length === 1 ? v?.[fields[0]] : Object.fromEntries(fields.map((f) => [f, v?.[f]]))));
    },
    randomItem() { return this[Math.floor(Math.random() * this.length)]; },
    difference(other) { const s = new Set(other.map((v) => stringify(v))); return this.filter((v) => !s.has(stringify(v))); },
    intersection(other) { const s = new Set(other.map((v) => stringify(v))); return this.filter((v) => s.has(stringify(v))); },
    union(other) { return this.concat(other).removeDuplicates(); },
    smartJoin(keyField, valueField) { return Object.fromEntries(this.map((v) => [v[keyField], v[valueField]])); },
    toJsonString() { return stringify(this); },
  });

  extend(Number.prototype, {
    round(decimals = 0) { const f = 10 ** decimals; return Math.round(this * f) / f; },
    floor() { return Math.floor(this); },
    ceil() { return Math.ceil(this); },
    abs() { return Math.abs(this); },
    isEven() { return this % 2 === 0; },
    isOdd() { return Math.abs(this % 2) === 1; },
    isInteger() { return Number.isInteger(this.valueOf()); },
    format(locales, options) { return this.toLocaleString(locales, options); },
    toBoolean() { return this.valueOf() !== 0; },
    toDateTime(unit = 'ms') {
      const zone = call('tz', []);
      return unit === 's' || unit === 'seconds' ? DateTime.fromSeconds(this.valueOf(), { zone }) : DateTime.fromMillis(this.valueOf(), { zone });
    },
  });

  extend(Object.prototype, {
    isEmpty() { return Object.keys(this).length === 0; },
    isNotEmpty() { return Object.keys(this).length > 0; },
    keys() { return Object.keys(this); },
    values() { return Object.values(this); },
    hasField(name) { return Object.prototype.hasOwnProperty.call(this, name); },
    removeField(name) { const copy = { ...this }; delete copy[name]; return copy; },
    compact() { return Object.fromEntries(Object.entries(this).filter(([, v]) => !isEmptyValue(v))); },
    merge(other) { return { ...other, ...this }; },
    toJsonString() { return stringify(this); },
  });

  // ── Freeze everything reachable so expressions cannot change shared state ────────
  const freezeDeep = (target) => {
    if (target === null || (typeof target !== 'object' && typeof target !== 'function') || Object.isFrozen(target)) return;
    Object.freeze(target);
    if (typeof target === 'function' && target.prototype) freezeDeep(target.prototype);
  };
  [
    Object, Array, String, Number, Boolean, Symbol, BigInt, Date, RegExp, Map, Set, WeakMap, WeakSet, Promise,
    Function, Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError, Math, JSON, Intl,
    ArrayBuffer, DataView, Proxy, luxon, DateTime, Duration, Interval, Settings, Info, FixedOffsetZone, IANAZone,
  ].forEach(freezeDeep);
  Object.getOwnPropertyNames(Intl).forEach((k) => freezeDeep(Intl[k]));
  freezeDeep(Object.getPrototypeOf(function* () {}));
  freezeDeep(Object.getPrototypeOf(async function () {}));
  freezeDeep(Object.getPrototypeOf(Int8Array));
})
`;
