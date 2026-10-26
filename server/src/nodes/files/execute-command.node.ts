import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode, type ExecuteContext } from '../../engine/types.js';

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a shell command; output is capped, the process is killed on timeout or when the execution stops. */
function runCommand(command: string, cwd: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd, windowsHide: true, env: process.env });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let size = 0;
    let timedOut = false;
    const collect = (name: 'stdout' | 'stderr') => (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT_BYTES) chunks[name].push(chunk);
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
    };
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('close', (exitCode) => {
      done();
      const text = (name: 'stdout' | 'stderr') => Buffer.concat(chunks[name]).toString('utf8').replace(/\r?\n$/, '');
      resolve({ exitCode, stdout: text('stdout'), stderr: text('stderr'), timedOut });
    });
  });
}

/** Thrown before anything runs when the node is switched off (the default). */
export function assertExecuteCommandEnabled(ctx: Pick<ExecuteContext, 'getInstanceSetting'>): void {
  if (ctx.getInstanceSetting('executeCommandEnabled') !== true) {
    throw new NodeOperationError('The Execute Command node is disabled', {
      description: 'It runs shell commands on the computer where FlowForge is installed, so it is off by default.',
      hint: 'An administrator can turn it on in Settings → Security → "Allow the Execute Command node".',
    });
  }
}

export default defineNode({
  description: {
    type: 'flowforge.executeCommand',
    displayName: 'Execute Command',
    description: 'Runs a shell command on this computer. Disabled by default: enable it in Settings.',
    icon: 'lucide:terminal',
    group: 'files',
    version: 1,
    defaults: { name: 'Execute Command', color: '#e0503f' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['shell', 'bash', 'terminal', 'script', 'cmd', 'exec', 'system', 'command line'],
  },
  properties: [
    {
      name: 'notice',
      displayName: 'Commands run on the computer where FlowForge is installed, with the same rights as FlowForge. This node only works after it is enabled in Settings → Security.',
      type: 'notice',
      default: '',
    },
    { name: 'executeOnce', displayName: 'Execute Once', type: 'boolean', default: true, description: 'On: run the command a single time. Off: once per input item.' },
    { name: 'command', displayName: 'Command', type: 'string', default: '', required: true, typeOptions: { rows: 3 }, placeholder: 'e.g. echo "Hello from FlowForge"' },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [{ name: 'timeout', displayName: 'Timeout (Seconds)', type: 'number', default: 60, typeOptions: { minValue: 1, maxValue: 3600 } }],
    },
  ],
  async execute(ctx) {
    assertExecuteCommandEnabled(ctx);
    let cwd: string | undefined;
    try {
      cwd = ctx.getFilesRoot();
      if (!existsSync(cwd)) cwd = undefined;
    } catch {
      cwd = undefined;
    }
    const once = ctx.getNodeParameter<boolean>('executeOnce', 0, true) !== false;
    const run = async (i: number): Promise<JsonObject> => {
      const command = String(ctx.getNodeParameter('command', i, '') ?? '').trim();
      if (!command) throw new NodeOperationError('The command is empty', { itemIndex: i, hint: 'Enter a command, e.g. echo "hello".' });
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      const timeoutS = Math.min(Math.max(Number(options.timeout ?? 60) || 60, 1), 3600);
      let result: CommandResult;
      try {
        result = await runCommand(command, cwd, timeoutS * 1000, ctx.signal);
      } catch (err) {
        throw new NodeOperationError(`The command could not be started: ${err instanceof Error ? err.message : String(err)}`, { itemIndex: i });
      }
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (result.timedOut) throw new NodeOperationError(`The command did not finish within ${timeoutS} s and was stopped`, { itemIndex: i, hint: 'Raise the timeout in the options.' });
      if (result.exitCode !== 0) {
        throw new NodeOperationError(`The command failed with exit code ${result.exitCode ?? 'unknown'}`, {
          itemIndex: i,
          description: (result.stderr || result.stdout).slice(0, 2000) || undefined,
        });
      }
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    };

    // A failure of the single run is handled by the engine ("On Error" of the node).
    if (once) return [[{ json: await run(0), ...(ctx.getInputData().length ? { pairedItem: { item: 0 } } : {}) }]];
    return [await ctx.forEachItem(async (_item, i) => ({ json: await run(i) }))];
  },
});
