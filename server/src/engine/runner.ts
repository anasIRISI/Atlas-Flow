import type {
  ExecutionMode,
  Item,
  JsonObject,
  NodeRun,
  NodeRunStatus,
  PairedItem,
  RunData,
  SerializedError,
  TaskSource,
  WorkflowData,
  WorkflowNode,
} from '@flowforge/shared';
import type { Logger } from '../logger.js';
import type { NodeRegistry } from '../nodes/registry.js';
import type { BinaryStore } from './binary-store.js';
import {
  ExecutionCanceledError,
  ExecutionTimeoutError,
  FlowError,
  MissingCredentialError,
  NodeOperationError,
  WaitSignal,
  WorkflowOperationError,
  serializeError,
  toFlowError,
} from './errors.js';
import type { ExpressionEngine } from './expressions/engine.js';
import { WorkflowGraph } from './graph.js';
import { NodeExecutionContext, type ExecutionServices, type NodeContextOptions } from './node-context.js';
import type { AiChatModel, AiConnectionType, AiMemory, AiTool, ChatMemoryStore, ChatTurn, CredentialsProvider, NodeType, SuppliedData } from './types.js';

export interface RunHooks {
  nodeStarted?(nodeName: string, runIndex: number): void;
  nodeFinished?(nodeName: string, runIndex: number, run: NodeRun): void;
  edgeData?(from: { node: string; output: number }, to: { node: string; input: number }, itemCount: number): void;
}

export interface RunRequest {
  workflow: WorkflowData;
  executionId: string;
  mode: ExecutionMode;
  /** Trigger to start from (default: the only trigger, or the Manual Trigger in manual mode). */
  startNode?: string;
  /** Items emitted by the start node instead of executing it (webhook payload, schedule tick…). */
  triggerItems?: Item[];
  /** Partial run ("execute step"): run only what this node needs and stop after it. */
  destinationNode?: string;
  /** Partial run: data from the previous run, reused for nodes whose inputs did not change. */
  previousRunData?: RunData;
  /**
   * Retry: run the whole workflow, but every node that has data in `previousRunData` (and nothing fresh upstream)
   * reuses it instead of executing again. The first node without data runs, and everything after it runs fresh.
   */
  reuseRunData?: boolean;
  /**
   * Demo Mode: a node that throws MissingCredentialError returns simulated output instead. Set ONLY by the demo
   * routes (never read from workflow JSON or request bodies).
   */
  demo?: boolean;
  /** Continue a paused execution: its saved state and the output of the node that waited. */
  resume?: { state: EngineState; output: Item[] };
  signal?: AbortSignal;
  timeoutMs?: number;
  maxNodeRuns?: number;
  hooks?: RunHooks;
  timezone?: string;
  variables?: Record<string, string>;
  env?: Record<string, string> | null;
  /** Webhook responses, sub-workflows, resume URLs. */
  services?: ExecutionServices;
}

export interface RunResult {
  status: 'success' | 'error' | 'canceled' | 'waiting';
  runData: RunData;
  error?: SerializedError;
  lastNodeExecuted: string | null;
  /** Set when status is "waiting": what to store so the execution can be resumed later. */
  wait?: { state: EngineState; till: Date | null; kind: 'time' | 'webhook' | 'form'; node: string };
}

export interface RunnerDeps {
  registry: NodeRegistry;
  expressions: ExpressionEngine;
  binaryStore: BinaryStore;
  logger: Logger;
  defaults: { timeoutMs: number; maxNodeRuns: number; timezone: string };
  /** Credential lookup for integration nodes (absent in plain engine tests). */
  credentials?: CredentialsProvider;
  /** Folder of the file nodes (./data/files). */
  filesRoot?: string;
  /** Switches of the Settings page (e.g. Execute Command). */
  instanceSettings?: { get(key: string): unknown };
  /** Chat sessions (absent in plain engine tests: memory then lives only for the lifetime of the runner). */
  chatMemory?: ChatMemoryStore;
}

