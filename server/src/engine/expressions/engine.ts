import { isExpression } from '@flowforge/shared';
import { ExpressionError } from '../errors.js';
import { createBridge, type EvalState } from './bridge.js';
import { guardExpression } from './guard.js';
import { ExpressionRealm } from './realm.js';
import type { ExpressionScope } from './scope.js';
import { splitTemplate } from './template.js';

export type { ExpressionScope } from './scope.js';

const DEFAULT_TIMEOUT_MS = 1000;

function hintFor(message: string): string | undefined {
  if (/is not defined/.test(message)) {
    return 'Check the spelling. Data of the current item is available as $json, other nodes as $("Node name").';
  }
  if (/Cannot read propert/.test(message)) {
    return 'A field in the path does not exist on this item. Use optional chaining, e.g. {{ $json.address?.city }}.';
  }
  if (/Code generation from strings disallowed/.test(message)) return 'eval() and new Function() are not allowed in expressions.';
  return undefined;
}

function stringifySegment(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Evaluates n8n-style expressions: parameter strings that start with "=" and contain {{ … }}.
 * One sandbox realm is shared (built-ins are frozen, so evaluations cannot affect each other).
 */
export class ExpressionEngine {
  private readonly realm: ExpressionRealm;
  private readonly guarded = new Map<string, string | ExpressionError>();
  private current?: EvalState;

  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.realm = new ExpressionRealm(createBridge(() => this.current));
  }

  /** Resolves every expression string inside `value` (objects and arrays are walked recursively). */
  resolve(value: unknown, scope: ExpressionScope, itemIndex: number): unknown {
    if (isExpression(value)) return this.evaluate(value, scope, itemIndex);
    if (Array.isArray(value)) return value.map((v) => this.resolve(v, scope, itemIndex));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.resolve(v, scope, itemIndex)]));
    }
    return value;
  }

  /**
   * "={{ $json.age }}" → the raw value (number stays a number).
   * "=Hi {{ $json.name }}!" → a string. A value without "=" is returned unchanged.
   */
  evaluate(expression: string, scope: ExpressionScope, itemIndex: number): unknown {
    if (!isExpression(expression)) return expression;
    const segments = splitTemplate(expression.slice(1));
    if (segments.length === 1 && segments[0]!.kind === 'code') return this.run(segments[0]!.value, scope, itemIndex);
    return segments
      .map((s) => (s.kind === 'text' ? s.value : stringifySegment(this.run(s.value, scope, itemIndex))))
      .join('');
  }

  private guard(code: string): string {
    let result = this.guarded.get(code);
    if (result === undefined) {
      try {
        result = guardExpression(code);
      } catch (err) {
        result = err instanceof ExpressionError ? err : new ExpressionError(String(err));
      }
      if (this.guarded.size > 5000) this.guarded.clear();
      this.guarded.set(code, result);
    }
    if (result instanceof ExpressionError) throw result;
    return result;
  }

  private run(code: string, scope: ExpressionScope, itemIndex: number): unknown {
    if (code.trim() === '') return undefined;
    const fn = this.realm.compile(this.guard(code));
    const item = scope.inputs[0]?.[itemIndex];
    const node = scope.workflow.nodes.find((n) => n.name === scope.nodeName);
    const args = [
      this.realm.toRealm(item?.json ?? {}),
      this.realm.toRealm(item?.binary ?? {}),
      itemIndex,
      scope.runIndex,
      this.realm.toRealm(node?.parameters ?? {}),
    ];
    this.current = { scope, itemIndex };
    try {
      return this.realm.run(fn, args, this.timeoutMs);
    } catch (err) {
      const e = err as { code?: string; message?: string; hint?: string };
      if (e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new ExpressionError(`Expression took longer than ${this.timeoutMs} ms`, {
          expression: code.trim(),
          hint: 'Check for an endless loop inside the expression.',
        });
      }
      let message = typeof e?.message === 'string' ? e.message : String(err);
      let hint = e?.hint;
      // An error thrown inside a global getter ($env, $response…) comes back re-wrapped as
      // "Error: <message>" without its hint: use what the bridge reported.
      const bridged = this.current?.firstError;
      if (bridged && (message === bridged.message || message === `Error: ${bridged.message}`)) {
        message = bridged.message;
        hint ??= bridged.hint;
      }
      throw new ExpressionError(message, { expression: code.trim(), hint: hint ?? hintFor(message) });
    } finally {
      this.current = undefined;
    }
  }
}

let shared: ExpressionEngine | undefined;

/** Process-wide engine (creating the sandbox costs ~20 ms, so it is built once). */
export function getExpressionEngine(): ExpressionEngine {
  shared ??= new ExpressionEngine();
  return shared;
}
