import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  APP_VERSION,
  WS_PATH,
  isWsRoom,
  type ClientMessage,
  type ServerEventData,
  type ServerEvent,
  type WsRoom,
} from '@flowforge/shared';
import { userFromCookieHeader } from '../auth/session.js';
import type { AppContext } from '../context.js';

interface ClientState {
  userId: string;
  rooms: Set<WsRoom>;
  alive: boolean;
}

const HEARTBEAT_MS = 30_000;
const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * Single `/ws` endpoint. Clients authenticate with the session cookie during the upgrade,
 * then subscribe to rooms (`workflow:<id>`, `execution:<id>`) to receive live events.
 */
export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly clients = new Map<WebSocket, ClientState>();
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly ctx: AppContext) {}

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Sends an event to every client subscribed to `room`. */
  publish<T extends ServerEvent['type']>(room: WsRoom, type: T, data: ServerEventData<T>, seq?: number): void {
    const payload = JSON.stringify({ type, ts: Date.now(), seq, data });
    for (const [socket, state] of this.clients) {
      if (state.rooms.has(room) && socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  /** Sends an event to every connected client. */
  broadcast<T extends ServerEvent['type']>(type: T, data: ServerEventData<T>): void {
    const payload = JSON.stringify({ type, ts: Date.now(), data });
    for (const socket of this.clients.keys()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.clients.keys()) socket.close(1001, 'Server shutting down');
    this.clients.clear();
    this.wss.close();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const auth = userFromCookieHeader(this.ctx, req.headers.cookie);
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, auth.user.id));
  }

  private onConnection(socket: WebSocket, userId: string): void {
    const state: ClientState = { userId, rooms: new Set(), alive: true };
    this.clients.set(socket, state);
    socket.on('pong', () => (state.alive = true));
    socket.on('message', (raw) => this.onMessage(socket, state, raw.toString()));
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', (err) => this.ctx.logger.debug(`WebSocket error: ${err.message}`));
    this.send(socket, 'connection.ready', { userId, serverVersion: APP_VERSION });
  }

  private onMessage(socket: WebSocket, state: ClientState, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(socket, 'error', { message: 'Messages must be JSON.' });
      return;
    }
    switch (msg?.type) {
      case 'ping':
        this.send(socket, 'pong', {});
        return;
      case 'subscribe':
      case 'unsubscribe':
        if (!isWsRoom(msg.room)) {
          this.send(socket, 'error', { message: `Invalid room: ${String(msg.room)}` });
          return;
        }
        if (msg.type === 'subscribe') state.rooms.add(msg.room);
        else state.rooms.delete(msg.room);
        return;
      default:
        this.send(socket, 'error', { message: 'Unknown message type.' });
    }
  }

  private send<T extends ServerEvent['type']>(socket: WebSocket, type: T, data: ServerEventData<T>): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ts: Date.now(), data }));
  }

  private checkAlive(): void {
    for (const [socket, state] of this.clients) {
      if (!state.alive) {
        socket.terminate();
        this.clients.delete(socket);
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }
}