interface Task {
  node: string;
  inputs: Item[][];
  sources: (TaskSource | null)[];
  triggerItems?: Item[];
  /** True when something upstream was (re)executed in this run, so stored data must not be reused. */
  fresh: boolean;
}

interface Waiting {
  node: string;
  inputs: (Item[] | null)[];
  sources: (TaskSource | null)[];
  fresh: boolean;
}

/** Everything needed to continue an execution later — plain JSON, stored while the execution waits. */
export interface EngineState {
  version: 1;
  runData: RunData;
  stack: Task[];
  waiting: Waiting[];
  nodeState: Record<string, object>;
  totalRuns: number;
  lastNode: string | null;
  allowed: string[] | null;
  pendingWait?: { task: Task; nodeName: string; startTime: number };
}

/** Thrown to end the execution after a node failed with "On Error: Stop Workflow". */
class StopExecution extends Error {
  constructor(readonly error: FlowError) {
    super(error.message);
  }
}

const MANUAL_TRIGGER = 'flowforge.manualTrigger';

/** Fallback store when no database is attached (engine tests). */
function inMemoryChatStore(): ChatMemoryStore {
  const sessions = new Map<string, ChatTurn[]>();
  return {
    load: (key, limit) => (limit > 0 ? (sessions.get(key) ?? []).slice(-limit) : []),
    append: (key, turns) => void sessions.set(key, [...(sessions.get(key) ?? []), ...turns]),
    clear: (key) => void sessions.delete(key),
  };
}

