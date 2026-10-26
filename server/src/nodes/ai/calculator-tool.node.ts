import { runInNewContext } from 'node:vm';
import type { FactoryFunctionMap, MathJsInstance } from 'mathjs';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { toolIdentity, toolIdentityProperties } from '../_shared/ai-tool.js';

// Calculator tool for the AI Agent: evaluates one math expression with mathjs.
// Docs: https://mathjs.org/docs/expressions/syntax.html
// Security: https://mathjs.org/docs/expressions/security.html (private instance, dangerous functions disabled,
// expression length limit, hard time limit through the vm module).

const DEFAULT_NAME = 'calculator';
const DEFAULT_DESCRIPTION =
  'Evaluates a math expression and returns the exact result. Use it for any arithmetic, percentages, powers, ' +
  'trigonometry, statistics or unit conversion (for example "12.5 * (3 + 4)", "sqrt(144)", "sin(30 deg)", "5 cm to inch"). ' +
  'Never calculate in your head: always call this tool.';

export const MAX_EXPRESSION_LENGTH = 1000;
export const TIME_LIMIT_MS = 1000;
const MAX_RESULT_CHARS = 2000;

/** Disabled as the mathjs security page advises, plus `config` (it would change the shared instance; `typed` must stay: mathjs functions call it). */
const DISABLED = ['import', 'createUnit', 'evaluate', 'parse', 'simplify', 'derivative', 'resolve', 'reviver', 'config'];

interface Calculator {
  math: MathJsInstance;
  evaluate: (expression: string) => unknown;
}

let calculator: Calculator | undefined;

// mathjs takes about a second to load: it is imported on the first calculation, not when the server starts.
async function getCalculator(): Promise<Calculator> {
  if (calculator) return calculator;
  const { all, create } = await import('mathjs');
  const math = create(all as FactoryFunctionMap);
  // Keep the real function for ourselves, then make every way to run text (or to change the instance) fail.
  const evaluate = math.evaluate.bind(math) as (expression: string) => unknown;
  const blocked = Object.fromEntries(
    DISABLED.map((name) => [
      name,
      () => {
        throw new Error(`Function ${name} is disabled in the Calculator tool`);
      },
    ]),
  );
  math.import(blocked, { override: true });
  calculator = { math, evaluate };
  return calculator;
}

/** A number when it is exact enough, otherwise a text such as "1.9685039370079 inch". */
function toResult(math: MathJsInstance, value: unknown): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  const text = math.format(value, { precision: 14 });
  if (typeof value === 'number' && Number.isFinite(value)) return Number(text);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… (cut)` : text;
}

export async function calculate(expression: unknown): Promise<{ expression: string; result: number | string }> {
  const text = typeof expression === 'number' ? String(expression) : typeof expression === 'string' ? expression.trim() : '';
  if (!text) throw new Error('The expression is empty: give a math expression such as "12 * (3 + 4)"');
  if (text.length > MAX_EXPRESSION_LENGTH) throw new Error(`The expression is too long (${text.length} characters, the limit is ${MAX_EXPRESSION_LENGTH})`);
  const { math, evaluate } = await getCalculator();
  let value: unknown;
  try {
    // Hard stop for a runaway expression (huge factorial, giant matrix…): the watchdog interrupts the running JavaScript.
    value = runInNewContext('fn()', { fn: () => evaluate(text) }, { timeout: TIME_LIMIT_MS });
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new Error(`The calculation took longer than ${TIME_LIMIT_MS / 1000} s and was stopped: use a simpler expression`);
    throw new Error(`Could not calculate "${text.length > 80 ? `${text.slice(0, 80)}…` : text}": ${e.message}`);
  }
  return { expression: text, result: toResult(math, value) };
}

export default defineNode({
  description: {
    type: 'flowforge.calculatorTool',
    displayName: 'Calculator',
    description: 'Lets the AI Agent calculate: arithmetic, functions and unit conversion (mathjs).',
    icon: 'lucide:calculator',
    group: 'ai-sub',
    version: 1,
    defaults: { name: 'Calculator', color: '#8b5cf6' },
    subtitle: '{{toolName}}',
    inputs: [],
    outputs: [{ type: 'ai_tool' }],
    keywords: ['calculator', 'math', 'calculate', 'tool', 'agent', 'ai', 'arithmetic', 'units'],
  },
  properties: [
    ...toolIdentityProperties(DEFAULT_NAME, DEFAULT_DESCRIPTION),
    {
      name: 'notice',
      displayName: 'Evaluates math expressions with mathjs: + - * / ^, sqrt(), sin(), log(), mean(), units such as "5 cm to inch". Functions that run code (evaluate, parse, import…) are disabled.',
      type: 'notice',
      default: '',
    },
  ],
  supplyData(ctx, itemIndex) {
    const { name, description } = toolIdentity(ctx, itemIndex, DEFAULT_NAME, DEFAULT_DESCRIPTION);
    return {
      name,
      description,
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'The math expression to evaluate, e.g. "(12 + 8) * 1.2" or "sqrt(81) + 2^10".' } },
        required: ['expression'],
      },
      invoke: async (args) => {
        try {
          return await calculate(args.expression);
        } catch (err) {
          throw err instanceof NodeOperationError ? err : new NodeOperationError((err as Error).message);
        }
      },
    };
  },
});
