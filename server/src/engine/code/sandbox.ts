import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { WORKER_SOURCE } from './worker-source.js';

const require = createRequire(import.meta.url);

export interface SandboxError {
  name: string;
  message: string;
  stack: string;
}

export interface SandboxTask {
  source: string;
  timeoutMs: number;
  memoryLimitBytes: number;
  signal?: AbortSignal;
}

interface Pending {
  id: number;
  task: SandboxTask;
  resolve: (output: string) => void;
  reject: (err: SandboxError | Error) => void;
}

interface Slot {
  worker: Worker;
  current?: Pending & { cleanup: () => void };
}

/**
 * Pool of worker threads running QuickJS. A stuck or crashed worker is terminated and replaced,
 * so user code can never block or crash the server.
 */
export class CodeSandbox {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private nextId = 1;
  private closed = false;

  constructor(private readonly size = 2) {}

  run(task: SandboxTask): Promise<string> {
    if (this.closed) return Promise.reject(new Error('The code sandbox is shut down'));
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, task, resolve, reject });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
    this.slots.length = 0;
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        corePath: require.resolve('quickjs-emscripten-core'),
        variantPath: require.resolve('@jitl/quickjs-wasmfile-release-sync'),
      },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    worker.unref();
    const slot: Slot = { worker };
    worker.on('message', (msg: { id: number; ok: boolean; output?: string; error?: SandboxError }) => {
      const current = slot.current;
      if (!current || current.id !== msg.id) return;
      current.cleanup();
      slot.current = undefined;
      if (msg.ok) current.resolve(msg.output ?? 'null');
      else current.reject(msg.error ?? { name: 'Error', message: 'Unknown error', stack: '' });
      this.dispatch();
    });
    const onDeath = (reason: string) => {
      const current = slot.current;
      this.slots.splice(this.slots.indexOf(slot), 1);
      if (current) {
        current.cleanup();
        current.reject({ name: 'Error', message: reason, stack: '' });
      }
      this.dispatch();
    };
    worker.on('error', (err) => onDeath(`The code sandbox crashed: ${err.message}`));
    worker.on('exit', (code) => {
      if (this.slots.includes(slot)) onDeath(`The code sandbox stopped unexpectedly (exit code ${code})`);
    });
    this.slots.push(slot);
    return slot;
  }

  /** Kills a worker (stuck or aborted task) and rejects its current task with `error`. */
  private kill(slot: Slot, error: SandboxError | Error): void {
    const current = slot.current;
    slot.current = undefined;
    this.slots.splice(this.slots.indexOf(slot), 1);
    void slot.worker.terminate();
    if (current) {
      current.cleanup();
      current.reject(error);
    }
    this.dispatch();
  }

  private dispatch(): void {
    while (this.queue.length && !this.closed) {
      let slot = this.slots.find((s) => !s.current);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const pending = this.queue.shift()!;
      const { task } = pending;
      if (task.signal?.aborted) {
        pending.reject(task.signal.reason as Error);
        continue;
      }
      const target = slot;
      // Hard watchdog in case QuickJS' own interrupt does not fire (e.g. stuck inside WASM).
      const watchdog = setTimeout(
        () => this.kill(target, { name: 'InternalError', message: 'interrupted', stack: '' }),
        task.timeoutMs + 3000,
      );
      const onAbort = () => this.kill(target, task.signal!.reason as Error);
      task.signal?.addEventListener('abort', onAbort, { once: true });
      target.current = {
        ...pending,
        cleanup: () => {
          clearTimeout(watchdog);
          task.signal?.removeEventListener('abort', onAbort);
        },
      };
      target.worker.postMessage({ id: pending.id, source: task.source, timeoutMs: task.timeoutMs, memoryLimitBytes: task.memoryLimitBytes });
    }
  }
}

let shared: CodeSandbox | undefined;

export function getCodeSandbox(): CodeSandbox {
  shared ??= new CodeSandbox(2);
  return shared;
}
