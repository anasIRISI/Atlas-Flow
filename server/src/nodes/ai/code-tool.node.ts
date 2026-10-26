import type { JsonObject } from '@flowforge/shared';
import { getCodeSandbox, type SandboxError } from '../../engine/code/sandbox.js';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { readDeclaredParameters, toSchema, toolIdentity, toolIdentityProperties, TOOL_PARAMETERS_PROPERTY } from '../_shared/ai-tool.js';
import { codeLimits } from '../transform/code.node.js';

// Code tool for the AI Agent: the model calls your JavaScript. It runs in the same QuickJS sandbox as the Code node
// (own memory and time limits, no process, require, network or files).

const DEFAULT_NAME = 'run_code';
const DEFAULT_DESCRIPTION = 'Runs a custom JavaScript function on the given arguments and returns its result.';
const DEFAULT_CODE = `// "input" holds the arguments chosen by the model, "query" is the first text argument.
// Return any JSON value (text, number, object, list).
const text = String(query ?? '');
return { text, length: text.length, words: text.split(/\\s+/).filter(Boolean).length };`;
const MAX_RESULT_CHARS = 20_000;

/** Wraps the user's code: `input` and `query` in scope, the result comes back as a JSON string. */
function buildSource(code: string, input: JsonObject, query: unknown, vars: Record<string, string>, env: Record<string, string> | null): { source: string; lineOffset: number } {
  const head = `"use strict";
const input = ${JSON.stringify(input)};
const query = ${JSON.stringify(query === undefined ? null : query)};
const $vars = ${JSON.stringify(vars)};
const $env = ${env === null ? "new Proxy({}, { get: () => { throw new Error('Access to $env is disabled'); } })" : JSON.stringify(env)};
const __ffLogs = [];
const __ffFormat = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch (e) { return String(v); } };
const console = { log: (...a) => { if (__ffLogs.length < 50) __ffLogs.push(a.map(__ffFormat).join(' ')); } };
console.info = console.log; console.warn = console.log; console.error = console.log; console.debug = console.log;
const __ffRun = async function () {
`;
  const tail = `
};
__ffRun().then((r) => JSON.stringify({ result: r === undefined ? null : r, undef: r === undefined }))`;
  return { source: head + code + tail, lineOffset: head.split('\n').length - 1 };
}

function toToolError(err: SandboxError | Error, lineOffset: number): NodeOperationError {
  const { name, message } = err;
  const stack = 'stack' in err ? String(err.stack ?? '') : '';
  if (name === 'InternalError' && /interrupted/.test(message)) {
    return new NodeOperationError(`The code took longer than ${codeLimits.timeoutMs / 1000} s and was stopped`, { hint: 'Check for an endless loop.' });
  }
  if (/out of memory/i.test(message)) {
    return new NodeOperationError(`The code used more than ${Math.round(codeLimits.memoryLimitBytes / 1024 / 1024)} MB of memory and was stopped`);
  }
  const match = /code\.js:(\d+)/.exec(stack);
  const line = match ? Number(match[1]) - lineOffset : undefined;
  const where = line && line > 0 ? ` [line ${line}]` : '';
  const prefix = name && name !== 'Error' ? `${name}: ` : '';
  return new NodeOperationError(`${prefix}${message}${where}`, {
    hint: name === 'ReferenceError' ? 'Note: require(), process and fetch are not available in the Code tool. Use the variables input and query.' : undefined,
  });
}

export default defineNode({
  description: {
    type: 'flowforge.codeTool',
    displayName: 'Code Tool',
    description: 'Lets the AI Agent run your own JavaScript (sandboxed). The arguments are in `input` and `query`.',
    icon: 'lucide:code',
    group: 'ai-sub',
    version: 1,
    defaults: { name: 'Code Tool', color: '#ff9922' },
    subtitle: '{{toolName}}',
    inputs: [],
    outputs: [{ type: 'ai_tool' }],
    keywords: ['code', 'javascript', 'js', 'function', 'tool', 'agent', 'ai', 'custom'],
  },
  properties: [
    ...toolIdentityProperties(DEFAULT_NAME, DEFAULT_DESCRIPTION),
    {
      ...TOOL_PARAMETERS_PROPERTY,
      default: { parameter: [{ name: 'query', description: 'The text to process', type: 'string', required: true }] },
    },
    {
      name: 'jsCode',
      displayName: 'JavaScript',
      type: 'code',
      default: DEFAULT_CODE,
      noDataExpression: true,
      typeOptions: { language: 'javascript', rows: 10 },
    },
    {
      name: 'notice',
      displayName: 'Available: input (the arguments object), query (the first text argument), $vars, $env, console.log(). Not available: require, fetch, process, files. Return a JSON value.',
      type: 'notice',
      default: '',
    },
  ],
  supplyData(ctx, itemIndex) {
    const { name, description } = toolIdentity(ctx, itemIndex, DEFAULT_NAME, DEFAULT_DESCRIPTION);
    const code = String(ctx.getRawParameter('jsCode') ?? '');
    if (!code.trim()) throw new NodeOperationError('The JavaScript code is empty', { itemIndex, hint: 'Write the code the tool should run and end it with a "return".' });
    const parameters = readDeclaredParameters(ctx, itemIndex);
    const vars = ctx.getVariables();
    const env = ctx.getEnv();

    return {
      name,
      description,
      parameters: toSchema(parameters),
      invoke: async (args, { signal }) => {
        // Only declared parameters reach the code.
        const input: JsonObject = {};
        for (const p of parameters) {
          const value = args[p.name];
          if (value === undefined || value === null) {
            if (p.required) throw new Error(`Missing argument "${p.name}"`);
            continue;
          }
          input[p.name] = value;
        }
        const query = parameters.map((p) => input[p.name]).find((v) => typeof v === 'string');
        const { source, lineOffset } = buildSource(code, input, query, vars, env);

        let raw: string;
        try {
          raw = await getCodeSandbox().run({ source, ...codeLimits, signal });
        } catch (err) {
          if (signal.aborted) throw signal.reason;
          throw toToolError(err as SandboxError, lineOffset);
        }
        const { result, undef } = JSON.parse(raw) as { result: unknown; undef?: boolean };
        if (undef) throw new NodeOperationError('The code did not return anything', { hint: 'End the code with "return <value>;".' });
        const text = JSON.stringify(result);
        if (text.length > MAX_RESULT_CHARS) return `${text.slice(0, MAX_RESULT_CHARS)}… [cut: the result is ${text.length} characters long]`;
        return result;
      },
    };
  },
});