function raceAbort<T>(work: () => Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return raceAbort(() => new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function normalizeItems(list: unknown, nodeName: string): Item[] {
  if (!Array.isArray(list)) throw new NodeOperationError(`Node "${nodeName}" returned invalid output (expected a list of items)`);
  return list.map((item, i) => {
    const candidate = item as Item;
    if (!candidate || typeof candidate.json !== 'object' || candidate.json === null || Array.isArray(candidate.json)) {
      throw new NodeOperationError(`Node "${nodeName}" returned an invalid item at index ${i}`, {
        hint: 'Every item must look like { json: { … } }.',
      });
    }
    return candidate;
  });
}

/** Links every output item to the input item it came from (powers `$('Node').item`). */
function assignPairedItems(outputs: Item[][], inputs: Item[][]): Item[][] {
  const origin = new Map<Item, PairedItem>();
  inputs.forEach((list, input) =>
    list.forEach((item, index) => {
      if (!origin.has(item)) origin.set(item, input === 0 ? { item: index } : { item: index, input });
    }),
  );
  const total = inputs.reduce((n, list) => n + list.length, 0);
  const onlyInput = inputs.findIndex((list) => list.length > 0);
  return outputs.map((list) =>
    list.map((item, j) => {
      const from = origin.get(item);
      if (from) return { ...item, pairedItem: from };
      if (item.pairedItem !== undefined) return item;
      if (total === 1) return { ...item, pairedItem: onlyInput > 0 ? { item: 0, input: onlyInput } : { item: 0 } };
      if (inputs.length === 1 && list.length === inputs[0]!.length) return { ...item, pairedItem: { item: j } };
      return item;
    }),
  );
}

interface Live {
  state: EngineState;
  nodeState: Map<string, object>;
  signal: AbortSignal;
}

/**
 * Executes a workflow: items flow through main connections, node by node.
 * Order follows n8n v1: depth-first, one branch finished before the next, branches top-to-bottom.
 * A Wait node can pause the run: the state is returned and `run({ resume })` continues it later.
 */
export class WorkflowRunner {
  private readonly chatMemory: ChatMemoryStore;

  constructor(private readonly deps: RunnerDeps) {
    this.chatMemory = deps.chatMemory ?? inMemoryChatStore();
  }

  async run(req: RunRequest): Promise<RunResult> {
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? this.deps.defaults.timeoutMs;
    const timer =
      timeoutMs > 0
        ? setTimeout(
            () =>
              controller.abort(
                new ExecutionTimeoutError(`Execution timed out after ${Math.round(timeoutMs / 100) / 10} s`, {
                  hint: 'Increase the timeout in the workflow settings, or make the slow node faster.',
                }),
              ),
            timeoutMs,
          )
        : undefined;
    const onExternalAbort = () => controller.abort(new ExecutionCanceledError('Execution was stopped'));
    if (req.signal?.aborted) onExternalAbort();
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let live: Live | undefined;
    try {
      const graph = new WorkflowGraph(req.workflow);
      for (const node of graph.nodes.values()) this.deps.registry.require(node.type);
      if (req.resume) {
        const state = structuredClone(req.resume.state);
        live = { state, nodeState: new Map(Object.entries(state.nodeState)), signal: controller.signal };
        this.completeWait(req, graph, live, req.resume.output);
      } else {
        const { tasks, allowed } = this.plan(req, graph);
        const state: EngineState = {
          version: 1,
          runData: {},
          stack: [...tasks].reverse(),
          waiting: [],
          nodeState: {},
          totalRuns: 0,
          lastNode: null,
          allowed: allowed ? [...allowed] : null,
        };
        live = { state, nodeState: new Map(), signal: controller.signal };
      }
      return await this.loop(req, graph, live);
    } catch (err) {
      const runData = live?.state.runData ?? {};
      const lastNodeExecuted = live?.state.lastNode ?? null;
      if (err instanceof StopExecution) return { status: 'error', runData, error: serializeError(err.error), lastNodeExecuted };
      const error = err instanceof FlowError ? err : toFlowError(err, lastNodeExecuted ?? 'workflow');
      return {
        status: err instanceof ExecutionCanceledError ? 'canceled' : 'error',
        runData,
        error: serializeError(error),
        lastNodeExecuted,
      };
    } finally {
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async loop(req: RunRequest, graph: WorkflowGraph, live: Live): Promise<RunResult> {
    const { state } = live;
    const allowed = state.allowed ? new Set(state.allowed) : null;
    const maxRuns = req.maxNodeRuns ?? this.deps.defaults.maxNodeRuns;
    while (true) {
      if (live.signal.aborted) throw live.signal.reason;
      let task = state.stack.pop();
      if (!task) {
        // Nothing runnable left: run the oldest node that is still waiting for one of its inputs.
        const next = state.waiting.shift();
        if (!next) break;
        task = { node: next.node, inputs: next.inputs.map((i) => i ?? []), sources: next.sources, fresh: next.fresh };
      }
      if (++state.totalRuns > maxRuns) {
        throw new WorkflowOperationError(`Stopped after ${maxRuns} node executions`, {
          hint: 'The workflow probably loops forever. Check the conditions that end your loop.',
        });
      }
      const node = graph.node(task.node);
      state.lastNode = node.name; // set before running, so a failing node is reported as the last one
      let result: { outputs: Item[][]; status: NodeRunStatus };
      try {
        result = await this.runNode(req, node, task, live);
      } catch (err) {
        if (!(err instanceof WaitSignal)) throw err;
        state.pendingWait = { task, nodeName: node.name, startTime: Date.now() };
        state.nodeState = Object.fromEntries(live.nodeState);
        return {
          status: 'waiting',
          runData: state.runData,
          lastNodeExecuted: node.name,
          wait: { state, till: err.resumeAt, kind: err.kind, node: node.name },
        };
      }
      if (req.destinationNode === node.name) continue;
      this.deliver(req, graph, node, result.outputs, result.status, task, state, allowed);
    }
    return { status: 'success', runData: state.runData, lastNodeExecuted: state.lastNode };
  }

  /** Records the output of the node that was waiting and sends it on. */
  private completeWait(req: RunRequest, graph: WorkflowGraph, live: Live, output: Item[]) {
    const { state } = live;
    const pending = state.pendingWait;
    if (!pending) throw new WorkflowOperationError('This execution is not waiting');
    delete state.pendingWait;
    const node = graph.node(pending.nodeName);
    const runIndex = state.runData[node.name]?.length ?? 0;
    const outputs = assignPairedItems([output], pending.task.inputs);
    const run: NodeRun = {
      startTime: pending.startTime,
      executionTime: Date.now() - pending.startTime,
      status: 'success',
      source: pending.task.sources,
      data: { main: outputs },
    };
    (state.runData[node.name] ??= []).push(run);
    state.lastNode = node.name;
    req.hooks?.nodeFinished?.(node.name, runIndex, run);
    if (req.destinationNode !== node.name) {
      this.deliver(req, graph, node, outputs, 'success', pending.task, state, state.allowed ? new Set(state.allowed) : null);
    }
  }

  private isTrigger(type: NodeType): boolean {
    return type.description.group === 'trigger' || type.description.trigger !== undefined;
  }

  /** Decides where execution starts and which nodes may run. */
  private plan(req: RunRequest, graph: WorkflowGraph): { tasks: Task[]; allowed: Set<string> | null } {
    const { registry } = this.deps;
    if (req.destinationNode) {
      const allowed = graph.ancestorsOf(graph.node(req.destinationNode).name);
      const roots = [...allowed]
        .filter((name) => graph.parents(name).every((p) => !allowed.has(p)))
        .sort((a, b) => this.compare(graph, a, b));
      const tasks = roots.map<Task>((name) => {
        const isTrigger = this.isTrigger(registry.require(graph.node(name).type));
        const triggerItems = name === req.startNode ? req.triggerItems : undefined;
        // A node without a trigger in front of it starts with one empty item (like n8n's "execute step").
        return isTrigger
          ? { node: name, inputs: [], sources: [], fresh: Boolean(triggerItems), ...(triggerItems ? { triggerItems } : {}) }
          : { node: name, inputs: [[{ json: {} }]], sources: [null], fresh: false };
      });
      return { tasks, allowed };
    }

    let start: WorkflowNode;
    if (req.startNode) {
      start = graph.node(req.startNode);
    } else {
      const triggers = [...graph.nodes.values()].filter((n) => this.isTrigger(registry.require(n.type)));
      if (triggers.length === 0) {
        throw new WorkflowOperationError('This workflow has no trigger node', {
          hint: 'Add a "Manual Trigger" (or another trigger) and connect it to the first node.',
        });
      }
      const manual = triggers.filter((t) => t.type === MANUAL_TRIGGER);
      if (triggers.length === 1) start = triggers[0]!;
      else if (req.mode === 'manual' && manual.length === 1) start = manual[0]!;
      else {
        throw new WorkflowOperationError('This workflow has several triggers', {
          hint: 'Choose which trigger to start from.',
        });
      }
    }
    if (start.disabled) {
      throw new WorkflowOperationError(`The start node "${start.name}" is disabled`, { hint: 'Enable it to run the workflow.' });
    }
    const fresh = !req.reuseRunData || Boolean(req.triggerItems);
    return { tasks: [{ node: start.name, inputs: [], sources: [], triggerItems: req.triggerItems, fresh }], allowed: null };
  }

  private compare(graph: WorkflowGraph, a: string, b: string): number {
    const [ay, ax] = graph.position(a);
    const [by, bx] = graph.position(b);
    return ay - by || ax - bx;
  }

  private async runNode(req: RunRequest, node: WorkflowNode, task: Task, live: Live): Promise<{ outputs: Item[][]; status: NodeRunStatus }> {
    const { registry, logger } = this.deps;
    const { runData } = live.state;
    const type = registry.require(node.type);
    const runIndex = runData[node.name]?.length ?? 0;
    req.hooks?.nodeStarted?.(node.name, runIndex);
    const startTime = Date.now();
    const specs = registry.outputsFor(node);
    const hasErrorOutput = node.onError === 'continueErrorOutput' && !this.isTrigger(type);
    const regularCount = hasErrorOutput ? specs.length - 1 : specs.length;
    const previous = req.previousRunData?.[node.name];
    const pinned = req.mode === 'manual' ? req.workflow.pinData?.[node.name] : undefined;

    let outputs: Item[][];
    let status: NodeRunStatus = 'success';
    let error: FlowError | undefined;
    let logs: string[] | undefined;
    let simulated = false;
    const finish = () => {
      const run: NodeRun = { startTime, executionTime: Date.now() - startTime, status, source: task.sources, data: { main: outputs } };
      if (error) run.error = serializeError(error, node.name);
      if (logs?.length) run.logs = logs;
      if (simulated) run.simulated = true;
      (runData[node.name] ??= []).push(run);
      req.hooks?.nodeFinished?.(node.name, runIndex, run);
    };

    try {
      if (task.triggerItems) {
        outputs = [normalizeItems(task.triggerItems, node.name)];
      } else if (node.disabled) {
        outputs = [task.inputs[0] ?? []];
        status = 'disabled';
      } else if (pinned) {
        outputs = [normalizeItems(pinned.map((i) => ('json' in (i as object) ? i : { json: i as unknown as Item['json'] })), node.name)];
        status = 'pinned';
      } else if (((req.destinationNode && node.name !== req.destinationNode) || req.reuseRunData) && !task.fresh && previous?.length) {
        outputs = previous[previous.length - 1]!.data.main.map((list) => [...list]);
        status = 'reused';
      } else {
        const result = await this.execute(req, node, type, task, live, runIndex, regularCount);
        outputs = result.outputs;
        logs = result.logs;
        simulated = result.simulated === true;
        if (result.error) {
          error = result.error;
          status = 'error';
        }
        if (hasErrorOutput) outputs.push(result.errorItems);
      }
      while (outputs.length < specs.length) outputs.push([]);
      if (status !== 'reused' && status !== 'pinned' && !task.triggerItems) outputs = assignPairedItems(outputs, task.inputs);
      finish();
      return { outputs, status };
    } catch (err) {
      if (err instanceof WaitSignal) throw err;
      outputs = [];
      status = 'error';
      if (err instanceof StopExecution) {
        error = err.error;
        logs = (err as StopExecution & { logs?: string[] }).logs;
        finish();
        throw err;
      }
      error = err instanceof FlowError ? err : toFlowError(err, node.name);
      error.node ??= node.name;
      finish();
      logger.debug(`Node "${node.name}" stopped the execution: ${error.message}`);
      throw err instanceof ExecutionCanceledError || err instanceof ExecutionTimeoutError ? err : new StopExecution(error);
    }
  }

  /**
   * Cluster nodes: asks every sub-node attached to the `connection` slot of `parent` for what it supplies
   * (left to right on the canvas). The returned objects record each use as a run of the sub-node, so the
   * editor shows what the model, the memory and the tools did.
   */
  private async supply(
    req: RunRequest,
    parent: WorkflowNode,
    connection: AiConnectionType,
    itemIndex: number,
    live: Live,
    contextFor: (sub: WorkflowNode, type: NodeType) => NodeExecutionContext,
  ): Promise<SuppliedData[]> {
    const attached: WorkflowNode[] = [];
    for (const sub of req.workflow.nodes) {
      const targets = (req.workflow.connections[sub.name]?.[connection] ?? []).flat();
      if (!sub.disabled && targets.some((t) => t?.node === parent.name)) attached.push(sub);
    }
    attached.sort((a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1]);

    const out: SuppliedData[] = [];
    for (const sub of attached) {
      const type = this.deps.registry.require(sub.type);
      if (!type.supplyData || !type.description.outputs.some((o) => o.type === connection)) {
        throw new NodeOperationError(`"${sub.name}" cannot be attached to this slot of "${parent.name}"`, { hint: 'Remove the connection and attach a node made for this slot.' });
      }
      let data: SuppliedData;
      try {
        data = await type.supplyData(contextFor(sub, type), itemIndex);
      } catch (err) {
        // A misconfigured sub-node (missing credential, empty parameter…) is shown on that sub-node.
        const error = err instanceof FlowError ? err : toFlowError(err, sub.name);
        error.node ??= sub.name;
        this.recordAiRun(req, live, sub, parent, Date.now(), {}, error);
        throw error;
      }
      out.push(this.recorded(req, live, sub, parent, connection, data));
    }
    return out;
  }

  private recordAiRun(req: RunRequest, live: Live, sub: WorkflowNode, parent: WorkflowNode, startTime: number, json: JsonObject, error?: FlowError) {
    const { runData } = live.state;
    const runIndex = runData[sub.name]?.length ?? 0;
    const run: NodeRun = {
      startTime,
      executionTime: Date.now() - startTime,
      status: error ? 'error' : 'success',
      source: [{ previousNode: parent.name, previousNodeOutput: 0, previousNodeRun: runData[parent.name]?.length ?? 0 }],
      data: { main: [error ? [] : [{ json }]] },
    };
    if (error) run.error = serializeError(error, sub.name);
    (runData[sub.name] ??= []).push(run);
    req.hooks?.nodeFinished?.(sub.name, runIndex, run);
  }

  /** Wraps what a sub-node supplies so that every call becomes a visible run of that sub-node. */
  private recorded(req: RunRequest, live: Live, sub: WorkflowNode, parent: WorkflowNode, connection: AiConnectionType, data: SuppliedData): SuppliedData {
    const track = async <T>(work: () => Promise<T> | T, describe: (result: T) => JsonObject): Promise<T> => {
      req.hooks?.nodeStarted?.(sub.name, live.state.runData[sub.name]?.length ?? 0);
      const startTime = Date.now();
      try {
        const result = await work();
        this.recordAiRun(req, live, sub, parent, startTime, describe(result));
        return result;
      } catch (err) {
        if (live.signal.aborted) throw live.signal.reason;
        const error = err instanceof FlowError ? err : toFlowError(err, sub.name);
        this.recordAiRun(req, live, sub, parent, startTime, {}, error);
        throw err;
      }
    };
    const trackSync = <T>(work: () => T, describe: (result: T) => JsonObject): T => {
      req.hooks?.nodeStarted?.(sub.name, live.state.runData[sub.name]?.length ?? 0);
      const startTime = Date.now();
      try {
        const result = work();
        this.recordAiRun(req, live, sub, parent, startTime, describe(result));
        return result;
      } catch (err) {
        this.recordAiRun(req, live, sub, parent, startTime, {}, err instanceof FlowError ? err : toFlowError(err, sub.name));
        throw err;
      }
    };
    const plain = (value: unknown): JsonObject[string] => (value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JsonObject[string]));

    if (connection === 'ai_tool') {
      const tool = data as AiTool;
      return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        invoke: (args, o) => track(() => tool.invoke(args, o), (output) => ({ tool: tool.name, input: plain(args), output: plain(output) })),
      };
    }
    if (connection === 'ai_memory') {
      const memory = data as AiMemory;
      return {
        sessionId: memory.sessionId,
        load: () => trackSync(() => memory.load(), (messages) => ({ action: 'load', sessionId: memory.sessionId, messages: plain(messages) })),
        save: (turns) => trackSync(() => memory.save(turns), () => ({ action: 'save', sessionId: memory.sessionId, messages: plain(turns) })),
        clear: () => trackSync(() => memory.clear(), () => ({ action: 'clear', sessionId: memory.sessionId })),
      };
    }
    const model = data as AiChatModel;
    return {
      provider: model.provider,
      model: model.model,
      generate: (request, o) =>
        track(
          () => model.generate(request, o),
          (turn) => ({
            model: turn.model,
            messages: request.messages.length,
            tools: (request.tools ?? []).map((t) => t.name),
            response: { text: turn.text, toolCalls: plain(turn.toolCalls), finishReason: turn.finishReason },
            usage: turn.usage,
          }),
        ),
    };
  }

  /** Demo Mode: the node's input items marked `_simulated: true` (+ the node's own made-up fields). */
  private simulateOutputs(type: NodeType, ctx: NodeExecutionContext, inputs: Item[][], regularCount: number): Item[][] {
    const source = inputs[0]?.length ? inputs[0] : [{ json: {} } as Item];
    const out: Item[][] = Array.from({ length: Math.max(regularCount, 1) }, () => []);
    out[0] = source.map((item, i) => {
      let extra: JsonObject = {};
      try {
        extra = type.simulate?.(ctx, item, i) ?? {};
      } catch {
        extra = {};
      }
      return { json: { ...item.json, ...extra, _simulated: true }, pairedItem: { item: i } };
    });
    return out;
  }

  /** Runs the node's code with retries and the "On Error" setting applied. */
  private async execute(
    req: RunRequest,
    node: WorkflowNode,
    type: NodeType,
    task: Task,
    live: Live,
    runIndex: number,
    regularCount: number,
  ): Promise<{ outputs: Item[][]; errorItems: Item[]; logs: string[]; error?: FlowError; simulated?: boolean }> {
    if (!type.execute) return { outputs: [], errorItems: [], logs: [] };
    const inputs = node.executeOnce ? task.inputs.map((list) => list.slice(0, 1)) : task.inputs;
    const tries = node.retryOnFail ? clamp(node.maxTries ?? 3, 1, 5) : 1;
    const wait = clamp(node.waitBetweenTries ?? 1000, 0, 5000);
    let lastError: unknown;
    let lastLogs: string[] = [];
    const { signal } = live;

    for (let attempt = 1; attempt <= tries; attempt++) {
      const options = (target: WorkflowNode, targetType: NodeType, targetRunIndex: number): NodeContextOptions => ({
        node: target,
        type: targetType,
        workflow: req.workflow,
        mode: req.mode,
        executionId: req.executionId,
        runIndex: targetRunIndex,
        inputs,
        sources: task.sources,
        runData: live.state.runData,
        nodeState: live.nodeState,
        signal,
        logger: this.deps.logger,
        expressions: this.deps.expressions,
        binaryStore: this.deps.binaryStore,
        timezone: req.timezone ?? req.workflow.settings?.timezone ?? this.deps.defaults.timezone,
        variables: req.variables ?? {},
        env: req.env === undefined ? null : req.env,
        services: req.services,
        credentials: this.deps.credentials,
        filesRoot: this.deps.filesRoot,
        instanceSettings: this.deps.instanceSettings,
        chatMemory: this.chatMemory,
        demo: req.demo === true,
      });
      const ctx = new NodeExecutionContext({
        ...options(node, type, runIndex),
        // Sub-nodes see the same input items as their parent, so their expressions resolve like the parent's.
        supply: (connection, itemIndex) => this.supply(req, node, connection, itemIndex, live, (sub, subType) => new NodeExecutionContext(options(sub, subType, live.state.runData[sub.name]?.length ?? 0))),
      });
      try {
        const raw = await raceAbort(() => type.execute!(ctx), signal);
        if (!Array.isArray(raw)) throw new NodeOperationError(`Node "${node.name}" returned invalid output`);
        const outputs: Item[][] = [];
        for (let i = 0; i < regularCount; i++) outputs.push(normalizeItems(raw[i] ?? [], node.name));
        if (node.alwaysOutputData && outputs.every((list) => list.length === 0) && regularCount > 0) {
          outputs[0] = [{ json: {}, ...(inputs[0]?.length ? { pairedItem: { item: 0 } } : {}) }];
        }
        return { outputs, errorItems: ctx.errorItems, logs: ctx.logs };
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        if (err instanceof WaitSignal) throw err;
        // Demo Mode only, and only for a missing credential: every other error stays an error.
        if (req.demo === true && err instanceof MissingCredentialError) {
          return { outputs: this.simulateOutputs(type, ctx, inputs, regularCount), errorItems: [], logs: ctx.logs, simulated: true };
        }
        lastError = err;
        lastLogs = ctx.logs;
        if (attempt < tries) {
          this.deps.logger.debug(`Node "${node.name}" failed (attempt ${attempt}/${tries}), retrying in ${wait} ms`);
          await sleep(wait, signal);
        }
      }
    }

    const error = toFlowError(lastError, node.name);
    const empty = () => Array.from({ length: regularCount }, () => [] as Item[]);
    switch (node.onError) {
      case 'continueRegularOutput': {
        const outputs = empty();
        if (regularCount > 0) outputs[0] = [{ json: { error: error.message }, pairedItem: { item: 0 } }];
        return { outputs, errorItems: [], logs: lastLogs, error };
      }
      case 'continueErrorOutput': {
        const source = inputs[0]?.length ? inputs[0] : [{ json: {} }];
        const errorItems = source.map<Item>((item, i) => ({ ...item, json: { ...item.json, error: error.message }, pairedItem: { item: i } }));
        return { outputs: empty(), errorItems, logs: lastLogs, error };
      }
      default: {
        const stop = new StopExecution(error) as StopExecution & { logs?: string[] };
        stop.logs = lastLogs;
        throw stop;
      }
    }
  }

  /** Sends a finished node's output items along its connections. */
  private deliver(
    req: RunRequest,
    graph: WorkflowGraph,
    node: WorkflowNode,
    outputs: Item[][],
    status: NodeRunStatus,
    task: Task,
    state: EngineState,
    allowed: Set<string> | null,
  ): void {
    const runIndex = state.runData[node.name]!.length - 1;
    const fresh = task.fresh || (status !== 'reused' && status !== 'pinned');
    const deliveries: Array<{ output: number; target: string; input: number; items: Item[] }> = [];
    (req.workflow.connections[node.name]?.main ?? []).forEach((targets, output) => {
      const items = outputs[output];
      if (!items?.length) return;
      for (const t of targets ?? []) {
        if (allowed && !allowed.has(t.node)) continue;
        deliveries.push({ output, target: t.node, input: t.index ?? 0, items });
      }
    });
    deliveries.sort((a, b) => this.compare(graph, a.target, b.target) || a.output - b.output);

    const ready: Task[] = [];
    for (const d of deliveries) {
      req.hooks?.edgeData?.({ node: node.name, output: d.output }, { node: d.target, input: d.input }, d.items.length);
      const source: TaskSource = { previousNode: node.name, previousNodeOutput: d.output, previousNodeRun: runIndex };
      const target = graph.node(d.target);
      const inputCount = this.deps.registry.inputsFor(target).length;
      if (inputCount <= 1) {
        ready.push({ node: d.target, inputs: [d.items], sources: [source], fresh });
        continue;
      }
      let entry = state.waiting.find((w) => w.node === d.target && w.inputs[d.input] === null);
      if (!entry) {
        entry = { node: d.target, inputs: Array(inputCount).fill(null), sources: Array(inputCount).fill(null), fresh: false };
        state.waiting.push(entry);
      }
      entry.inputs[d.input] = d.items;
      entry.sources[d.input] = source;
      entry.fresh ||= fresh;
      if (entry.inputs.every((i) => i !== null)) {
        state.waiting.splice(state.waiting.indexOf(entry), 1);
        ready.push({ node: entry.node, inputs: entry.inputs as Item[][], sources: entry.sources, fresh: entry.fresh });
      }
    }
    // LIFO stack: push in reverse so the top-most branch runs first and completely.
    for (let i = ready.length - 1; i >= 0; i--) state.stack.push(ready[i]!);
  }
}
