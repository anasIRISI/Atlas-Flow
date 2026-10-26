import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { BOOTSTRAP_SOURCE } from './bootstrap.js';
import { BLOCKED_PROPERTIES } from './guard.js';

/** Host function called from inside the sandbox; receives and returns JSON strings only. */
export type Bridge = (op: string, argsJson: string) => string;

const require = createRequire(import.meta.url);
// Luxon's "global" build defines `var luxon` and runs inside the sandbox, so DateTime objects belong to it.
const LUXON_SOURCE = readFileSync(join(dirname(require.resolve('luxon')), '..', 'global', 'luxon.js'), 'utf8');

type RealmFunction = (...args: unknown[]) => unknown;

/**
 * A separate V8 context ("realm") for expressions: own built-ins, no `process`, no `require`,
 * string code generation disabled (no eval / new Function inside).
 */
export class ExpressionRealm {
  private readonly sandbox: Record<string, unknown> = {};
  private readonly context: vm.Context;
  private readonly callScript = new vm.Script('__ffExport(__ffFn.apply(undefined, __ffArgs))', { filename: 'expression' });
  private readonly compiled = new Map<string, RealmFunction>();
  /** The sandbox's own JSON.parse: turns host JSON into sandbox objects. */
  private readonly realmParse: (json: string) => unknown;

  constructor(bridge: Bridge) {
    this.context = vm.createContext(this.sandbox, {
      name: 'flowforge-expressions',
      codeGeneration: { strings: false, wasm: false },
    });
    new vm.Script(LUXON_SOURCE, { filename: 'luxon.js' }).runInContext(this.context);
    const setup = new vm.Script(BOOTSTRAP_SOURCE, { filename: 'bootstrap.js' }).runInContext(this.context) as (
      bridge: Bridge,
      blocked: string[],
    ) => void;
    setup(bridge, BLOCKED_PROPERTIES);
    this.realmParse = vm.runInContext('JSON.parse', this.context) as (json: string) => unknown;
  }

  /** Copies plain host data into the sandbox (no shared references, no host prototypes). */
  toRealm(value: unknown): unknown {
    return value === undefined ? undefined : this.realmParse(JSON.stringify(value));
  }

  /** Compiles a guarded expression once into a sandbox function. */
  compile(code: string): RealmFunction {
    let fn = this.compiled.get(code);
    if (!fn) {
      fn = new vm.Script(
        `(function ($json, $binary, $itemIndex, $runIndex, $parameter) { 'use strict'; return (${code}\n); })`,
        { filename: 'expression' },
      ).runInContext(this.context) as RealmFunction;
      if (this.compiled.size > 5000) this.compiled.clear();
      this.compiled.set(code, fn);
    }
    return fn;
  }

  /** Runs a compiled function with a hard timeout; returns plain host data. */
  run(fn: RealmFunction, args: unknown[], timeoutMs: number): unknown {
    this.sandbox.__ffFn = fn;
    this.sandbox.__ffArgs = args;
    try {
      const out = this.callScript.runInContext(this.context, { timeout: timeoutMs }) as string | undefined;
      return out === undefined ? undefined : (JSON.parse(out) as { v?: unknown }).v;
    } finally {
      this.sandbox.__ffFn = undefined;
      this.sandbox.__ffArgs = undefined;
    }
  }
}
