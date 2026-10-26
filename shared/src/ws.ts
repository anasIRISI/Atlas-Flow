import type { ExecutionMode, ExecutionStatus, NodeRunStatus, SerializedError } from './workflow.js';

/** Every server → client WebSocket message uses this envelope. */
export interface WsEnvelope<TType extends string = string, TData = unknown> {
  type: TType;
  /** Server timestamp (ms since epoch). */
  ts: number;
  /** Per-execution sequence number, lets the client detect missed events. */
  seq?: number;
  data: TData;
}

export interface ExecutionRef {
  executionId: string;
  workflowId: string | null;
}

export type ServerEvent =
  | WsEnvelope<'connection.ready', { userId: string; serverVersion: string }>
  | WsEnvelope<'pong', Record<string, never>>
  | WsEnvelope<'error', { message: string }>
  | WsEnvelope<'execution.queued', ExecutionRef & { mode: ExecutionMode }>
  | WsEnvelope<'execution.started', ExecutionRef & { mode: ExecutionMode; startedAt: string }>
  | WsEnvelope<'node.started', ExecutionRef & { nodeName: string; runIndex: number }>
  | WsEnvelope<
      'node.finished',
      ExecutionRef & {
        nodeName: string;
        runIndex: number;
        status: NodeRunStatus;
        executionTime: number;
        /** Number of items on each output. */
        itemCounts: number[];
        /** First items of the first non-empty output (JSON only, capped at ~2 KB). */
        preview: unknown[];
        error?: SerializedError;
      }
    >
  | WsEnvelope<
      'edge.data',
      ExecutionRef & { from: { node: string; output: number }; to: { node: string; input: number }; itemCount: number }
    >
  | WsEnvelope<
      'execution.waiting',
      ExecutionRef & { nodeName: string; waitTill: string | null; kind: 'time' | 'webhook' | 'form'; resumeUrl: string }
    >
  | WsEnvelope<'workflow.activated', { workflowId: string }>
  | WsEnvelope<'workflow.deactivated', { workflowId: string }>
  | WsEnvelope<'workflow.activationError', { workflowId: string; message: string; runtime: boolean }>
  | WsEnvelope<'trigger.listening', { workflowId: string; nodeName: string; testUrl?: string; method?: string; expiresAt: string }>
  | WsEnvelope<'trigger.received', { workflowId: string; nodeName: string; executionId: string }>
  | WsEnvelope<'trigger.stopped', { workflowId: string; nodeName: string; reason: 'timeout' | 'canceled' | 'error'; message?: string }>
  | WsEnvelope<
      'execution.finished',
      ExecutionRef & {
        status: ExecutionStatus;
        startedAt: string;
        stoppedAt: string;
        lastNodeExecuted: string | null;
        error?: SerializedError;
      }
    >;

export type ServerEventType = ServerEvent['type'];

/** Payload type of a given server event. */
export type ServerEventData<T extends ServerEventType> = Extract<ServerEvent, { type: T }>['data'];

export type WsRoom = `workflow:${string}` | `execution:${string}`;

export type ClientMessage =
  | { type: 'ping' }
  | { type: 'subscribe'; room: WsRoom }
  | { type: 'unsubscribe'; room: WsRoom };

export function isWsRoom(value: unknown): value is WsRoom {
  return typeof value === 'string' && /^(workflow|execution):[\w-]{1,64}$/.test(value);
}
